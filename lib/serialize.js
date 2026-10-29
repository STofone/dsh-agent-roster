/**
 * 把一份**已校验**的档案还原成可落盘的文档文本。
 *
 * 用在"从公共目录拉取到本机"这条路上：远端拉下来的是对象，落盘要的是文件。
 * 选择 JSON 而不是 YAML 的理由很实际——JSON 不会因为手写缩进、引号、多行块的
 * 细微差异而在下一次拉取时被误判成"用户改过"。YAML 那份留给用户自己写。
 *
 * 只写**档案语义字段**：`inherited`/`origin`/`file` 是校验与投影过程的副产物，
 * 写进文件会变成"下一版校验器不认识的多余键"。
 *
 * @module dsh-agent-roster/serialize
 */
import { ROSTER_KIND } from "./format.js";

/** 档案顶层字段的落盘顺序（顺序稳定，diff 才好看）。 */
const TOP_LEVEL = [
  ["kind", (roster) => (roster.kind === ROSTER_KIND ? ROSTER_KIND : ROSTER_KIND)],
  ["roster", (roster) => roster.id],
  ["version", (roster) => roster.version],
  ["title", (roster) => roster.title],
  ["description", (roster) => roster.description],
  ["license", (roster) => roster.license],
  ["maintainers", (roster) => roster.maintainers],
  ["tags", (roster) => roster.tags],
  ["defaults", (roster) => roster.defaults],
];

/** 成员字段顺序；值为空则整键省略，避免生成一堆 `"notes": ""`。 */
const MEMBER_FIELDS = [
  "name",
  "role",
  "title",
  "description",
  "aliases",
  "skills",
  "examples",
  "systemPrompt",
  "tags",
  "notes",
  "provider",
  "model",
  "reasoningEffort",
  "toolPolicy",
  "toolScope",
  "fallback",
  "maxTokens",
];

function isEmpty(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    const value = source?.[field];
    if (!isEmpty(value)) out[field] = value;
  }
  return out;
}

/**
 * 档案对象 → 落盘文本（JSON，两个空格缩进，末尾带换行）。
 *
 * @param {object} roster 已校验的档案（`validateRoster` 的产物）
 * @returns {string}
 */
export function rosterDocumentText(roster) {
  const document = {};
  for (const [key, read] of TOP_LEVEL) {
    const value = read(roster);
    if (!isEmpty(value)) document[key] = value;
  }
  document.members = (roster.members ?? []).map((member) => pick(member, MEMBER_FIELDS));
  if (!isEmpty(roster.captain)) document.captain = pick(roster.captain, CAPTAIN_FIELDS);
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** 队长段允许出现的字段。 */
const CAPTAIN_FIELDS = [
  "name",
  "description",
  "provider",
  "model",
  "reasoningEffort",
  "personaPrefix",
  "systemPrompt",
];
