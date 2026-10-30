import assert from "node:assert/strict";
import test from "node:test";

import { applyCaptain, buildCaptainPrompt, listSessions, pickSessionModel } from "../lib/apply.js";

/** 一份最小的队长档案：只要 id/description/成员与 captain 段。 */
function roster(overrides = {}) {
  return {
    id: "agent-teams",
    title: "Agent Teams",
    description: "四个角色的开发团队",
    members: [
      { name: "team-lead", role: "lead", systemPrompt: "你是团队负责人。" },
      { name: "team-reviewer", role: "review", systemPrompt: "你只做审查。" },
    ],
    captain: { provider: "tsingmicro", model: "deepseek-v4.1-flash", reasoningEffort: "high" },
    ...overrides,
  };
}

/** 记录调用的假 sessionController。 */
function fakeController(overrides = {}) {
  const calls = [];
  const controller = {
    calls,
    async list() {
      calls.push(["list"]);
      return {
        items: [
          {
            sessionId: "s-existing",
            cwd: "/tmp/project",
            updatedAt: 2,
            running: false,
            blank: false,
            projections: {
              kind: "cached",
              asOfSeq: 1,
              values: { modelSelection: { lastUsed: { provider: "p", model: "m", reasoningEffort: "low" } } },
            },
          },
          { sessionId: "s-blank", updatedAt: 1, blank: true },
          { sessionId: "s-child", origin: "subagent" },
        ],
      };
    },
    async create(request) {
      calls.push(["create", request]);
      return { sessionId: "s-created" };
    },
    async selectModel(request) {
      calls.push(["selectModel", request]);
      return { selected: { provider: request.provider, model: request.model } };
    },
    async prompt(request) {
      calls.push(["prompt", request]);
      return { accepted: true };
    },
    ...overrides,
  };
  return controller;
}

test("pickSessionModel 从 projections 里取最后使用的模型", () => {
  const model = pickSessionModel({
    projections: { kind: "cached", asOfSeq: 1, values: { modelSelection: { lastUsed: { provider: "p", model: "m" } } } },
  });
  assert.deepEqual(model, { provider: "p", model: "m", reasoningEffort: "" });
  assert.equal(pickSessionModel({}), null);
});

test("listSessions 过滤子代理会话，并带上模型与 cwd", async () => {
  const result = await listSessions(fakeController());
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ["s-existing", "s-blank"],
  );
  assert.equal(result.sessions[0].cwd, "/tmp/project");
  assert.deepEqual(result.sessions[0].model, { provider: "p", model: "m", reasoningEffort: "low" });
  assert.equal(result.sessions[1].blank, true);
});

test("listSessions 没有 sessionController 时明确报不可用", async () => {
  const result = await listSessions(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-controller-unavailable");
  assert.deepEqual(result.sessions, []);
});

test("buildCaptainPrompt 给出要建的成员，但要求人设从 roster_show 取", () => {
  const prompt = buildCaptainPrompt({ roster: roster() });
  assert.match(prompt, /agent_teams_create/);
  assert.match(prompt, /roster_show/);
  assert.match(prompt, /team-lead \| role: lead/);
  assert.match(prompt, /provenance 写 "roster:agent-teams"/);
  // 人设原文不进提示词，避免把整份档案塞进上下文。
  assert.equal(prompt.includes("你是团队负责人。"), false);
});

test("applyCaptain 走已有会话：切模型 + 排队提示词", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "existing",
    sessionId: "s-existing",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-existing");
  assert.deepEqual(
    controller.calls.map((call) => call[0]),
    ["selectModel", "prompt"],
  );
  const selection = controller.calls[0][1];
  assert.equal(selection.provider, "tsingmicro");
  assert.equal(selection.model, "deepseek-v4.1-flash");
  assert.equal(selection.reasoningEffort, "high");
  const prompt = controller.calls[1][1];
  assert.equal(prompt.sessionId, "s-existing");
  assert.equal(prompt.mode, "queue");
  assert.equal(prompt.content[0].type, "text");
  assert.match(prompt.content[0].text, /roster_show/);
});

test("applyCaptain 新建会话：create 之后再用新 id 切模型并提示", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "new",
    cwd: "D:\\workspace",
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "s-created");
  assert.equal(controller.calls[0][0], "create");
  assert.deepEqual(controller.calls[0][1], { cwd: "D:\\workspace" });
  assert.equal(controller.calls[1][1].sessionId, "s-created");
});

test("applyCaptain 已有会话但没给 sessionId 时拒绝，不猜", async () => {
  const result = await applyCaptain({ sessionController: fakeController(), roster: roster(), mode: "existing" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-session");
});

test("applyCaptain 档案没声明路由时只排队提示词，不碰模型", async () => {
  const controller = fakeController();
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster({ captain: {} }),
    mode: "existing",
    sessionId: "s-existing",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    controller.calls.map((call) => call[0]),
    ["prompt"],
  );
  assert.equal(result.model, null);
});

test("applyCaptain 没有 sessionController 时明确报不可用", async () => {
  const result = await applyCaptain({ sessionController: null, roster: roster(), mode: "new" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-controller-unavailable");
});

test("applyCaptain 切模型失败时如实失败，不继续发提示词", async () => {
  const controller = fakeController({
    async create() {
      return { sessionId: "s-created" };
    },
    async selectModel() {
      throw new Error("session/model-unavailable");
    },
  });
  const result = await applyCaptain({
    sessionController: controller,
    roster: roster(),
    mode: "existing",
    sessionId: "s-existing",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "model-not-applied");
  assert.equal(controller.calls.some((call) => call[0] === "prompt"), false);
});
