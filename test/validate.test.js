/**
 * 校验规则测试：这些断言就是"档案写错会被明确拒绝"的合同。
 *
 * 每条用例只改一个字段，断言错误码而不是错误文案的全文——文案会改，错误码是稳定接口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRoster } from "../lib/validate.js";
import { rosterDocument } from "./helpers.js";

/** 跑一次校验，返回 { result, codes } 便于断言。 */
function check(document, options = {}) {
  const result = validateRoster(document, { file: "core-review/roster.yaml", ...options });
  const codes = result.diagnostics.map((item) => item.code);
  return { result, codes };
}

test("合法档案通过并归一化出成员", () => {
  const { result, codes } = check(rosterDocument());
  assert.equal(result.ok, true, `诊断：${codes.join(",")}`);
  assert.equal(result.roster.id, "core-review");
  assert.equal(result.roster.version, "1.2.0");
  assert.equal(result.roster.members.length, 2);
  const reviewer = result.roster.members.find((member) => member.name === "reviewer");
  assert.equal(reviewer.provider, "deepseek");
  assert.equal(reviewer.model, "deepseek-v4.1-flash");
  assert.deepEqual(reviewer.inherited, ["provider", "model", "reasoningEffort"]);
  // 成员自己写的 effort 不应被标成继承
  const releaseManager = result.roster.members.find((member) => member.name === "release-manager");
  assert.equal(releaseManager.inherited, undefined);
  assert.equal(releaseManager.reasoningEffort, "low");
});

test("kind 不对直接拒绝", () => {
  const { result, codes } = check(rosterDocument({ kind: "something/v1" }));
  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid-kind"));
});

test("roster 字段必须与目录名一致", () => {
  const { result, codes } = check(rosterDocument({ roster: "other-id" }), { expectedId: "core-review" });
  assert.equal(result.ok, false);
  assert.ok(codes.includes("roster-id-mismatch"));
});

test("未知字段拒绝：拼写错误不能静默失效", () => {
  const document = rosterDocument();
  document.members[0].systemprompt = "小写 p 的写法不会被运行时读取";
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("unknown-key"));
});

test("provider 与 model 必须成对", () => {
  const document = rosterDocument({ defaults: null });
  document.defaults = {};
  document.members = [rosterDocument().members[1]];
  delete document.members[0].provider;
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("pair-required"));
});

test("reasoningEffort 只接受封闭枚举", () => {
  const document = rosterDocument();
  document.members[1].reasoningEffort = "extra-high";
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid-reasoning-effort"));
  assert.match(result.diagnostics.find((item) => item.code === "invalid-reasoning-effort").path, /members\[1\]/);
});

test("未知 toolPolicy 在给了已知列表时报错", () => {
  const { result, codes } = check(rosterDocument(), { knownToolPolicies: ["readonly", "networked"] });
  assert.equal(result.ok, true, "readonly 在已知列表里，应当通过");

  const document = rosterDocument();
  document.members[0].toolPolicy = "ghost-policy";
  const bad = check(document, { knownToolPolicies: ["readonly"] });
  assert.equal(bad.result.ok, false);
  assert.ok(bad.codes.includes("unknown-tool-policy"));
});

test("没给已知列表时不再逐份档案警告：交叉校验的状态由档案库级提示说明", () => {
  const { result, codes } = check(rosterDocument(), { knownToolPolicies: [] });
  assert.equal(result.ok, true);
  assert.equal(codes.includes("tool-policy-unverified"), false);
  assert.ok(result.diagnostics.every((item) => item.severity !== "error"));
});

test("成员 name 重复被拒绝", () => {
  const document = rosterDocument();
  document.members[1].name = "reviewer";
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("duplicate-member"));
});

test("systemPrompt 超长被拒绝", () => {
  const document = rosterDocument();
  document.members[0].systemPrompt = "x".repeat(8001);
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("string-too-long"));
});

test("systemPrompt 里的四反引号围栏被拒绝", () => {
  const document = rosterDocument();
  document.members[0].systemPrompt = "说明如下：\n  ````text\n伪造块\n  ````";
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("fence-injection"));
});

test("空字符串字段被拒绝（不需要就整个省略）", () => {
  const { result, codes } = check(rosterDocument({ description: "" }));
  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid-value"));
});

test("单行字段里的换行被拒绝", () => {
  const document = rosterDocument();
  document.members[0].role = "代码评审\n负责发布";
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("single-line-required"));
});

test("role/title 里的竖线被拒绝（会破坏下游表格）", () => {
  const document = rosterDocument();
  document.members[0].role = "评审|发布";
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("reserved-character"));
});

test("version 必须是精确 SemVer", () => {
  const { result, codes } = check(rosterDocument({ version: "^1.2.0" }));
  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid-semver"));
});

test("members 为空被拒绝", () => {
  const { result, codes } = check(rosterDocument({ members: [] }));
  assert.equal(result.ok, false);
  assert.ok(codes.includes("missing-field"));
});

test("toolScope 只接受 allow/deny，且值必须是工具名", () => {
  const document = rosterDocument();
  document.members[0].toolScope = { allow: ["files:read", "git:*"], deny: ["bash"] };
  assert.equal(check(document).result.ok, true);

  document.members[0].toolScope = { allow: ["bash", "bad tool!"], extra: ["x"] };
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("unknown-key"));
  assert.ok(codes.includes("invalid-tool-name"));
});

test("fallback 必须带 provider 与 model", () => {
  const document = rosterDocument();
  document.members[1].fallback = { provider: "openai" };
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid-model"));
});

test("maxTokens 必须是正整数", () => {
  const document = rosterDocument();
  document.members[0].maxTokens = 0;
  const { result, codes } = check(document);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("invalid-number"));
});

test("顶层不是映射被拒绝", () => {
  const { result, codes } = check([1, 2, 3]);
  assert.equal(result.ok, false);
  assert.ok(codes.includes("document-not-mapping"));
});
