/**
 * 工具层契约测试。
 *
 * 这里锁的是两件在真机上翻过车的事：
 * 1. 模型读到的是 `render()` 产出的文本，不是返回对象——所以每个工具的首行必须是
 *    可解析的 `k=v` 状态行，否则"成功没有"只能靠中文措辞去猜。
 * 2. 返回值必须能无损往返 JSON，否则运行时会整次拒绝（`value is not lossless JSON`）。
 *
 * 依赖 `@deepseek-ai/dsh-tools`（devDependency）提供真实的 `defineTool`；
 * 版本与宿主未必一致，所以这里只断言形状契约，不断言宿主内部行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isLossless } from "../lib/json.js";
import { registerRosterTools } from "../lib/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "examples");

/** 用最小的假 ctx 注册工具，返回 name → tool 的映射。 */
function register() {
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    effect(fn) {
      disposers.push(fn());
    },
  };
  registerRosterTools(ctx, { rosterDirs: ["rosters"], knownToolPolicies: [], agentTeamsStateDir: ".agent-teams" }, { version: "0.1.0" });
  return { tools, disposers };
}

const exec = { agent: { session: { header: { cwd: root } } } };

/** 调一次工具，返回返回值与首行文本；顺带断言无损与渲染形状。 */
async function call(tools, name, args) {
  const tool = tools.get(name);
  assert.ok(tool, `未注册 ${name}`);
  const value = await tool.execute(args, exec);

  const losslessCheck = isLossless(value);
  assert.equal(losslessCheck.ok, true, `${name} 返回值不可无损往返：${losslessCheck.reason}`);

  const blocks = tool.output.render(args, value);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} 必须渲染出内容块`);
  assert.equal(typeof blocks[0].text, "string");
  const firstLine = blocks[0].text.split("\n")[0];
  assert.match(firstLine, new RegExp(`^\\[${name}\\] `), `${name} 首行应是 [${name}] 状态行，实际：${firstLine}`);
  return { value, firstLine, text: blocks[0].text };
}

test("注册四个工具，且每个都能在 examples 上执行", async () => {
  const { tools } = register();
  assert.deepEqual([...tools.keys()].sort(), ["roster_create", "roster_list", "roster_show", "roster_verify"]);

  const list = await call(tools, "roster_list", { path: examples });
  assert.match(list.firstLine, /total=2/);
  assert.match(list.firstLine, /ok=2/);

  const show = await call(tools, "roster_show", { ref: "core-review", path: examples });
  assert.match(show.firstLine, /found=true/);
  assert.match(show.firstLine, /members=3/);

  const create = await call(tools, "roster_create", { ref: "research", path: examples });
  assert.match(create.firstLine, /ok=true/);
  assert.match(create.firstLine, /calls=2/);

  const verify = await call(tools, "roster_verify", { path: examples, stateDir: path.join(root, "test", "no-such-state") });
  assert.match(verify.firstLine, /state=unavailable/);
  assert.match(verify.firstLine, /missing=5/);
});

test("找不到档案时也是同一套状态行，而不是自由文本", async () => {
  const { tools } = register();
  const show = await call(tools, "roster_show", { ref: "no-such-roster", path: examples });
  assert.equal(show.value.found, false);
  assert.match(show.firstLine, /found=false/);

  const create = await call(tools, "roster_create", { ref: "no-such-roster", path: examples });
  assert.equal(create.value.ok, false);
  assert.match(create.firstLine, /ok=false/);
});

test("显式 path 覆盖配置目录（真机回归点）", async () => {
  const { tools } = register();
  const byDefault = await call(tools, "roster_list", {});
  assert.equal(byDefault.value.rootDir, path.resolve(root, "rosters"), "默认应走配置的 rosters");

  const overridden = await call(tools, "roster_list", { path: examples });
  assert.equal(overridden.value.rootDir, path.resolve(examples));
  assert.match(overridden.firstLine, /total=2/);
});

test("释放后不残留工具", () => {
  const { tools, disposers } = register();
  assert.equal(tools.size, 4);
  for (const dispose of disposers) dispose();
  assert.equal(tools.size, 0);
});
