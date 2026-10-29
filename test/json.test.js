/**
 * 无损 JSON 清洗的测试。
 *
 * 背景是一个真机故障：工具返回值里带 `undefined` 属性的键，`JSON.stringify` 会把它丢掉，
 * 运行时往返比对不上，于是整次工具调用报 `value is not lossless JSON`。
 * 这类 bug 单看代码几乎看不出来，只能用"序列化再解析后是否等值"来钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isLossless, lossless } from "../lib/json.js";

test("lossless：对象里的 undefined 键被丢掉", () => {
  const cleaned = lossless({ a: 1, b: undefined, c: null });
  assert.deepEqual(cleaned, { a: 1, c: null });
  assert.equal("b" in cleaned, false);
  assert.equal(isLossless(cleaned).ok, true);
});

test("lossless：嵌套对象与数组都会被递归清洗", () => {
  const cleaned = lossless({
    roster: { id: "r", title: undefined },
    fields: [{ requested: undefined, actual: "x" }, { requested: null, actual: undefined }],
    list: [1, undefined, 3],
  });
  assert.deepEqual(cleaned, {
    roster: { id: "r" },
    fields: [{ actual: "x" }, { requested: null }],
    list: [1, null, 3],
  });
  assert.equal(isLossless(cleaned).ok, true);
});

test("isLossless：原始值形态也算通过", () => {
  assert.equal(isLossless(null).ok, true);
  assert.equal(isLossless("text").ok, true);
  assert.equal(isLossless(0).ok, true);
  assert.equal(isLossless([]).ok, true);
  assert.equal(isLossless({}).ok, true);
});

test("isLossless：抓出带 undefined 的对象并指出路径", () => {
  const bad = { roster: { id: "r" }, members: [{ name: "a", model: undefined }] };
  const check = isLossless(bad);
  assert.equal(check.ok, false);
  assert.match(check.reason, /members\[0\]/);
});

test("isLossless：顶层 undefined 明确判失败，而不是静默通过", () => {
  const check = isLossless(undefined);
  assert.equal(check.ok, false);
  assert.match(check.reason, /不可序列化/);
});

test("lossless 不改变可无损往返的数据", () => {
  const value = { ok: true, rosterId: "core-review", counts: { applied: 2, omitted: 0 }, tags: ["a", "b"] };
  assert.deepEqual(lossless(value), value);
});
