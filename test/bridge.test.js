/**
 * 桥接与核对测试：参数翻译必须与"每个字段的归宿"严格对应。
 *
 * 这些断言的意义在于防止一种很难发现的退化：桥接参数生成了、看起来一切正常，
 * 但某个字段其实运行时根本不接收，或者运行时静默换了值却没人发现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemberBinding,
  describeField,
  isBindingFaithful,
  provenanceOf,
  reconcileBinding,
  summarizeBinding,
} from "../lib/bridge.js";
import { validateRoster } from "../lib/validate.js";
import { isLossless } from "../lib/json.js";
import { verifyBindings } from "../lib/verify.js";
import { rosterDocument } from "./helpers.js";

/** 校验一份档案并取出指定成员。 */
function rosterWith(memberName, overrides = {}) {
  const result = validateRoster(rosterDocument(overrides), { file: "core-review/roster.yaml" });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const member = result.roster.members.find((candidate) => candidate.name === memberName);
  assert.ok(member, `找不到成员 ${memberName}`);
  return { roster: result.roster, member };
}

test("桥接参数：人设走 executionPrompt，模型与 effort 用工具参数名", () => {
  const { roster, member } = rosterWith("reviewer");
  const { args, planMember } = buildMemberBinding(roster, member);
  assert.equal(args.name, "reviewer");
  assert.equal(args.role, "代码评审");
  assert.equal(args.executionPrompt, member.systemPrompt);
  assert.equal(args.provider, "deepseek");
  assert.equal(args.model, "deepseek-v4.1-flash");
  assert.equal(args.reasoning_effort, "high");
  assert.equal(args.tool_policy, "readonly");
  // plan.members 不支持人设：必须真的不带，而不是带了个被忽略的键
  assert.equal(planMember.executionPrompt, undefined);
  assert.equal(planMember.systemPrompt, undefined);
  assert.equal(planMember.reasoning_effort, "high");
});

test("字段归宿：direct=待回执，declaration=无承载，config=需落配置", () => {
  const result = validateRoster(
    rosterDocument({
      members: [
        {
          name: "reviewer",
          role: "代码评审",
          systemPrompt: "你是严格的代码评审者。",
          fallback: { provider: "openai", model: "gpt-x" },
          toolScope: { allow: ["files:read"] },
          maxTokens: 8192,
        },
        {
          name: "second",
          role: "第二人",
          systemPrompt: "占位成员，避免单成员档案。",
        },
      ],
    }),
    { file: "core-review/roster.yaml" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const member = result.roster.members[0];
  const { binding } = buildMemberBinding(result.roster, member);

  const byField = Object.fromEntries(binding.fields.map((field) => [field.field, field]));
  assert.equal(byField.model.status, "pending");
  assert.equal(byField.systemPrompt.status, "pending");
  assert.equal(byField.systemPrompt.param, "executionPrompt");
  assert.equal(byField.fallback.status, "config-required");
  assert.equal(byField.fallback.param, null);
  assert.equal(byField.toolScope.status, "not-carried");
  assert.equal(byField.maxTokens.status, "not-carried");
});

test("未指定的模型字段标为 omitted：运行时确实会沿用队长默认", () => {
  const document = rosterDocument({ defaults: null });
  document.defaults = {};
  document.members = [
    { name: "bare", role: "无路由", systemPrompt: "没有指定模型。" },
    { name: "other", role: "陪跑", systemPrompt: "陪跑成员，避免单成员档案。" },
  ];
  const validated = validateRoster(document, { file: "x/roster.yaml" });
  assert.equal(validated.ok, true, JSON.stringify(validated.diagnostics));
  const bare = validated.roster.members.find((member) => member.name === "bare");
  const { binding } = buildMemberBinding(validated.roster, bare);
  const model = binding.fields.find((field) => field.field === "model");
  assert.equal(model.status, "omitted");
  // 缺失值必须是 null 而不是 undefined：工具返回值要能无损往返 JSON。
  assert.equal(model.requested, null);
  assert.equal(model.actual, null);
  assert.match(model.note, /沿用队长默认/);
});

test("桥接结果是可无损往返 JSON 的（运行时按 lossless 校验工具输出）", () => {
  const { roster, member } = rosterWith("reviewer");
  const { binding } = buildMemberBinding(roster, member);
  const check = isLossless(binding);
  assert.equal(check.ok, true, check.reason);

  const bare = roster.members.find((item) => item.name === member.name);
  const omitted = buildMemberBinding(roster, { ...bare, model: undefined, provider: undefined }).binding;
  assert.equal(isLossless(omitted).ok, true, isLossless(omitted).reason);
});

test("核对：运行时一致 → applied 且被视为忠实", () => {
  const { roster, member } = rosterWith("reviewer");
  const { binding } = buildMemberBinding(roster, member);
  reconcileBinding(binding, {
    name: "reviewer",
    role: "代码评审",
    executionPrompt: member.systemPrompt,
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    reasoningEffort: "high",
    toolPolicy: "readonly",
  });
  const summary = summarizeBinding(binding);
  assert.equal(summary.counts.applied, 7);
  assert.equal(summary.degraded, 0);
  assert.equal(isBindingFaithful(binding), true);
});

test("核对：模型被运行时换成别的值 → overridden，不算忠实", () => {
  const { roster, member } = rosterWith("reviewer");
  const { binding } = buildMemberBinding(roster, member);
  reconcileBinding(binding, {
    name: "reviewer",
    role: "代码评审",
    executionPrompt: member.systemPrompt,
    provider: "deepseek",
    model: "deepseek-v4.1-mini",
    reasoningEffort: "high",
    toolPolicy: "readonly",
  });
  const model = binding.fields.find((field) => field.field === "model");
  assert.equal(model.status, "overridden");
  assert.equal(model.actual, "deepseek-v4.1-mini");
  assert.equal(isBindingFaithful(binding), false);
  assert.equal(summarizeBinding(binding).degraded, 1);
});

test("核对：运行时没记录 toolPolicy → omitted", () => {
  const { roster, member } = rosterWith("reviewer");
  const { binding } = buildMemberBinding(roster, member);
  reconcileBinding(binding, { name: "reviewer", role: "代码评审", executionPrompt: member.systemPrompt, provider: "deepseek", model: "deepseek-v4.1-flash", reasoningEffort: "high" });
  const toolPolicy = binding.fields.find((field) => field.field === "toolPolicy");
  assert.equal(toolPolicy.status, "omitted");
});

test("核对：团队里没有这个成员 → unconfirmed，绝不假装通过", () => {
  const { roster, member } = rosterWith("reviewer");
  const { binding } = buildMemberBinding(roster, member);
  reconcileBinding(binding, null);
  assert.equal(isBindingFaithful(binding), false);
  const summary = summarizeBinding(binding);
  assert.equal(summary.counts.unconfirmed, 7);
});

test("reasoningEffort=default 时运行时落成具体档位算忠实执行", () => {
  const document = rosterDocument();
  document.members[1].reasoningEffort = "default";
  const validated = validateRoster(document, { file: "core-review/roster.yaml" });
  const member = validated.roster.members.find((candidate) => candidate.name === "release-manager");
  const { binding } = buildMemberBinding(validated.roster, member);
  reconcileBinding(binding, {
    name: "release-manager",
    role: "发布把关",
    executionPrompt: member.systemPrompt,
    provider: "deepseek",
    model: "deepseek-v4.1-pro",
    reasoningEffort: "medium",
  });
  const effort = binding.fields.find((field) => field.field === "reasoningEffort");
  assert.equal(effort.status, "applied");
});

test("provenance 记录出处，含继承字段", () => {
  const { roster, member } = rosterWith("reviewer");
  assert.equal(
    provenanceOf(roster, member),
    "roster:core-review@1.2.0+provider,model,reasoningEffort",
  );
});

test("describeField 输出字段、状态与取值", () => {
  const { roster, member } = rosterWith("reviewer");
  const { binding } = buildMemberBinding(roster, member);
  const line = describeField(binding.fields.find((field) => field.field === "model"));
  assert.match(line, /model/);
  assert.match(line, /deepseek-v4\.1-flash/);
  assert.match(line, /成员自带|继承 defaults/);
});

test("verifyBindings：跨档案汇总一致/降级/未部署/无档案", () => {
  const document = rosterDocument();
  const validated = validateRoster(document, { file: "core-review/roster.yaml" });
  const roster = validated.roster;

  const teams = [
    {
      id: "team-1",
      name: "demo",
      phase: "running",
      file: ".agent-teams/team-1/team.json",
      members: [
        {
          name: "reviewer",
          role: "代码评审",
          executionPrompt: roster.members[0].systemPrompt,
          provider: "deepseek",
          model: "deepseek-v4.1-flash",
          reasoningEffort: "high",
          toolPolicy: "readonly",
        },
        // release-manager 没进团队 → 应报"未部署"
        { name: "stranger", role: "外来成员", provider: "x", model: "y" },
      ],
    },
  ];

  const report = verifyBindings([roster], teams);
  assert.equal(report.checks.length, 2);
  const reviewer = report.checks.find((check) => check.member === "reviewer");
  assert.equal(reviewer.found, true);
  assert.equal(reviewer.faithful, true);
  const releaseManager = report.checks.find((check) => check.member === "release-manager");
  assert.equal(releaseManager.found, false);
  assert.equal(report.summary.faithful, 1);
  assert.equal(report.summary.missing, 1);
  assert.ok(report.unmanaged.some((item) => item.name === "stranger"));
});
