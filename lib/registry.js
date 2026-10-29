/**
 * 档案库枚举与索引。
 *
 * 目录约定（一份档案 = 一个目录）：
 *
 * ```text
 * rosters/
 *   core-review/
 *     roster.yaml
 *   research/
 *     roster.yaml
 * ```
 *
 * 为什么是目录而不是散落的 `*.yaml`：目录名就是档案 id（`roster` 字段必须与之一致），
 * 未来要给档案加附加文件（说明、示例任务、覆盖片段）时不用改布局；也让"某个 id 到底是
 * 哪个文件"没有歧义。
 *
 * 本模块只读文件系统，不写任何东西。缺失的档案库不是错误（空库是合法状态），
 * 但会给出显式提示，避免"静默空结果"。目录里没有 `roster.*` 的会被跳过并记一条 info，
 * 不算成"校验失败"——这两件事必须分开，否则用户分不清是写错了还是根本没写。
 *
 * @module dsh-agent-roster/registry
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";

import { MEMBER_FILE_NAMES } from "./format.js";
import { parseDocumentText } from "./parse.js";
import { validateRoster } from "./validate.js";

/** 与档案无关、必须跳过的目录名（依赖、隐藏状态、虚拟环境）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".agent-teams", ".dsh", ".venv", "__pycache__"]);

/**
 * 扫描一座档案库。
 *
 * @param {object} options
 * @param {string} options.rootDir 绝对路径
 * @param {string[] | null} [options.knownToolPolicies] 部署已声明的 toolPolicy id
 * @returns {{
 *   rootDir: string,
 *   missing: boolean,
 *   entries: { id: string, file: string | null, roster: object | null }[],
 *   rosters: object[],
 *   stats: { total: number, ok: number, failed: number, members: number,
 *            skippedDirs: number, errors: number, warnings: number, infos: number },
 *   diagnostics: object[],
 * }}
 */
export function scanRosterLibrary({ rootDir, knownToolPolicies = null }) {
  const diagnostics = [];
  const entries = [];
  const rosters = [];
  const stats = {
    total: 0,
    ok: 0,
    failed: 0,
    members: 0,
    skippedDirs: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
  };

  let childDirs = null;
  try {
    if (statSync(rootDir).isDirectory()) childDirs = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    childDirs = null;
  }

  // 目录不存在只记 missing 标记：首次保存会自动建，空库不该产出 warn/info 噪音。
  if (childDirs !== null) {
    childDirs.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of childDirs) {
      if (child.name.startsWith(".") || SKIP_DIRS.has(child.name) || child.isSymbolicLink()) continue;

      if (!child.isDirectory()) {
        // 散落的 *.yaml 曾经是另一种布局；现在只认目录，必须明确告知而不是忽略。
        diagnostics.push({
          severity: "warn",
          code: "unexpected-file",
          path: "",
          file: child.name,
          reason:
            `档案库里直接出现了文件 "${child.name}"。目录约定是 <root>/<roster-id>/roster.yaml：` +
            "请把它移进以档案 id 命名的子目录，否则它不会被加载。",
        });
        continue;
      }

      const dirPath = nodePath.join(rootDir, child.name);
      const found = locateDocument(dirPath, child.name, diagnostics);
      if (found === null) {
        stats.skippedDirs += 1;
        continue;
      }

      stats.total += 1;
      const entry = { id: child.name, file: found.relative, roster: null };
      const outcome = loadDocument(found, child.name, { knownToolPolicies });
      diagnostics.push(...outcome.diagnostics);
      if (outcome.ok) {
        entry.roster = outcome.roster;
        rosters.push(outcome.roster);
        stats.ok += 1;
      } else {
        stats.failed += 1;
      }
      entries.push(entry);
    }
  }

  if (stats.total > 0 && rosters.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "library-unusable",
      path: "",
      file: null,
      reason: `档案库里有 ${stats.total} 份档案，却没有一份通过校验；档案层无法为运行时提供任何成员。`,
    });
  }

  // 「没配置交叉校验的已知列表」是档案库级的一件事，说一次就够：
  // 逐份档案重复警告会把噪音放大成 n 倍，反而让人习惯性忽略警告。
  // 只有真的有档案声明了 toolPolicy 才提——空库或没人用策略时，没东西好交叉核对。
  const declaresToolPolicy = rosters.some((roster) => roster.members.some((member) => member.toolPolicy));
  if ((knownToolPolicies ?? []).length === 0 && declaresToolPolicy) {
    diagnostics.push({
      severity: "info",
      code: "tool-policy-cross-check-skipped",
      path: "",
      file: null,
      reason:
        "未配置 knownToolPolicies：toolPolicy 只做格式校验，不与部署已声明的策略 id 交叉核对。" +
        "把部署里存在的策略 id 列进该配置即可启用交叉校验。",
    });
  }

  for (const item of diagnostics) {
    if (item.severity === "error") stats.errors += 1;
    else if (item.severity === "warn") stats.warnings += 1;
    else stats.infos += 1;
  }
  stats.members = rosters.reduce((sum, roster) => sum + roster.members.length, 0);

  const severityRank = { error: 0, warn: 1, info: 2 };
  diagnostics.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      String(left.file ?? "").localeCompare(String(right.file ?? "")),
  );

  return { rootDir, missing: childDirs === null, entries, rosters, stats, diagnostics };
}

/**
 * 在一个档案目录里找唯一的档案文件。
 *
 * 多个 `roster.*` 同时存在时按 {@link MEMBER_FILE_NAMES} 顺序取第一个并警告：
 * 两份档案同时生效会让人以为改了字段却没生效。
 *
 * @param {string} dirPath
 * @param {string} dirName
 * @param {object[]} diagnostics
 * @returns {{ absolute: string, relative: string, format: string } | null}
 */
function locateDocument(dirPath, dirName, diagnostics) {
  let names;
  try {
    names = readdirSync(dirPath);
  } catch (error) {
    diagnostics.push({
      severity: "warn",
      code: "unreadable-dir",
      path: "",
      file: dirName,
      reason: `档案目录不可读：${messageOf(error)}`,
    });
    return null;
  }

  const present = MEMBER_FILE_NAMES.filter((name) => names.includes(name));
  if (present.length === 0) {
    diagnostics.push({
      severity: "info",
      code: "missing-roster-file",
      path: "",
      file: `${dirName}/`,
      reason:
        `目录 "${dirName}" 里没有 ${MEMBER_FILE_NAMES.join(" / ")}，已跳过（不计入校验失败）。` +
        "如果这是要新建的档案，请在目录里放一份 roster.yaml。",
    });
    return null;
  }
  if (present.length > 1) {
    diagnostics.push({
      severity: "warn",
      code: "multiple-roster-files",
      path: "",
      file: `${dirName}/${present[0]}`,
      reason:
        `目录 "${dirName}" 同时存在 ${present.join("、")}，只加载 ${present[0]}；` +
        "请删掉多余文件，否则另一份永远不会生效。",
    });
  }
  return {
    absolute: nodePath.join(dirPath, present[0]),
    relative: `${dirName}/${present[0]}`,
    format: present[0].endsWith(".json") ? "json" : "yaml",
  };
}

/**
 * 读取 + 解析 + 校验一份档案。
 *
 * @param {{ absolute: string, relative: string, format: string }} found
 * @param {string} expectedId 目录名，必须与 `roster` 字段一致
 * @param {{ knownToolPolicies: string[] | null }} options
 * @returns {{ ok: boolean, roster: object | null, diagnostics: object[] }}
 */
function loadDocument(found, expectedId, { knownToolPolicies }) {
  let raw;
  try {
    raw = readFileSync(found.absolute, "utf8");
  } catch (error) {
    return {
      ok: false,
      roster: null,
      diagnostics: [
        {
          severity: "error",
          code: "unreadable-file",
          path: "",
          file: found.relative,
          reason: `文件不可读：${messageOf(error)}`,
        },
      ],
    };
  }

  const parsed = parseDocumentText(raw, { file: found.relative, format: found.format });
  if (!parsed.ok) return { ok: false, roster: null, diagnostics: parsed.diagnostics };

  const validated = validateRoster(parsed.value, {
    file: found.relative,
    expectedId,
    knownToolPolicies,
  });
  if (!validated.ok) return { ok: false, roster: null, diagnostics: validated.diagnostics };

  return {
    ok: true,
    roster: { ...validated.roster, format: found.format },
    diagnostics: validated.diagnostics,
  };
}

/**
 * 定位一份档案或其中某个成员。
 *
 * 这是个**纯查找**函数：不猜测、不模糊匹配。成员名在多份档案里重复出现时返回歧义列表，
 * 由调用方要求用户改用档案 id——替用户随便挑一份，正是"档案看起来生效了"的根源。
 *
 * @param {object[]} rosters 已通过校验的档案
 * @param {string} ref 档案 id 或成员名
 * @returns {null | { via: "id" | "member", roster: object } | { ambiguous: object[] }}
 */
export function findRoster(rosters, ref) {
  const wanted = String(ref ?? "").trim();
  if (wanted === "") return null;

  const byId = rosters.find((roster) => roster.id === wanted);
  if (byId !== undefined) return { via: "id", roster: byId };

  const matches = rosters.filter((roster) => roster.members.some((member) => member.name === wanted));
  if (matches.length === 0) return null;
  if (matches.length === 1) return { via: "member", roster: matches[0] };
  return { ambiguous: matches };
}

/** 把任意异常的 message 折成一行；与 parse.js 保持同一口径。 */
export function messageOf(error) {
  return String(error?.message ?? error ?? "未知错误").split("\n")[0];
}
