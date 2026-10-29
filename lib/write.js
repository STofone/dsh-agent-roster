/**
 * 档案文件的读写：面板的"新建/编辑/导入/删除"落到磁盘的那一层。
 *
 * 安全边界都在这里：
 * - 只能写进配置里声明过的档案库目录（`config.rosterDirs` × 已知工作区解析出的绝对路径），
 *   客户端传来的 `rootDir` 必须精确等于其中之一，杜绝"借面板写任意路径"；
 * - 档案 id 只允许 `[a-z0-9][a-z0-9._-]*`，且必须是校验通过的文档里的 id，
 *   因此路径片段不会包含分隔符或 `..`；
 * - 写入前先解析 + 校验，校验不过就一个字节都不落盘；
 * - 落盘用"同目录临时文件 + rename"，中途失败不会留下半份档案。
 *
 * @module dsh-agent-roster/write
 */
import fs from "node:fs";
import nodePath from "node:path";

import { MAX_DOCUMENT_BYTES, PATTERNS, ROSTER_KIND } from "./format.js";
import { formatOf, parseDocumentText } from "./parse.js";
import { validateRoster } from "./validate.js";

/** 每种格式落盘时的文件名。 */
export const FORMAT_FILE_NAMES = {
  json: "roster.json",
  yaml: "roster.yaml",
  yml: "roster.yaml",
};

/** 一个档案目录里会被本体认作"档案文件"的名字。 */
const ROSTER_FILE_NAMES = ["roster.json", "roster.yaml", "roster.yml"];

/** 覆盖时保留的上一版备份后缀（扫描器不认识，因此不会当成第二份档案）。 */
const BACKUP_SUFFIX = ".bak";

/**
 * 解析本轮允许写的档案库根目录。
 *
 * @param {{ rosterDirs?: string[], workspaces: { path: string }[] }} input
 * @returns {{ dirSpec: string, workspacePath: string, rootDir: string, exists: boolean }[]}
 */
export function listLibraryRoots(input) {
  const dirSpecs = Array.isArray(input.rosterDirs) && input.rosterDirs.length > 0 ? input.rosterDirs : ["rosters"];
  const workspaces =
    Array.isArray(input.workspaces) && input.workspaces.length > 0 ? input.workspaces : [{ path: process.cwd() }];
  const roots = [];
  for (const workspace of workspaces) {
    for (const dirSpec of dirSpecs) {
      const rootDir = nodePath.isAbsolute(dirSpec) ? dirSpec : nodePath.resolve(workspace.path, dirSpec);
      roots.push({ dirSpec, workspacePath: workspace.path, rootDir, exists: fs.existsSync(rootDir) });
    }
  }
  return roots;
}

/**
 * 在允许列表里按绝对路径找根目录（Windows 路径比较不区分大小写）。
 *
 * @param {{ rootDir: string }[]} roots
 * @param {string} rootDir
 * @returns {object | null}
 */
export function findLibraryRoot(roots, rootDir) {
  if (typeof rootDir !== "string" || rootDir === "") return null;
  const wanted = nodePath.resolve(rootDir);
  const key = process.platform === "win32" ? wanted.toLowerCase() : wanted;
  return roots.find((root) => (process.platform === "win32" ? root.rootDir.toLowerCase() : root.rootDir) === key) ?? null;
}

/**
 * 档案 id 是否可安全用作路径片段。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isSafeRosterId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return false;
  if (!PATTERNS.id.test(id)) return false;
  if (id === "." || id === "..") return false;
  return !id.includes("/") && !id.includes("\\");
}

/**
 * 目标目录必须严格落在档案库根目录内部（防御性双保险，id 已经过滤过）。
 *
 * @param {string} rootDir
 * @param {string} id
 * @returns {string | null} 绝对目录；越界返回 null
 */
export function resolveRosterDir(rootDir, id) {
  if (!isSafeRosterId(id)) return null;
  const dir = nodePath.resolve(rootDir, id);
  const relative = nodePath.relative(nodePath.resolve(rootDir), dir);
  if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative)) return null;
  if (relative.includes(nodePath.sep)) return null;
  return dir;
}

/**
 * 读一份档案的原始文本，供编辑框回填。
 *
 * @param {{ roots: object[], rootDir: string, id: string }} input
 * @returns {{ ok: true, file: string, format: string, text: string } | { ok: false, code: string }}
 */
export function readRosterDocument(input) {
  const root = findLibraryRoot(input.roots, input.rootDir);
  if (root === null) return { ok: false, code: "unknown-root" };
  const dir = resolveRosterDir(root.rootDir, input.id);
  if (dir === null) return { ok: false, code: "invalid-id" };

  for (const name of ROSTER_FILE_NAMES) {
    const file = nodePath.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      return { ok: true, file: `${input.id}/${name}`, format: formatOf(name), text };
    } catch {
      return { ok: false, code: "unreadable-file" };
    }
  }
  return { ok: false, code: "not-found" };
}

/**
 * 校验并写下一份档案（新建或覆盖）。
 *
 * @param {{
 *   roots: object[],
 *   rootDir: string,
 *   text: string,
 *   format?: string,
 *   overwrite?: boolean,
 *   knownToolPolicies?: string[] | null,
 * }} input
 * @returns {{
 *   ok: true,
 *   file: string,
 *   format: string,
 *   roster: { id: string, title: string, members: number },
 *   removed: string[],
 * } | { ok: false, code: string, diagnostics?: object[], existing?: { file: string, format: string } }}
 */
export function writeRosterDocument(input) {
  const root = findLibraryRoot(input.roots, input.rootDir);
  if (root === null) return { ok: false, code: "unknown-root" };

  if (typeof input.text !== "string" || input.text.trim() === "") {
    return { ok: false, code: "empty-document", diagnostics: [] };
  }
  if (Buffer.byteLength(input.text, "utf8") > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: "document-too-large", diagnostics: [] };
  }

  const format = resolveFormat(input.format, input.text);
  if (format === null) return { ok: false, code: "unknown-format", diagnostics: [] };

  const parsed = parseDocumentText(input.text, { file: "roster", format });
  if (!parsed.ok) return { ok: false, code: "invalid-document", diagnostics: parsed.diagnostics };

  const validated = validateRoster(parsed.value, {
    file: "roster",
    knownToolPolicies: input.knownToolPolicies ?? null,
  });
  if (!validated.ok) {
    // id 本身不合法时单独归类：这是"换个名字就能存"的问题，不该混进"文档结构有问题"。
    const onlyId =
      validated.diagnostics.length > 0 && validated.diagnostics.every((item) => item.code === "invalid-id");
    return {
      ok: false,
      code: onlyId ? "invalid-id" : "invalid-document",
      diagnostics: validated.diagnostics.map((item) => ({ ...item, file: "" })),
    };
  }

  const roster = validated.roster;
  if (roster.kind !== ROSTER_KIND) return { ok: false, code: "invalid-document", diagnostics: validated.diagnostics };
  if (!isSafeRosterId(roster.id)) {
    return {
      ok: false,
      code: "invalid-id",
      diagnostics: validated.diagnostics.filter((item) => item.code === "invalid-id"),
    };
  }

  const dir = resolveRosterDir(root.rootDir, roster.id);
  if (dir === null) return { ok: false, code: "invalid-id" };

  // 同一目录里已有的档案文件：同名覆盖要显式确认，异格式要显式确认"换格式"。
  const existing = [];
  for (const name of ROSTER_FILE_NAMES) {
    const file = nodePath.join(dir, name);
    if (fs.existsSync(file)) existing.push({ name, format: formatOf(name) });
  }
  const sameFormat = existing.find((item) => item.format === format);
  const otherFormats = existing.filter((item) => item.format !== format);
  if (sameFormat !== undefined && input.overwrite !== true) {
    return { ok: false, code: "exists", existing: { file: `${roster.id}/${sameFormat.name}`, format } };
  }
  if (otherFormats.length > 0 && input.overwrite !== true) {
    return {
      ok: false,
      code: "format-conflict",
      existing: { file: `${roster.id}/${otherFormats[0].name}`, format: otherFormats[0].format },
    };
  }

  const targetName = FORMAT_FILE_NAMES[format];
  const target = nodePath.join(dir, targetName);
  const removed = [];

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (sameFormat !== undefined) {
      fs.copyFileSync(target, `${target}${BACKUP_SUFFIX}`);
    }
    for (const item of otherFormats) {
      // 换格式时把旧文件挪成备份，而不是删掉：用户能反悔。
      fs.renameSync(nodePath.join(dir, item.name), nodePath.join(dir, `${item.name}${BACKUP_SUFFIX}`));
      removed.push(`${roster.id}/${item.name}`);
    }
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, input.text, "utf8");
    fs.renameSync(temporary, target);
  } catch {
    return { ok: false, code: "write-failed" };
  }

  return {
    ok: true,
    file: `${roster.id}/${targetName}`,
    format,
    roster: { id: roster.id, title: roster.title ?? roster.id, members: roster.members.length },
    removed,
  };
}

/**
 * 删除一份档案：只删本体认得的档案文件名，不碰同目录的其它文件，也不递归删除。
 *
 * @param {{ roots: object[], rootDir: string, id: string }} input
 * @returns {{ ok: true, removed: string[] } | { ok: false, code: string }}
 */
export function deleteRosterDocument(input) {
  const root = findLibraryRoot(input.roots, input.rootDir);
  if (root === null) return { ok: false, code: "unknown-root" };
  const dir = resolveRosterDir(root.rootDir, input.id);
  if (dir === null) return { ok: false, code: "invalid-id" };
  if (!fs.existsSync(dir)) return { ok: false, code: "not-found" };

  const removed = [];
  for (const name of ROSTER_FILE_NAMES) {
    const file = nodePath.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      fs.unlinkSync(file);
      removed.push(`${input.id}/${name}`);
    } catch {
      return { ok: false, code: "delete-failed" };
    }
  }
  if (removed.length === 0) return { ok: false, code: "not-found" };

  // 目录空了就顺手收掉；还有别的文件（备份、README）时保留目录。
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // 收不掉不算失败：文件已经删掉了。
  }
  return { ok: true, removed };
}

/**
 * 推断格式：显式指定优先，否则按文本首字符推断（`{`/`[` 视为 JSON）。
 *
 * @param {unknown} declared
 * @param {string} text
 * @returns {"json" | "yaml" | null}
 */
function resolveFormat(declared, text) {
  if (declared === "json" || declared === "yaml") return declared;
  if (declared !== undefined && declared !== null && declared !== "") return null;
  return text.trimStart().startsWith("{") ? "json" : "yaml";
}
