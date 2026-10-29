/**
 * 全局档案库位置测试。
 *
 * 规则只有三条，但每一条都影响"文件到底落在哪"，所以钉死：
 * 1. 默认位置 = `<DSH_HOME>/agent-roster`，不跟工作区走；
 * 2. `$DSH_HOME` 可覆盖，`~` 可展开；
 * 3. 只有相对路径才按工作区解析（显式例外）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  displayDshHome,
  globalRosterRoot,
  isGlobalDirSpec,
  resolveDirSpec,
  resolveDshHome,
} from "../lib/home.js";

test("默认数据目录是 ~/.dsh", () => {
  assert.equal(resolveDshHome(undefined, {}), path.join(os.homedir(), ".dsh"));
  assert.equal(globalRosterRoot({}), path.join(os.homedir(), ".dsh", "agent-roster"));
});

test("$DSH_HOME 优先于默认值（docker 挂载点就是靠它）", () => {
  const env = { DSH_HOME: "/data/dsh" };
  assert.equal(resolveDshHome(undefined, env), path.resolve("/data/dsh"));
  assert.equal(globalRosterRoot(env), path.join(path.resolve("/data/dsh"), "agent-roster"));
});

test("显式配置优先于环境变量，并支持 ~ 展开", () => {
  assert.equal(resolveDshHome("~/my-dsh", { DSH_HOME: "/data/dsh" }), path.join(os.homedir(), "my-dsh"));
  assert.equal(resolveDshHome("/opt/dsh", { DSH_HOME: "/data/dsh" }), path.resolve("/opt/dsh"));
});

test("目录配置的全局/工作区判定", () => {
  assert.equal(isGlobalDirSpec(""), true, "空串 = 内置全局库");
  assert.equal(isGlobalDirSpec(undefined), true);
  assert.equal(isGlobalDirSpec("~"), true);
  assert.equal(isGlobalDirSpec("~/lib"), true);
  assert.equal(isGlobalDirSpec(path.resolve("D:/global")), true);
  assert.equal(isGlobalDirSpec("rosters"), false, "相对路径是显式的工作区库");
});

test("解析目录：全局的三种写法都不碰工作区", () => {
  const workspace = path.resolve("D:/ws");
  assert.equal(resolveDirSpec("", workspace, {}), path.join(os.homedir(), ".dsh", "agent-roster"));
  assert.equal(resolveDirSpec("~/lib", workspace, {}), path.join(os.homedir(), "lib"));
  assert.equal(resolveDirSpec(path.resolve("D:/lib"), workspace, {}), path.resolve("D:/lib"));
  assert.equal(resolveDirSpec("examples", workspace, {}), path.resolve("D:/ws", "examples"));
});

test("给用户看的数据目录写法不暴露绝对路径", () => {
  assert.equal(displayDshHome(resolveDshHome(undefined, {}), {}), "~/.dsh");
  const dockerEnv = { DSH_HOME: "/data/dsh" };
  assert.equal(displayDshHome(resolveDshHome(undefined, dockerEnv), dockerEnv), "$DSH_HOME");
});
