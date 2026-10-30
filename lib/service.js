/**
 * 面板快照：档案库 + 团队状态 + 配置体检，一次给前端。
 *
 * 与 `lib/library.js` 的分工：那一层只投影档案（纯文件扫描，工具也在用），
 * 这一层是"面板视角"——把团队状态、部署情况、配置提示折叠进同一个响应，
 * 让前端不用发三次请求、也不用自己判断"这份档案到底有没有进运行时"。
 *
 * 提示一律用 **code + params** 表达，不出中文/英文散文：文案由客户端词典渲染，
 * 这样同一份快照能同时喂给中文和英文界面，也让快照本身可被工具与测试断言。
 *
 * @module dsh-agent-roster/service
 */
import nodePath from "node:path";

import { globalRosterRoot } from "./home.js";
import { readDeployedCaptains, verifyCaptain } from "./captain.js";
import { collectLibrary, listWorkspaces } from "./library.js";
import { CACHE_DIR_NAME, fetchCollection, loadRegistryIndex } from "./remote.js";
import { rosterDocumentText } from "./serialize.js";
import { readTeamStates, resolveStateDir } from "./teams-state.js";
import { listLibraryRoots, readRosterDocument, writeRosterDocument } from "./write.js";

/** 会参与"档案值 vs 运行时值"比对的字段。 */
const COMPARED_FIELDS = ["provider", "model", "reasoningEffort", "toolPolicy"];

/**
 * 本轮允许写的档案库根目录（配置里的目录；全局目录与工作区无关）。
 *
 * @param {{ get?: (key: string) => unknown }} ctx
 * @param {object} config
 * @returns {object[]}
 */
export function resolveRoots(ctx, config) {
  return listLibraryRoots({
    rosterDirs: Array.isArray(config.rosterDirs) ? config.rosterDirs : [],
    workspaces: listWorkspaces(ctx).map((workspace) => ({ path: workspace.path })),
  });
}

/**
 * 组装面板快照。
 *
 * @param {{ get?: (key: string) => unknown }} ctx 宿主上下文（只用到工作区注册表）
 * @param {object} config 插件配置（已解引用）
 * @param {{ name: string, version: string }} meta 插件自身元信息
 * @param {{ now?: () => Date }} [options] 便于测试固定时间
 * @returns {object}
 */
export function buildPanelSnapshot(ctx, config, meta, options = {}) {
  const library = collectLibrary(ctx, config, meta);
  const now = options.now ?? (() => new Date());

  const roots = listLibraryRoots({
    rosterDirs: library.rosterDirs,
    workspaces: library.workspaces.map((workspace) => ({ path: workspace.workspacePath })),
  });

  const rosters = [];
  for (const workspace of library.workspaces) {
    const rootExists = roots.find((root) => root.rootDir === workspace.rootDir)?.exists ?? false;
    workspace.rootExists = rootExists;
    // 面板要能"照着这份档案去写文件"，所以把所在的库根目录一并带给前端；
    // 客户端传回来的 rootDir 仍会被 listLibraryRoots 白名单校验，不是信任输入。
    for (const roster of workspace.rosters) {
      rosters.push({ ...roster, rootDir: workspace.rootDir, workspacePath: workspace.workspacePath });
    }
  }

  const teams = projectTeams({ spec: config.agentTeamsStateDir, workspaces: library.workspaces, rosters });

  const diagnostics = [
    ...library.workspaces.flatMap((workspace) => workspace.diagnostics),
    ...teams.diagnostics,
  ];

  const hints = buildHints({ library, roots, rosters, teams, config });
  const deployments = countDeployments(rosters, teams.teams);
  const captain = buildCaptainSection(rosters, options);

  return {
    plugin: meta.name,
    version: meta.version,
    generatedAt: now().toISOString(),
    config: {
      rosterDirs: library.rosterDirs,
      dshHome: library.dshHome,
      defaultRoot: globalRosterRoot(),
      knownToolPolicies: Array.isArray(config.knownToolPolicies) ? config.knownToolPolicies : [],
      stateDirSpec: config.agentTeamsStateDir,
    },
    workspaces: library.workspaces,
    teams,
    deployments,
    captain,
    hints,
    summary: {
      rosters: rosters.length,
      members: rosters.reduce((total, roster) => total + roster.members.length, 0),
      teams: teams.teams.length,
      errors: diagnostics.filter((item) => item.severity === "error").length,
      warnings: diagnostics.filter((item) => item.severity === "warn").length,
    },
  };
}

/**
 * 读团队状态并投影成面板能安全渲染的形状。
 *
 * 成员的人设正文不外发（只给字数）：面板要的是"谁在队里、模型对不对、是否来自档案"，
 * 不是把别人的 system prompt 摊在界面上。
 *
 * @param {{ spec: string, workspaces: object[], rosters: object[] }} input
 * @returns {object}
 */
export function projectTeams(input) {
  const specs = new Set();
  const teams = [];
  const diagnostics = [];
  let available = false;
  let stateDir = "";

  for (const workspace of input.workspaces) {
    const abs = resolveStateDir(input.spec, workspace.workspacePath);
    if (stateDir === "") stateDir = abs;
    if (specs.has(abs)) continue;
    specs.add(abs);

    const read = readTeamStates({ stateDir: abs });
    available = available || read.available;
    diagnostics.push(...read.diagnostics);
    const rosterIndex = indexRosterMembers(input.rosters);
    for (const team of read.teams) {
      teams.push(projectTeam(team, rosterIndex));
    }
  }

  return { stateDirSpec: input.spec, stateDir, available, teams, diagnostics };
}

/**
 * 单个团队的投影。
 *
 * @param {object} team `readTeamStates` 的团队记录
 * @param {Map<string, object>} rosterIndex 成员名 → 档案成员
 * @returns {object}
 */
function projectTeam(team, rosterIndex) {
  const members = team.members.map((member) => {
    const name = typeof member.name === "string" ? member.name : "";
    const managed = rosterIndex.get(name) ?? null;
    const drift = [];
    if (managed !== null) {
      for (const field of COMPARED_FIELDS) {
        const wanted = managed.member[field];
        const actual = member[field];
        if (typeof wanted === "string" && wanted !== "" && typeof actual === "string" && actual !== "" && wanted !== actual) {
          drift.push({ field, roster: wanted, runtime: actual });
        }
      }
    }
    return {
      name,
      role: typeof member.role === "string" ? member.role : "",
      provider: typeof member.provider === "string" ? member.provider : "",
      model: typeof member.model === "string" ? member.model : "",
      reasoningEffort: typeof member.reasoningEffort === "string" ? member.reasoningEffort : "",
      toolPolicy: typeof member.toolPolicy === "string" ? member.toolPolicy : "",
      promptChars: typeof member.executionPrompt === "string" ? member.executionPrompt.length : 0,
      rosterId: managed === null ? null : managed.rosterId,
      faithful: managed !== null && drift.length === 0,
      drift,
    };
  });

  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  const count = (status) => tasks.filter((task) => task?.status === status).length;

  return {
    id: team.id,
    name: team.name,
    description: typeof team.description === "string" ? team.description : "",
    phase: team.phase,
    halted: team.halted === true,
    escalated: team.escalated === true,
    planReviewState: typeof team.planReviewState === "string" ? team.planReviewState : null,
    captainSessionId: typeof team.captainSessionId === "string" ? team.captainSessionId : "",
    members,
    tasks: {
      total: tasks.length,
      completed: count("completed"),
      failed: count("failed"),
      pending: count("pending"),
      active: tasks.length - count("completed") - count("failed") - count("pending"),
    },
    file: team.file,
  };
}

/**
 * 成员名 → 档案成员 的索引（同名多份档案时以先扫到的为准，与工具取值顺序一致）。
 *
 * @param {object[]} rosters
 * @returns {Map<string, { rosterId: string, member: object }>}
 */
function indexRosterMembers(rosters) {
  const index = new Map();
  for (const roster of rosters) {
    for (const member of roster.members) {
      if (!index.has(member.name)) index.set(member.name, { rosterId: roster.id, member });
    }
  }
  return index;
}

/**
 * 统计每份档案的部署情况：文件里有几个成员、运行时真的出现了几个、字段是否有漂移。
 *
 * @param {object[]} rosters
 * @param {object[]} teams
 * @returns {Record<string, { deployed: number, total: number, drifted: number, teams: string[] }>}
 */
export function countDeployments(rosters, teams) {
  const result = {};
  for (const roster of rosters) {
    const names = new Set(roster.members.map((member) => member.name));
    const deployed = new Set();
    const drifted = new Set();
    const teamNames = new Set();
    for (const team of teams) {
      for (const member of team.members) {
        if (member.rosterId !== roster.id) continue;
        deployed.add(member.name);
        teamNames.add(team.name || team.id);
        if (!member.faithful) drifted.add(member.name);
      }
    }
    result[roster.id] = {
      deployed: [...names].filter((name) => deployed.has(name)).length,
      total: names.size,
      drifted: drifted.size,
      teams: [...teamNames],
    };
  }
  return result;
}

/**
 * 队长段：部署里的实际值 + 每份档案的核对结果。
 *
 * 部署值读不到不算错（核对待核字段会给 `unknown`），但一定如实标出来——不假装通过。
 *
 * @param {object[]} rosters
 * @param {{ readDeployed?: () => object }} [options] 测试注入
 * @returns {{ deployed: object, reports: object[] }}
 */
export function buildCaptainSection(rosters, options = {}) {
  const readDeployed = options.readDeployed ?? (() => readDeployedCaptains());
  let deployed;
  try {
    deployed = readDeployed();
  } catch (error) {
    deployed = {
      home: "",
      displayed: "",
      profiles: [],
      diagnostics: [{ severity: "warn", code: "captain-unreadable", reason: String(error?.message ?? error) }],
    };
  }

  const reports = rosters
    .filter((roster) => roster.captain !== undefined && roster.captain !== null)
    .map((roster) => {
      const verified = verifyCaptain(roster.captain, deployed);
      return { rosterId: roster.id, rootDir: roster.rootDir ?? "", checks: verified.checks, ok: verified.ok };
    });

  return {
    deployed: {
      home: deployed.home ?? "",
      displayed: deployed.displayed ?? "",
      profiles: (deployed.profiles ?? []).map((profile) => ({
        profile: profile.profile,
        provider: profile.provider,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        personas: (profile.personas ?? []).length,
      })),
      diagnostics: deployed.diagnostics ?? [],
    },
    reports,
  };
}

/**
 * 配置与环境体检：只产出 code + params，客户端负责措辞。
 *
 * @param {object} input
 * @returns {{ code: string, severity: "info" | "warn" | "error", params: object }[]}
 */
export function buildHints(input) {
  const hints = [];
  const { library, rosters, teams, config } = input;

  // 空档案库是初始状态，不是问题：目录没建（首次保存会自动建）、目录里还没有
  // 档案、以及"配置里写了相对路径"这类正常情况都不出提示。体检页只说真正
  // 需要用户决定的事——所以这里没有 no-rosters / roster-dir-missing 之类的条目。
  if (library.workspaces.some((workspace) => workspace.fallbackWorkspace)) {
    hints.push({ code: "workspace-fallback", severity: "info", params: {} });
  }

  const policies = Array.isArray(config.knownToolPolicies) ? config.knownToolPolicies : [];
  if (policies.length === 0 && rosters.some((roster) => roster.members.some((member) => member.toolPolicy))) {
    hints.push({ code: "tool-policies-unset", severity: "info", params: {} });
  }

  if (teams.available) {
    if (teams.teams.length === 0) {
      hints.push({ code: "teams-none", severity: "info", params: { stateDir: teams.stateDir } });
    }
  } else {
    hints.push({ code: "state-dir-missing", severity: "info", params: { stateDir: teams.stateDir } });
  }

  const duplicateIds = library.workspaces
    .flatMap((workspace) => workspace.diagnostics ?? [])
    .filter((item) => item?.code === "duplicate-roster-id").length;
  if (duplicateIds > 0) {
    hints.push({ code: "duplicate-roster-id", severity: "warn", params: { count: duplicateIds } });
  }

  const problems = library.workspaces
    .flatMap((workspace) => workspace.rosters ?? [])
    .reduce(
      (total, roster) => total + (roster.diagnostics ?? []).filter((item) => item?.severity === "error").length,
      0,
    );
  if (problems > 0) {
    hints.push({ code: "roster-errors", severity: "warn", params: { count: problems } });
  }

  return hints;
}

/**
 * 把公共目录里的一整套档案拉到本机档案库。
 *
 * 语义刻意做成**幂等**：
 * - 本地没有 → 写入，`action: "created"`；
 * - 本地有且是远端这一版 → 什么都不做，`action: "unchanged"`（重复点按钮不会产生噪音文件）；
 * - 本地有但内容不同 → 默认**不覆盖**，`action: "conflict"`（档案是用户资产，
 *   "点一下按钮就悄悄改掉你改过的东西"是不可接受的默认行为）；传 `overwrite` 才覆盖。
 *
 * 单份失败不影响其它份：每份各自返回结果，整体 `ok` 只要求“没有写入失败”。
 *
 * @param {object} config
 * @param {{ collectionId: string, source?: string, overwrite?: boolean, fetchImpl?: typeof fetch, cacheDir?: string }} options
 * @returns {Promise<object>}
 */
export async function installCollection(config, options) {
  const panel = await loadRemotePanel(config, { fetchImpl: options.fetchImpl, cacheDir: options.cacheDir });
  const collection = panel.collections.find(
    (item) => item.id === options.collectionId && (options.source === undefined || item.origin?.source === options.source),
  );
  if (collection === undefined) {
    return {
      ok: false,
      code: "collection-not-found",
      known: panel.collections.map((item) => item.id),
      diagnostics: panel.diagnostics,
    };
  }

  const fetched = await fetchCollection(collection, { fetchImpl: options.fetchImpl });
  const roots = listLibraryRoots({ rosterDirs: config.rosterDirs ?? [], workspaces: [] });
  const root = roots[0] ?? null;
  if (root === null) {
    return { ok: false, code: "no-library-root", diagnostics: fetched.diagnostics };
  }

  const results = [];
  for (const roster of fetched.rosters) {
    const text = rosterDocumentText(roster);
    const current = readRosterDocument({ roots, rootDir: root.rootDir, id: roster.id });

    // 内容一模一样就当“已是最新”：不写盘、不留备份、不报冲突，重复点按钮也安静。
    if (current.ok && current.text.trim() === text.trim()) {
      results.push({ id: roster.id, action: "unchanged", file: current.file });
      continue;
    }
    // 本地存在但版本不同：默认不覆盖，除非调用方显式要求。
    if (current.ok && options.overwrite !== true) {
      results.push({ id: roster.id, action: "conflict", file: current.file, code: "exists" });
      continue;
    }

    const written = writeRosterDocument({
      roots,
      rootDir: root.rootDir,
      text,
      overwrite: current.ok ? true : options.overwrite === true,
      knownToolPolicies: config.knownToolPolicies ?? null,
    });
    if (written.ok) {
      results.push({ id: roster.id, action: current.ok ? "updated" : "created", file: written.file });
      continue;
    }
    results.push({
      id: roster.id,
      action: written.code === "exists" ? "conflict" : written.code === "invalid-id" ? "invalid-id" : "failed",
      code: written.code,
      diagnostics: written.diagnostics ?? [],
    });
  }

  const failed = results.filter((item) => item.action === "failed" || item.action === "conflict");
  const fetchBroken = fetched.diagnostics.some((item) => item.severity === "error");
  return {
    ok: failed.length === 0 && !fetchBroken,
    collection: { id: collection.id, title: collection.title, repo: collection.repo, ref: collection.ref },
    rootDir: root.rootDir,
    results,
    written: results.filter((item) => item.action === "created" || item.action === "updated").length,
    unchanged: results.filter((item) => item.action === "unchanged").length,
    conflicts: results.filter((item) => item.action === "conflict").length,
    diagnostics: fetched.diagnostics,
  };
}

/**
 * 远程档案源（公共 registry）的投影。
 *
 * 只取“有哪些 collection、各自登记了几份档案”，**不**顺手把远端档案全拉一遍：
 * 面板打开一次就要几十个请求，而用户通常只想看自己库里的东西。真正拉取发生在
 * 用户点开某个 collection 时（`fetchCollection`）。
 *
 * @param {object} config 插件配置（已解引用）
 * @param {object} [options]
 * @param {string} [options.cacheDir] 缓存目录，默认 `<全局库>/.index-cache`
 * @param {boolean} [options.refresh] 忽略 TTL
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Date} [options.now]
 * @returns {Promise<object>}
 */
export async function loadRemotePanel(config, options = {}) {
  const cacheDir = options.cacheDir ?? nodePath.join(globalRosterRoot(), CACHE_DIR_NAME);
  const loaded = await loadRegistryIndex(config, {
    cacheDir,
    refresh: options.refresh === true,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  return {
    cacheDir,
    indexes: loaded.indexes,
    collections: loaded.collections.map((collection) => ({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      repo: collection.repo,
      ref: collection.ref,
      path: collection.path,
      rosters: collection.rosters,
      tags: collection.tags,
      license: collection.license,
      maintainers: collection.maintainers,
      homepage: collection.homepage,
      origin: collection.origin,
    })),
    diagnostics: loaded.diagnostics,
  };
}
