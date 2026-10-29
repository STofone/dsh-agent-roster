/**
 * schema 与运行时常量对齐：这份 JSON Schema 是给编辑器和外部工具看的，
 * 权威校验始终是 `lib/validate.js`。两者一旦漂移，编辑器会给错提示、
 * 外部工具会写出插件拒收的文件——所以用常量反向钉住 schema。
 *
 * @module test/schema
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { CAPTAIN_FIELDS, LIMITS, MEMBER_FIELDS, PATTERNS, REASONING_EFFORTS, ROSTER_FIELDS } from "../lib/format.js";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const schema = JSON.parse(readFileSync(nodePath.join(root, "schema/roster.v1.schema.json"), "utf8"));

test("schema：顶层字段与 ROSTER_FIELDS 一致", () => {
  assert.deepEqual(Object.keys(schema.properties).sort(), [...ROSTER_FIELDS].sort());
});

test("schema：成员字段与 MEMBER_FIELDS 一致", () => {
  assert.deepEqual(Object.keys(schema.$defs.member.properties).sort(), [...MEMBER_FIELDS].sort());
  for (const required of ["name", "role", "systemPrompt"]) {
    assert.ok(schema.$defs.member.required.includes(required), `成员必填字段缺 ${required}`);
  }
});

test("schema：队长字段与 CAPTAIN_FIELDS 一致", () => {
  assert.deepEqual(Object.keys(schema.properties.captain.properties).sort(), [...CAPTAIN_FIELDS].sort());
});

test("schema：数量与长度上限取 LIMITS 的值", () => {
  assert.equal(schema.properties.members.maxItems, LIMITS.members);
  const member = schema.$defs.member.properties;
  assert.equal(member.aliases.maxItems, LIMITS.aliasesPerMember);
  assert.equal(member.skills.maxItems, LIMITS.skillsPerMember);
  assert.equal(member.examples.maxItems, LIMITS.examplesPerMember);
  assert.equal(member.systemPrompt.maxLength, LIMITS.systemPromptChars);
  assert.equal(member.description.maxLength, LIMITS.descriptionChars);
  assert.equal(schema.properties.captain.properties.personaPrefix.maxLength, LIMITS.captainChars);
});

test("schema：枚举与模式来自 format.js，不是另抄一份", () => {
  assert.deepEqual(schema.$defs.effort.enum, REASONING_EFFORTS);
  const idPattern = new RegExp(schema.$defs.id.pattern);
  for (const sample of ["core-review", "a1", "x".repeat(10)]) {
    assert.equal(idPattern.test(sample), PATTERNS.id.test(sample), `id 模式与 PATTERNS.id 不一致：${sample}`);
  }
  const skillPattern = new RegExp(schema.$defs.skill.pattern);
  for (const sample of ["frontend-skill", "eastmoney_quant.v", "-bad"]) {
    assert.equal(
      skillPattern.test(sample),
      PATTERNS.skill.test(sample),
      `skill 模式与 PATTERNS.skill 不一致：${sample}`,
    );
  }
});

test("schema：索引格式引用的是同一套档案字段（$ref 存在）", () => {
  const refs = JSON.stringify(schema).match(/#\/\$defs\/[A-Za-z]+/g) ?? [];
  for (const ref of new Set(refs)) {
    const name = ref.slice("#/$defs/".length);
    assert.ok(schema.$defs[name] !== undefined, `schema 引用了不存在的定义：${ref}`);
  }
});
