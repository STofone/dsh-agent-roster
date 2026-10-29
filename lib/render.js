/**
 * 人读渲染：工具输出与 CLI 共用同一套文本，避免"工具里一个样子、CI 里另一个样子"。
 *
 * 输出一律是纯文本（不是 Markdown 表格）：模型读、人在终端读都成立，
 * 也不会因为成员名里的字符破坏表格。JSON 视图由 `toJson` 单独提供。
 *
 * @module dsh-agent-roster/render
 */
import { BINDING_STATUS, describeField, summarizeBinding } from "./bridge.js";
import { LIMITS } from "./format.js";

/**
 * 诊断列表 → 文本块。错误在前、按文件分组，超出上限时明确写出省略了多少条。
 *
 * @param {object[]} diagnostics
 * @param {{ limit?: number, indent?: string }} [options]
 * @returns {string}
 */
export function renderDiagnostics(diagnostics, options = {}) {
  const list = (diagnostics ?? []).filter((item) => item !== null && typeof item === "object");
  if (list.length === 0) return "";
  const limit = options.limit ?? 40;
  const indent = options.indent ?? "  ";
  const severityRank = { error: 0, warn: 1, info: 2 };
  const sorted = list
    .slice()
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
  const shown = sorted.slice(0, limit);
  const lines = [];
  for (const item of shown) {
    // path/file 都可能是 null（"这条诊断不属于任何字段/文件"），null 不能落成字面量 "null"。
    const path = item.path === null ? "" : String(item.path ?? "");
    const fileText = item.file === null ? "" : String(item.file ?? "");
    const where = path === "" ? "" : ` ${path}`;
    const file = fileText === "" ? "" : `${fileText}: `;
    lines.push(`${indent}${item.severity}${where}  ${file}${item.reason}${item.code ? `  [${item.code}]` : ""}`);
  }
  if (sorted.length > shown.length) {
    lines.push(`${indent}… 还有 ${sorted.length - shown.length} 条诊断未显示`);
  }
  return lines.join("\n");
}

/**
 * 档案库总览。
 *
 * @param {{ rootDir: string, entries: object[], stats: object }} scan
 * @returns {string}
 */
export function renderRosterList(scan) {
  const { entries, stats, rootDir } = scan;
  const lines = [];
  lines.push(`档案库  ${rootDir}`);
  if (entries.length === 0) {
    lines.push("");
    lines.push("（空：没有任何 roster 目录）");
    lines.push("目录约定：<root>/<roster-id>/roster.{json,yaml,yml}");
    return lines.join("\n");
  }
  lines.push(`共 ${stats.total} 个目录 · 通过 ${stats.ok} · 失败 ${stats.failed}`);
  lines.push("");
  lines.push("ID                    版本      成员  状态     标题");
  for (const entry of entries) {
    const roster = entry.roster;
    if (roster === null) {
      lines.push(`${pad(entry.id, 21)}${pad("-", 10)}${pad("-", 5)}${pad("失败", 9)}(无有效档案)`);
      continue;
    }
    lines.push(
      `${pad(roster.id, 21)}${pad(roster.version, 10)}${pad(String(roster.members.length), 5)}${pad("通过", 9)}${roster.title}`,
    );
    lines.push(`  ${roster.members.map((member) => member.name).join(", ")}`);
  }
  const failed = scan.diagnostics.filter((item) => item.severity === "error");
  if (failed.length > 0) {
    lines.push("");
    lines.push("失败原因：");
    lines.push(renderDiagnostics(failed, { limit: 20 }));
  }
  return lines.join("\n");
}

/**
 * 单份档案详情。
 *
 * @param {object} roster
 * @param {string[]} [onlyMembers]
 * @returns {string}
 */
export function renderRosterDetail(roster, onlyMembers) {
  const wanted =
    Array.isArray(onlyMembers) && onlyMembers.length > 0 ? roster.members.filter((m) => onlyMembers.includes(m.name)) : roster.members;
  const lines = [];
  lines.push(`roster:${roster.id}@${roster.version}  ${roster.title}`);
  if (roster.description !== "") lines.push(`  ${roster.description}`);
  const meta = [];
  if (roster.license !== "") meta.push(`license=${roster.license}`);
  if (roster.maintainers.length > 0) meta.push(`maintainers=${roster.maintainers.join(", ")}`);
  if (roster.tags.length > 0) meta.push(`tags=${roster.tags.join(", ")}`);
  if (meta.length > 0) lines.push(`  ${meta.join("  ")}`);

  const defaults = Object.entries(roster.defaults ?? {});
  if (defaults.length > 0) {
    lines.push("");
    lines.push("defaults（成员未写该字段时继承）");
    for (const [key, value] of defaults) {
      lines.push(`  ${pad(key, 16)}${literal(value)}`);
    }
  }

  if (wanted.length === 0) {
    lines.push("");
    lines.push(`（档案里没有成员：${(onlyMembers ?? []).join(", ")}）`);
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`成员 ${wanted.length} 个`);
  for (const member of wanted) {
    lines.push("");
    lines.push(`▸ ${member.name}  —  ${member.role}`);
    if (member.provider !== undefined || member.model !== undefined) {
      const route = [member.provider ?? "(默认 provider)", member.model ?? "(默认 model)"].join(" / ");
      lines.push(`  model           ${route}${member.inherited?.includes("model") ? "  (继承 defaults)" : ""}`);
    } else {
      lines.push("  model           未指定 → 运行时沿用队长模型");
    }
    if (member.reasoningEffort !== undefined) lines.push(`  reasoningEffort ${member.reasoningEffort}`);
    if (member.toolPolicy !== undefined) lines.push(`  toolPolicy      ${member.toolPolicy}（必须是部署已声明的策略 id）`);
    if (member.fallback !== undefined) lines.push(`  fallback        ${member.fallback.provider} / ${member.fallback.model}（需落部署配置）`);
    if (member.toolScope !== undefined) lines.push(`  toolScope       仅声明：${describeToolScope(member.toolScope)}`);
    if (member.maxTokens !== undefined) lines.push(`  maxTokens       ${member.maxTokens}（仅声明）`);
    if (member.tags.length > 0) lines.push(`  tags            ${member.tags.join(", ")}`);
    if (member.notes !== "") lines.push(`  notes           ${member.notes}`);
    lines.push(`  systemPrompt    ${member.systemPrompt.length} 字符 / 上限 ${LIMITS.systemPromptChars}`);
    lines.push(`    ${firstLines(member.systemPrompt, 2, 160)}`);
  }
  return lines.join("\n");
}

/**
 * 桥接计划：把每个成员翻译成一条 `agent_teams_add_member` 调用，并标注每个字段的归宿。
 *
 * @param {{ roster: object, entries: object[], planMembers: object[] }} plan
 * @returns {string}
 */
export function renderBridgePlan(plan) {
  const { roster, entries } = plan;
  const lines = [];
  lines.push(`桥接计划  roster:${roster.id}@${roster.version}  →  ${entries.length} 个成员`);
  lines.push("");
  lines.push("本插件不创建成员：下面的参数请由队长原样传给 dsh-agent-teams 的 agent_teams_add_member。");
  lines.push("（新团队也可以把这些成员放进 agent_teams_create 的 plan.members。）");
  for (const [index, entry] of entries.entries()) {
    lines.push("");
    lines.push(`${index + 1}) ${entry.member.name}  —  ${entry.member.role}`);
    lines.push(`   agent_teams_add_member(${JSON.stringify(entry.args, null, 2).replace(/\n/g, "\n   ")})`);
    lines.push("");
    for (const field of entry.binding.fields) {
      lines.push(`   ${describeField(field)}`);
    }
    const summary = summarizeBinding(entry.binding);
    const awaiting = summary.counts.pending ?? 0;
    lines.push("");
    lines.push(`   待运行时回执的字段：${awaiting}；仅声明：${summary.counts["not-carried"] ?? 0}；需落配置：${summary.counts["config-required"] ?? 0}`);
  }
  lines.push("");
  lines.push("成员创建完成后，用 roster_verify 比对 team.json 里的实际值；一致才算档案真正生效。");
  return lines.join("\n");
}

/**
 * 核对报告。
 *
 * @param {object} report `verifyBindings` 的结果
 * @param {{ rosterIds?: string[] }} [options]
 * @returns {string}
 */
export function renderVerifyReport(report, options = {}) {
  const lines = [];
  const rosterIds = new Set(options.rosterIds ?? []);
  const checks = rosterIds.size === 0 ? report.checks : report.checks.filter((check) => rosterIds.has(check.rosterId));

  if (checks.length === 0) {
    lines.push("没有可核对的成员（档案为空，或指定成员不在档案里）。");
    return lines.join("\n");
  }

  const byRoster = new Map();
  for (const check of checks) {
    const key = `${check.rosterId}@${check.rosterVersion}`;
    if (!byRoster.has(key)) byRoster.set(key, []);
    byRoster.get(key).push(check);
  }

  for (const [key, group] of byRoster) {
    const faithful = group.filter((check) => check.found && check.faithful).length;
    const found = group.filter((check) => check.found).length;
    lines.push(`roster:${key}  成员 ${group.length} · 已部署 ${found} · 一致 ${faithful}`);
    for (const check of group) {
      if (!check.found) {
        lines.push("");
        lines.push(`▸ ${check.member}  未在团队中部署（档案定义了，运行时没有同名成员）`);
        continue;
      }
      lines.push("");
      const verdict = check.faithful ? "一致" : "降级";
      lines.push(`▸ ${check.member}  @ ${check.teamName}   ${verdict}`);
      for (const field of check.binding.fields) {
        if (field.status === "pending") continue;
        lines.push(`   ${describeField(field)}`);
      }
      if (!check.faithful) {
        const summary = check.summary;
        lines.push(
          `   → 降级字段：覆盖 ${summary.counts.overridden ?? 0} · 缺失 ${summary.counts.omitted ?? 0} · 无法核对 ${summary.counts.unconfirmed ?? 0}`,
        );
      }
    }
    lines.push("");
  }

  if (report.unmanaged.length > 0) {
    lines.push(`另有 ${report.unmanaged.length} 个成员不在任何档案里（运行时直接创建的）：`);
    for (const item of report.unmanaged) {
      const route = [item.provider, item.model].filter((part) => part !== "").join("/");
      lines.push(`  · ${item.name} @ ${item.teamName}${route === "" ? "" : `  ${route}`}`);
    }
    lines.push("");
  }

  const summary = report.summary;
  lines.push(
    `汇总：一致 ${summary.faithful} · 降级 ${summary.degraded} · 未部署 ${summary.missing} · 无档案 ${summary.unmanaged}`,
  );
  return lines.join("\n");
}

/** 状态标签，供 UI 与报告共用。 */
export function statusLabel(status) {
  return BINDING_STATUS[status] ?? status;
}

function pad(text, width) {
  const value = String(text);
  if (value.length >= width) return `${value} `;
  return value + " ".repeat(width - value.length);
}

function literal(value) {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describeToolScope(scope) {
  const parts = [];
  if (Array.isArray(scope.allow) && scope.allow.length > 0) parts.push(`allow(${scope.allow.length})`);
  if (Array.isArray(scope.deny) && scope.deny.length > 0) parts.push(`deny(${scope.deny.length})`);
  return parts.length === 0 ? "空" : parts.join(" ");
}

function firstLines(text, maxLines, maxChars) {
  const value = String(text ?? "")
    .trim()
    .replace(/\r\n/g, "\n");
  const lines = value.split("\n").slice(0, maxLines).join(" / ");
  const clipped = lines.length > maxChars ? `${lines.slice(0, maxChars)}…` : lines;
  return clipped === "" ? "（空）" : clipped;
}
