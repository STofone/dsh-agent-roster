/**
 * 宿主半边冒烟：用真实的 `defineTool`（来自本机 DSH bundle）注册四个工具，
 * 逐个调用，断言输出**可无损往返 JSON**，并且 `path` 参数真的生效。
 *
 * 这不是单测——单测跑的是纯函数；这里跑的是"注册进宿主之后到底能不能用"，
 * 包括运行时对工具返回值的形状要求。历史上就是这一步抓到 `undefined` 键被拒。
 *
 * 用法：
 *   node scripts/host-smoke.mjs
 *   DSH_TOOLS_MODULE=/abs/path/to/@deepseek-ai/dsh-tools/lib/index.js node scripts/host-smoke.mjs
 *
 * 找不到 bundle 时脚本明确跳过（退出码 0），不让本地环境差异挡住 CI 与单测。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isLossless } from "../lib/json.js";
import { registerRosterTools } from "../lib/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const examples = path.join(root, "examples");

/** 依次尝试：环境变量 → 本机全局 DSH 安装 → 仓库 devDependency。 */
function resolveDefineTool() {
  const candidates = [
    process.env.DSH_TOOLS_MODULE,
    "C:/Users/asdgh/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js",
    path.join(root, "node_modules/@deepseek-ai/dsh-tools/lib/index.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    return candidate;
  }
  return null;
}

const modulePath = resolveDefineTool();
if (modulePath === null) {
  console.log("host smoke: 跳过（找不到 @deepseek-ai/dsh-tools）");
  process.exit(0);
}

const { defineTool } = await import(`file://${modulePath.replaceAll("\\", "/")}`);

/** 收集注册进来的工具定义；effect 需要支持 cleanup 以便断言可回收。 */
const registered = new Map();
const cleanups = [];
const ctx = {
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
  effect(fn) {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  },
  logger: { info() {}, warn() {}, error() {} },
};

const config = {
  rosterDirs: ["rosters"],
  knownToolPolicies: [],
  agentTeamsStateDir: ".agent-teams",
};

registerRosterTools(ctx, config, { version: "0.1.0" });

assert.equal(registered.size, 4, `应注册 4 个工具，实际 ${[...registered.keys()].join(",")}`);

/** 模拟工具执行上下文：会话工作区指向本仓库。 */
const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };

function check(label, value) {
  const result = isLossless(value);
  assert.equal(result.ok, true, `${label}: ${result.reason}`);
}

async function call(name, args) {
  const tool = registered.get(name);
  assert.ok(tool, `未注册 ${name}`);
  // defineTool 不校验参数（校验在运行时的 dispatch 层），这里直接调 execute。
  const value = await tool.execute(args, exec);
  check(name, value);
  const rendered = tool.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} 的 render 必须产出内容块`);
  assert.equal(typeof rendered[0].text, "string");
  return value;
}

// 1. roster_list：显式 path 必须生效（真机 bug 的回归点）。
const listed = await call("roster_list", { path: examples });
assert.equal(listed.stats.total, 2, "examples 下应有 2 份档案");
assert.equal(listed.rootDir, path.resolve(examples), "path 参数必须被采用");

// 2. roster_show：完整读出成员与字段归宿。
const shown = await call("roster_show", { ref: "core-review", path: examples });
assert.equal(shown.found, true);
assert.ok(shown.members.length >= 2);
assert.ok(shown.members.every((member) => Array.isArray(member.binding) && member.binding.length > 0));

// 3. roster_create：产出 agent_teams_add_member 参数。
const created = await call("roster_create", { ref: "research", path: examples });
assert.equal(created.ok, true);
assert.ok(created.calls.length >= 2);
assert.ok(created.calls.every((item) => item.tool === "agent_teams_add_member" && typeof item.arguments.executionPrompt === "string"));

// 4. roster_verify：没有运行时状态时如实降级，而不是假装通过。
const verified = await call("roster_verify", { path: examples, stateDir: path.join(root, "test", "no-such-state") });
assert.equal(typeof verified.summary.members, "number");
assert.equal(verified.summary.deployed, 0, "没有团队状态时不应有已部署成员");
assert.equal(verified.summary.missing, verified.summary.members, "全部成员都应如实标为缺失");

// 5. 清理必须可执行（插件卸载/热重载依赖它）。
for (const cleanup of cleanups) cleanup();
assert.equal(registered.size, 0, "dispose 后不应残留工具");

console.log("host smoke: 4 tools registered, lossless outputs, path override honored, dispose ok");
