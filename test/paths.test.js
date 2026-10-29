/**
 * 路径解析测试。
 *
 * 真机 bug：`roster_list` 传了 `path` 却仍扫配置目录，因为 `resolvePaths` 根本没看参数。
 * 这种"参数被静默忽略"最难发现——工具不报错，只是读了错的地方。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { globalRosterRoot } from "../lib/home.js";
import { resolvePaths } from "../lib/tools.js";

/** 伪造执行上下文：只有会话工作区是有意义的字段。 */
function execAt(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

test("相对 path 相对会话工作区解析", () => {
  const resolved = resolvePaths({ rosterDirs: ["rosters"] }, execAt("D:/ws"), "examples");
  assert.equal(resolved.rosterDir, path.resolve("D:/ws", "examples"));
  assert.equal(resolved.overridden, true);
});

test("绝对 path 原样采用，不被工作区拼接", () => {
  const absolute = path.resolve("D:/somewhere/else");
  const resolved = resolvePaths({ rosterDirs: ["rosters"] }, execAt("D:/ws"), absolute);
  assert.equal(resolved.rosterDir, absolute);
});

test("没有 path 时用配置第一项", () => {
  const resolved = resolvePaths({ rosterDirs: ["library", "other"] }, execAt("D:/ws"));
  assert.equal(resolved.rosterDir, path.resolve("D:/ws", "library"));
  assert.equal(resolved.overridden, false);
});

test("空 path 视为未给，不覆盖配置", () => {
  assert.equal(resolvePaths({ rosterDirs: ["rosters"] }, execAt("D:/ws"), "").overridden, false);
  assert.equal(resolvePaths({ rosterDirs: ["rosters"] }, execAt("D:/ws"), undefined).overridden, false);
});

test("缺配置时用全局默认库，不跟工作区走", () => {
  assert.equal(resolvePaths({}, execAt("D:/ws")).rosterDir, globalRosterRoot());
});

test("显式绝对/~/全局默认三种写法都不拼工作区", () => {
  assert.equal(resolvePaths({ rosterDirs: [""] }, execAt("D:/ws")).rosterDir, globalRosterRoot());
  assert.equal(
    resolvePaths({ rosterDirs: [path.resolve("D:/global/lib")] }, execAt("D:/ws")).rosterDir,
    path.resolve("D:/global/lib"),
  );
  assert.equal(
    resolvePaths({ rosterDirs: ["~/my-rosters"] }, execAt("D:/ws")).rosterDir,
    path.join(os.homedir(), "my-rosters"),
  );
});

test("拿不到会话工作区时退回进程工作目录，并标注未知", () => {
  const resolved = resolvePaths({ rosterDirs: ["rosters"] }, {});
  assert.equal(resolved.workspaceKnown, false);
  assert.equal(resolved.workspace, process.cwd());
  assert.equal(resolved.rosterDir, path.resolve(process.cwd(), "rosters"));
});
