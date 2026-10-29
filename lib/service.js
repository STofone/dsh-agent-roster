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
import { globalRosterRoot } from "./home.js";
import { collectLibrary, listWorkspaces } from "./library.js";
import { readTeamStates, resolveStateDir } from "./teams-state.js";
import { listLibraryRoots } from "./write.js";

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
 * 配置与环境体检：只产出 code + params，客户端负责措辞。
 *
 * @param {object} input
 * @returns {{ code: string, severity: "info" | "warn" | "error", params: object }[]}
 */
export function buildHints(input) {
  const hints = [];
  const { library, roots, rosters, teams, config } = input;

  if (library.workspaces.some((workspace) => workspace.fallbackWorkspace)) {
    hints.push({ code: "workspace-fallback", severity: "info", params: {} });
  }

  for (const root of roots) {
    if (!root.exists) {
      hints.push({ code: "roster-dir-missing", severity: "warn", params: { dirSpec: root.dirSpec, rootDir: root.rootDir } });
      continue;
    }
    const inRoot = rosters.filter((roster) =>
      library.workspaces.some((workspace) => workspace.rootDir === root.rootDir && workspace.rosters.includes(roster)),
    );
    if (inRoot.length === 0) {
      hints.push({ code: "roster-dir-empty", severity: "info", params: { rootDir: root.rootDir } });
    }
  }

  if (rosters.length === 0 && roots.some((root) => root.exists)) {
    hints.push({ code: "no-rosters", severity: "warn", params: {} });
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
