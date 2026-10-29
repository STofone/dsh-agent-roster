/**
 * 配置视图测试：volatile 引用、普通值、缺省三种输入都要读对。
 *
 * 这条路径的 bug 很隐蔽——引用对象直接当值用不会抛错，只会让配置静默失效
 * （面板显示 `{}`、工具永远读默认目录），所以用单测钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { configView } from "../lib/config-view.js";

/** 模拟宿主给 volatile 字段装的引用对象。 */
function ref(value) {
  return { get: () => value, write: () => value };
}

test("视图：普通值原样读出", () => {
  const view = configView({
    rosterDirs: ["a", "b"],
    knownToolPolicies: ["readonly"],
    agentTeamsStateDir: ".state",
    indexes: false,
    region: "china",
  });
  assert.deepEqual(view.rosterDirs, ["a", "b"]);
  assert.deepEqual(view.knownToolPolicies, ["readonly"]);
  assert.equal(view.agentTeamsStateDir, ".state");
  assert.equal(view.indexes, false);
  assert.equal(view.region, "china");
});

test("视图：索引源的三种取值都要原样保留（undefined / 空数组 = 官方源，false = 关掉）", () => {
  assert.equal(configView({}).indexes, undefined);
  assert.deepEqual(configView({ indexes: [] }).indexes, []);
  assert.equal(configView({ indexes: false }).indexes, false);
  assert.deepEqual(configView({ indexes: ref([{ url: "https://example.test/r.json" }]) }).indexes, [
    { url: "https://example.test/r.json" },
  ]);
  assert.equal(configView({ region: ref(undefined) }).region, "auto");
});

test("视图：volatile 引用对象取值，而不是当成普通对象", () => {
  const view = configView({
    rosterDirs: ref(["x"]),
    knownToolPolicies: ref(["policy-a"]),
    agentTeamsStateDir: ref(".agent-teams"),
  });
  assert.deepEqual(view.rosterDirs, ["x"]);
  assert.deepEqual(view.knownToolPolicies, ["policy-a"]);
  assert.equal(view.agentTeamsStateDir, ".agent-teams");
});

test("视图：每次访问都重新取值，设置改了立即生效", () => {
  let current = ["first"];
  const view = configView({ rosterDirs: { get: () => current } });
  assert.deepEqual(view.rosterDirs, ["first"]);
  current = ["second"];
  assert.deepEqual(view.rosterDirs, ["second"]);
});

test("视图：缺省、null、空数组都退回默认值", () => {
  const view = configView({});
  assert.deepEqual(view.rosterDirs, [""]);
  assert.deepEqual(view.knownToolPolicies, []);
  assert.equal(view.agentTeamsStateDir, ".agent-teams");

  const nulled = configView({ rosterDirs: null, knownToolPolicies: ref(null), agentTeamsStateDir: ref("") });
  assert.deepEqual(nulled.rosterDirs, [""]);
  assert.deepEqual(nulled.knownToolPolicies, []);
  assert.equal(nulled.agentTeamsStateDir, ".agent-teams");

  const empty = configView({ rosterDirs: [], agentTeamsStateDir: "" });
  assert.deepEqual(empty.rosterDirs, [""]);
  assert.equal(empty.agentTeamsStateDir, ".agent-teams");
});

test("视图：类型不对时宁可退回默认值，也不把坏值传给扫描器", () => {
  const view = configView({ rosterDirs: "rosters", knownToolPolicies: "readonly", agentTeamsStateDir: 42 });
  assert.deepEqual(view.rosterDirs, [""]);
  assert.deepEqual(view.knownToolPolicies, []);
  assert.equal(view.agentTeamsStateDir, ".agent-teams");
});

test("视图：apply 收到 undefined 也不炸", () => {
  const view = configView(undefined);
  assert.deepEqual(view.rosterDirs, [""]);
  assert.equal(view.agentTeamsStateDir, ".agent-teams");
});
