/**
 * “应用队长档案”：把一份档案搬到某个会话里，让那个会话按档案去建团队。
 *
 * 为什么是这个形态：队长**不是**能被 `agent_teams_add_member` 创建出来的对象，
 * 它就是"创建团队的那个会话"。所以要"应用队长档案"，能做的只有三件事：
 *
 * 1. 选一个会话（已有的，或新建一个）；
 * 2. 把档案声明的模型选到那个会话上（`sessionController.selectModel`）；
 * 3. 往那个会话里排一条提示，让它按档案建团队（`sessionController.prompt`）。
 *
 * 第 2 步是**真的写进运行时**（模型选择是会话级持久投影），第 3 步只是让会话开始干活；
 * 人格（persona）仍然来自部署的 agent preset，档案里只能声明，改不了。
 *
 * 这一层不 import 任何宿主包：`sessionController` 由调用方传进来，方便测试。
 *
 * @module dsh-agent-roster/apply
 */
import { randomUUID } from "node:crypto";

import { MEMBER_FIELDS } from "./format.js";

/**
 * 会话头上的模型投影：`next` 是下一次请求要用的，`lastUsed` 是上一次真正用过的。
 *
 * @param {object | null | undefined} summary `SessionSummary`
 * @returns {{ provider: string, model: string, reasoningEffort: string } | null}
 */
export function pickSessionModel(summary) {
  const values = summary?.projections?.values;
  const projection = values?.modelSelection;
  const selection = projection?.next ?? projection?.lastUsed ?? null;
  if (selection === null || typeof selection !== "object") return null;
  return {
    provider: typeof selection.provider === "string" ? selection.provider : "",
    model: typeof selection.model === "string" ? selection.model : "",
    reasoningEffort: typeof selection.reasoningEffort === "string" ? selection.reasoningEffort : "",
  };
}

/**
 * 列可选会话（剔除子代理会话，它们不是队长候选）。
 *
 * @param {object | null | undefined} sessionController 宿主 `sessionController` 服务
 * @returns {Promise<{ ok: boolean, code?: string, sessions: object[] }>}
 */
export async function listSessions(sessionController) {
  if (sessionController === null || typeof sessionController !== "object" || typeof sessionController.list !== "function") {
    return { ok: false, code: "session-controller-unavailable", sessions: [] };
  }
  try {
    const page = await sessionController.list({});
    const items = Array.isArray(page?.items) ? page.items : [];
    const sessions = items
      .filter((item) => item?.origin !== "subagent")
      .map((item) => ({
        sessionId: String(item.sessionId ?? ""),
        cwd: typeof item.cwd === "string" ? item.cwd : "",
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        running: item.running === true,
        blank: item.blank === true,
        model: pickSessionModel(item),
      }))
      .filter((item) => item.sessionId !== "");
    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, code: "session-list-failed", reason: String(error?.message ?? error), sessions: [] };
  }
}

/**
 * 一段能给会话照着执行的提示词。
 *
 * 只写"要它做什么"和"从哪拿参数"，不复制成员人设原文：人设可能很长，
 * 而 `roster_show` 已经会把它和建员参数一起给出，重复一遍只会浪费上下文。
 *
 * @param {{ roster: object, teamName?: string }} input
 * @returns {string}
 */
export function buildCaptainPrompt(input) {
  const roster = input.roster;
  const id = String(roster?.id ?? "");
  const title = typeof roster?.title === "string" && roster.title !== "" ? roster.title : id;
  const teamName = typeof input.teamName === "string" && input.teamName !== "" ? input.teamName : id;
  const members = Array.isArray(roster?.members) ? roster.members : [];
  const table = members
    .map((member) => {
      const bits = [`name: ${member.name}`, `role: ${member.role}`];
      for (const field of MEMBER_FIELDS) {
        if (field === "name" || field === "role" || field === "systemPrompt") continue;
        const value = member[field];
        if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
        bits.push(`${field}: ${Array.isArray(value) ? value.join(",") : value}`);
      }
      return `- ${bits.join(" | ")}`;
    })
    .join("\n");

  return [
    `请按档案 \`${id}\`（${title}）创建一个多 Agent 团队，队长就是你（当前会话）。`,
    "",
    "步骤：",
    `1. 调用 \`roster_show\`，参数 id: "${id}"。它会给出每个成员的“建员参数”（含人设原文），请以它为准。`,
    `2. 调用 \`agent_teams_create\`，参数 name: "${teamName}"，description 用档案的 description 或你自己概括，approval: "automatic"。`,
    `3. 对每个成员调用 \`agent_teams_add_member\`：name / role / executionPrompt 用人设原文，provider / model / reasoningEffort / toolPolicy 按建员参数填；provenance 写 "roster:${id}"。`,
    `4. 成员都加上后调用 \`roster_verify\`（teamId 用上一步返回的团队 id），确认每个成员的字段是否如实进了运行时。`,
    "5. 把核对结果摘要给我（哪几个成员、哪些字段 not-carried），不要粘贴成员人设原文。",
    "",
    "本次要建的成员：",
    table === "" ? "- （档案里没有成员）" : table,
    "",
    "注意：你的模型/人格不来自这份档案——档案的 captain 段只是声明；要改队长本身，得改部署配置里的 agent-default-model 与 preset persona。档案里的成员模型/provider 若与事实不符，以档案为准去 add_member，不要臆造。",
  ].join("\n");
}

/**
 * 把档案“应用”到一个会话：新建或复用会话 → 选模型 → 排提示。
 *
 * @param {object} input
 * @param {object | null | undefined} input.sessionController 宿主 `sessionController` 服务
 * @param {object} input.roster 已校验的档案（含 captain 段）
 * @param {"new" | "existing"} input.mode
 * @param {string} [input.sessionId] `existing` 时必填
 * @param {string} [input.cwd] `new` 时可指定会话工作目录，缺省用当前工作区
 * @param {string} [input.requestId] 便于测试固定 requestId
 * @returns {Promise<object>}
 */
export async function applyCaptain(input) {
  const sessionController = input.sessionController;
  if (
    sessionController === null ||
    typeof sessionController !== "object" ||
    typeof sessionController.create !== "function" ||
    typeof sessionController.prompt !== "function"
  ) {
    return { ok: false, code: "session-controller-unavailable" };
  }

  const roster = input.roster;
  const captain = roster?.captain ?? {};
  const mode = input.mode === "new" ? "new" : "existing";

  let sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (mode === "new") {
    try {
      const created = await sessionController.create(input.cwd ? { cwd: input.cwd } : {});
      sessionId = String(created?.sessionId ?? "");
    } catch (error) {
      return { ok: false, code: "session-create-failed", reason: String(error?.message ?? error) };
    }
    if (sessionId === "") return { ok: false, code: "session-create-failed" };
  } else if (sessionId === "") {
    return { ok: false, code: "missing-session" };
  }

  let model = null;
  const provider = typeof captain.provider === "string" ? captain.provider : "";
  const modelId = typeof captain.model === "string" ? captain.model : "";
  if (provider !== "" && modelId !== "") {
    if (typeof sessionController.selectModel !== "function") {
      return { ok: false, code: "model-selection-unavailable", sessionId };
    }
    const selection = { sessionId, provider, model: modelId };
    const effort = typeof captain.reasoningEffort === "string" ? captain.reasoningEffort : "";
    if (effort !== "" && effort !== "default") selection.reasoningEffort = effort;
    try {
      const applied = await sessionController.selectModel(selection);
      model = applied?.selected ?? { provider, model: modelId, reasoningEffort: selection.reasoningEffort ?? "" };
    } catch (error) {
      // 选不上就**不要**继续排提示：那样会建出一个模型与档案不符的团队，比直接失败更难查。
      return { ok: false, code: "model-not-applied", sessionId, reason: String(error?.message ?? error) };
    }
  }

  try {
    await sessionController.prompt({
      requestId: typeof input.requestId === "string" && input.requestId !== "" ? input.requestId : randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: buildCaptainPrompt({ roster, teamName: input.teamName }) }],
    });
  } catch (error) {
    return { ok: false, code: "prompt-not-queued", sessionId, reason: String(error?.message ?? error) };
  }

  return { ok: true, sessionId, model, queued: true, mode };
}
