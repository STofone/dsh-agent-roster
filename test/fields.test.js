/**
 * 声明层字段与队长段：这些字段运行时不会真的执行，所以更容易"写了却没人管"。
 *
 * 这里逐条钉住三件事：
 * - schema 收下它们（并在写错时明确拒绝）；
 * - 核对时它们不出现在"一致/降级"里，另立技能核对与队长说明；
 * - 曾用名参与匹配，否则成员一改名就满屏假报警。
 *
 * @module test/fields
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMemberBinding } from "../lib/bridge.js";
import { renderCaptainSection, renderRosterDetail, renderVerifyReport } from "../lib/render.js";
import { validateRoster } from "../lib/validate.js";
import { verifyBindings } from "../lib/verify.js";
import { rosterDocument } from "./helpers.js";

/** 造一份带新字段的两成员档案。 */
function validated(overrides = {}) {
  const document = rosterDocument({
    members: [
      {
        name: "reviewer",
        role: "代码评审",
        systemPrompt: "你是严格的代码评审者。",
        toolPolicy: "readonly",
        description: "负责代码评审，不负责发布。",
        aliases: ["code-reviewer"],
        skills: ["frontend-skill", "cordis-plugin-development"],
        examples: ["帮我审一下 lib/validate.js", "这个改动有什么语义错误"],
      },
      {
        name: "release-manager",
        role: "发布把关",
        systemPrompt: "你负责核对变更与回滚方案。",
      },
    ],
    ...overrides,
  });
  return validateRoster(document, { file: "core-review/roster.yaml" });
}

test("成员声明字段：description / aliases / skills / examples 被保留", () => {
  const result = validated();
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const member = result.roster.members[0];
  assert.equal(member.description, "负责代码评审，不负责发布。");
  assert.deepEqual(member.aliases, ["code-reviewer"]);
  assert.deepEqual(member.skills, ["frontend-skill", "cordis-plugin-development"]);
  assert.equal(member.examples.length, 2);
});

test("成员声明字段：不会混进桥接参数的直接字段", () => {
  const result = validated();
  const member = result.roster.members[0];
  const { args, binding } = buildMemberBinding(result.roster, member);
  assert.equal(args.description, undefined);
  assert.equal(args.aliases, undefined);
  const byField = Object.fromEntries(binding.fields.map((field) => [field.field, field]));
  assert.equal(byField.skills.status, "not-carried");
  assert.equal(byField.aliases.status, "not-carried");
});

test("技能名不合法 → 明确拒绝，而不是悄悄收下", () => {
  const document = rosterDocument({
    members: [{ name: "reviewer", role: "评审", systemPrompt: "做事。", skills: ["Frontend Skill"] }],
  });
  const result = validateRoster(document, { file: "x/roster.yaml" });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-skill"));
});

test("别名撞现有成员名 → alias-collision", () => {
  const document = rosterDocument({
    members: [
      { name: "reviewer", role: "评审", systemPrompt: "做事。", aliases: ["release-manager"] },
      { name: "release-manager", role: "发布", systemPrompt: "做事。" },
    ],
  });
  const result = validateRoster(document, { file: "x/roster.yaml" });
  assert.equal(result.ok, false);
  const collision = result.diagnostics.find((item) => item.code === "alias-collision");
  assert.ok(collision);
  assert.match(collision.reason, /release-manager/);
});

test("两名成员用同一个别名 → 也拒绝（否则核对结果取决于遍历顺序）", () => {
  const document = rosterDocument({
    members: [
      { name: "a-member", role: "甲", systemPrompt: "做事。", aliases: ["old-name"] },
      { name: "b-member", role: "乙", systemPrompt: "做事。", aliases: ["old-name"] },
    ],
  });
  const result = validateRoster(document, { file: "x/roster.yaml" });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "alias-collision"));
});

test("captain 段：合法时归一化并与成员分开", () => {
  const result = validated({
    captain: {
      name: "lead",
      description: "主会话即队长",
      personaPrefix: "你在派活前先复述目标。",
      provider: "tsingmicro",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const captain = result.roster.captain;
  assert.equal(captain.name, "lead");
  assert.equal(captain.provider, "tsingmicro");
  assert.equal(captain.reasoningEffort, "high");
  assert.equal(result.roster.members.length, 2, "队长不能被算成一个成员");
});

test("captain 段：缺 name → 报错；provider 没有 model → 报错", () => {
  const missingName = validated({ captain: { description: "没有名字" } });
  assert.equal(missingName.ok, false);
  assert.ok(missingName.diagnostics.some((item) => item.code === "missing-field" && item.path === "captain.name"));

  const halfRoute = validated({ captain: { name: "lead", provider: "tsingmicro" } });
  assert.equal(halfRoute.ok, false);
  assert.ok(halfRoute.diagnostics.some((item) => item.path === "captain.model"));
});

test("队长说明：写明它由 profile 决定，并给出可复制的片段", () => {
  const result = validated({
    captain: { name: "lead", provider: "tsingmicro", model: "deepseek-v4.1-flash" },
  });
  const lines = renderCaptainSection(result.roster.captain).join("\n");
  assert.match(lines, /队长/);
  assert.match(lines, /profile/);
  assert.match(lines, /agent-default-model/);
  assert.match(lines, /tsingmicro/);
});

test("核对：团队里记的是曾用名，仍算这名成员（并标出 matchedAs）", () => {
  const result = validated();
  const roster = result.roster;
  const teams = [
    {
      id: "team-1",
      name: "demo",
      phase: "running",
      file: ".agent-teams/team-1/team.json",
      members: [
        {
          name: "code-reviewer",
          role: "代码评审",
          executionPrompt: roster.members[0].systemPrompt,
          provider: "deepseek",
          model: "deepseek-v4.1-flash",
          reasoningEffort: "high",
          toolPolicy: "readonly",
        },
      ],
    },
  ];
  const report = verifyBindings([roster], teams);
  const check = report.checks.find((item) => item.member === "reviewer");
  assert.equal(check.found, true);
  assert.equal(check.matchedAs, "code-reviewer");
  assert.equal(check.faithful, true);
  // 曾用名不能同时被算成"无档案成员"
  assert.equal(report.unmanaged.length, 0);
});

test("核对：技能声明与宿主目录对不上 → 只报技能缺失，不冒充降级", () => {
  const result = validated();
  const roster = result.roster;
  const report = verifyBindings([roster], [], { knownSkills: ["frontend-skill"] });
  assert.equal(report.summary.degraded, 0);
  assert.equal(report.summary.skillsDeclared, 1);
  assert.equal(report.summary.skillsMissing, 1);
  const skills = report.skills[0];
  assert.deepEqual(skills.declared, ["frontend-skill", "cordis-plugin-development"]);
  assert.deepEqual(skills.missing, ["cordis-plugin-development"]);
  assert.equal(skills.checked, true);
});

test("核对：没有技能目录时如实标成无法核对", () => {
  const result = validated();
  const report = verifyBindings([result.roster], []);
  assert.equal(report.skills[0].checked, false);
  assert.deepEqual(report.skills[0].missing, []);
  assert.equal(report.summary.skillsUnverified, 1);
});

test("人读渲染：成员卡显示声明字段，核对报告带技能段", () => {
  const result = validated();
  const detail = renderRosterDetail(result.roster);
  assert.match(detail, /aliases/);
  assert.match(detail, /改名前的旧名/);
  assert.match(detail, /skills/);
  assert.match(detail, /仅声明/);
  assert.match(detail, /examples/);

  const report = verifyBindings([result.roster], [], { knownSkills: ["frontend-skill"] });
  const text = renderVerifyReport(report);
  assert.match(text, /技能声明核对/);
  assert.match(text, /cordis-plugin-development/);
});
