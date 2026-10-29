/**
 * 桥接层：把静态档案翻译成 dsh-agent-teams 可以执行的调用参数，并如实标注每个字段的归宿。
 *
 * 这一层刻意**只做翻译与核对，不做调用**：真正的成员创建仍由队长模型发起
 * `agent_teams_add_member`。原因是档案层不知道团队此刻处于什么阶段（暂存/运行/已归档），
 * 也不应该替运行时决定"现在创建一个成员"。工具只输出参数，模型原样传入，运行时决定成败。
 *
 * 三个诚实状态必须被区分，否则档案会给人"能力已被运行时保证"的错觉：
 *
 * - `applied`：运行时状态里的值与档案一致（读取的是 team.json，不是我们的请求）；
 * - `overridden` / `omitted`：运行时最终采用了别的值，或根本没带这个字段；
 * - `not-carried`：agent-teams 没有对应承载（toolScope、maxTokens 等），档案只是声明。
 *
 * @module dsh-agent-roster/bridge
 */
import { FIELD_BINDING } from "./format.js";

/** 成员字段 → 调用参数名 / 运行时状态键。 */
const CARRIED_FIELDS = [
  { field: "name", param: "name", stateKey: "name" },
  { field: "role", param: "role", stateKey: "role" },
  { field: "systemPrompt", param: "executionPrompt", stateKey: "executionPrompt" },
  { field: "provider", param: "provider", stateKey: "provider" },
  { field: "model", param: "model", stateKey: "model" },
  { field: "reasoningEffort", param: "reasoning_effort", stateKey: "reasoningEffort" },
  { field: "toolPolicy", param: "tool_policy", stateKey: "toolPolicy" },
];

/** 桥接状态的中文标签，工具输出与 UI 共用。 */
export const BINDING_STATUS = {
  pending: "已生成参数，运行时尚未回执",
  applied: "运行时取值与档案一致",
  overridden: "运行时实际取值与档案不同",
  omitted: "运行时未携带该字段",
  unconfirmed: "缺少运行时状态，无法核对",
  "not-carried": "agent-teams 无承载，仅声明",
  "config-required": "需要落到部署配置才生效",
};

/**
 * 为一份档案里的一个成员生成桥接结果。
 *
 * 字段值缺失时一律写 `null` 而不是 `undefined`：工具返回值要能无损往返 JSON，
 * 带 `undefined` 的键会被序列化丢掉，运行时因此判整次调用失败。
 *
 * @param {object} roster 已校验的档案
 * @param {object} member 已校验的成员
 * @returns {{ args: object, planMember: object, binding: object }}
 */
export function buildMemberBinding(roster, member) {
  const args = { name: member.name, role: member.role, executionPrompt: member.systemPrompt };
  if (member.provider !== undefined) args.provider = member.provider;
  if (member.model !== undefined) args.model = member.model;
  if (member.reasoningEffort !== undefined) args.reasoning_effort = member.reasoningEffort;
  if (member.toolPolicy !== undefined) args.tool_policy = member.toolPolicy;

  const planMember = { name: member.name, role: member.role };
  if (member.provider !== undefined) planMember.provider = member.provider;
  if (member.model !== undefined) planMember.model = member.model;
  if (member.reasoningEffort !== undefined) planMember.reasoning_effort = member.reasoningEffort;
  if (member.toolPolicy !== undefined) planMember.tool_policy = member.toolPolicy;

  const binding = {
    rosterId: roster.id,
    rosterVersion: roster.version,
    member: member.name,
    origin: provenanceOf(roster, member),
    fields: [],
  };

  for (const { field, param, stateKey } of CARRIED_FIELDS) {
    const carried = args[param] !== undefined;
    const source = member.inherited?.includes(field) ? "defaults" : "member";
    if (!carried && field !== "name" && field !== "role" && field !== "systemPrompt") {
      binding.fields.push({
        field,
        param,
        stateKey,
        source,
        status: "omitted",
        requested: null,
        actual: null,
        note: "档案未指定，运行时将沿用队长默认",
      });
      continue;
    }
    if (!carried) {
      // name/role/executionPrompt 永远有值，走到这里说明数据损坏，明确报出来而不是静默跳过。
      binding.fields.push({
        field,
        param,
        stateKey,
        source,
        status: "omitted",
        requested: null,
        actual: null,
        note: "档案缺少该必填字段",
      });
      continue;
    }
    binding.fields.push({
      field,
      param,
      stateKey,
      source,
      status: "pending",
      requested: args[param],
      actual: null,
      note: "",
    });
  }

  for (const [field, kind] of Object.entries(FIELD_BINDING)) {
    if (kind === "direct") continue;
    const value = member[field];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && value === "") continue;
    binding.fields.push({
      field,
      param: null,
      stateKey: null,
      source: member.inherited?.includes(field) ? "defaults" : "member",
      status: kind === "config" ? "config-required" : "not-carried",
      requested: value,
      actual: null,
      note:
        kind === "config"
          ? field === "fallback"
            ? "备用路由需写进成员创建后的部署配置（本插件不代写配置）"
            : "该字段需落到部署配置才会生效"
          : "agent-teams 成员无此承载，档案仅作能力声明与校验依据",
    });
  }

  return { args, planMember, binding };
}

/**
 * 用一份真实的团队状态（team.json 的 members[]）核对该成员的桥接结果。
 *
 * 比对的是运行时**持久化的实际值**，不是我们发出去的请求参数——这是"验证"与"自我报告"的分界。
 *
 * @param {object} binding `buildMemberBinding` 产出的 binding
 * @param {object | null} teamMember team.json 里同名的成员记录
 * @returns {object} 同一个 binding（就地更新），便于链式使用
 */
export function reconcileBinding(binding, teamMember) {
  const found = teamMember ?? null;
  for (const entry of binding.fields) {
    if (entry.param === null) continue;
    if (found === null) {
      entry.status = "unconfirmed";
      entry.note = "团队状态里没有同名成员";
      continue;
    }
    const actual = found[entry.stateKey];
    entry.actual = actual ?? null;
    if (actual === undefined || actual === null || actual === "") {
      entry.status = "omitted";
      entry.note = "运行时没有记录该字段";
      continue;
    }
    entry.status = valueMatches(entry.field, entry.requested, actual) ? "applied" : "overridden";
    entry.note = entry.status === "applied" ? "" : "运行时采用了不同的值";
  }
  return binding;
}

/**
 * 生成绑定摘要：按状态统计，供工具输出和索引里的 `binding` 段使用。
 *
 * @param {object} binding
 * @returns {{ counts: Record<string, number>, carried: number, applied: number, degraded: number }}
 */
export function summarizeBinding(binding) {
  const counts = {};
  for (const entry of binding.fields) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  const carried = binding.fields.filter((entry) => entry.param !== null).length;
  const applied = counts.applied ?? 0;
  const degraded = (counts.overridden ?? 0) + (counts.omitted ?? 0) + (counts.unconfirmed ?? 0);
  return { counts, carried, applied, degraded };
}

/** 人读的一行：`model          已应用  deepseek/deepseek-v4.1-flash（来源：member）`。 */
export function describeField(entry) {
  const label = entry.field.padEnd(15, " ");
  const source = entry.source === "defaults" ? "继承 defaults" : "成员自带";
  const value = entry.actual !== null ? entry.actual : entry.requested;
  const rendered =
    entry.field === "systemPrompt"
      ? `${String(value ?? "").length} 字符`
      : value === null || value === undefined
        ? "—"
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
  const note = entry.note === "" ? "" : `（${entry.note}）`;
  return `${label}${BINDING_STATUS[entry.status] ?? entry.status}  ${rendered}  · ${source}${note}`;
}

/**
 * 团队状态是否与档案一致：只统计"被运行时承载"的字段。
 *
 * 存在 overridden / omitted / unconfirmed 时返回 false——降级必须被看见。
 */
export function isBindingFaithful(binding) {
  const summary = summarizeBinding(binding);
  return (summary.counts.overridden ?? 0) === 0 && (summary.counts.unconfirmed ?? 0) === 0;
}

/** `roster:<id>@<version>`——出现在输出、提交信息与绑定记录里的出处标识。 */
export function provenanceOf(roster, member) {
  const suffix = member.inherited?.length ? `+${member.inherited.join(",")}` : "";
  return `roster:${roster.id}@${roster.version}${suffix}`;
}

/**
 * 比较字段值。`reasoningEffort` 容许运行时把 "default" 解析成具体档位，
 * 其余字段要求严格相等：档案说用什么模型，运行时就得记录那个模型。
 */
function valueMatches(field, requested, actual) {
  if (requested === undefined || requested === null) return false;
  if (field === "systemPrompt") return String(requested).trim() === String(actual).trim();
  if (field === "reasoningEffort") {
    if (requested === actual) return true;
    // "default" 表示"由目标模型决定"，运行时落成任何具体档位都算忠实执行。
    return requested === "default" || actual === "default";
  }
  return String(requested) === String(actual);
}
