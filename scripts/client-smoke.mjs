/**
 * 客户端半边冒烟：在没有浏览器的情况下把 `client.js` 真正加载一次。
 *
 * 它不能代替像素级验证（那要开页面看），但能挡住"模块加载即崩"这一类错误：
 * 顶层代码、`apply()`、三处槽位注册、词典与语言同步、effect 回收，全部真跑一遍。
 *
 * 用法：node scripts/client-smoke.mjs
 */
import assert from "node:assert/strict";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

/** 最小 React 桩：组件不会被渲染，只需要 hooks 与 createElement 存在。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
};

/** 最小 DOM / 模块表桩。 */
const styleNodes = [];
globalThis.document = {
  head: { appendChild: (node) => styleNodes.push(node) },
  createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: "", remove() {} }),
  getElementById: () => null,
  querySelector: () => null,
};
globalThis.window = globalThis;

let loaded = null;
globalThis.__ModuleLoader__ = {
  load({ id, factory }) {
    loaded = { id, factory };
  },
};

globalThis.fetch = async (url) => {
  if (String(url).includes("/locale")) {
    return { ok: true, status: 200, json: async () => ({ settings: { nav: "Agent Roster" }, probe: true }), text: async () => "{}" };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ version: "0.2.0", workspaces: [], teams: { teams: [] }, hints: [] }),
    text: async () => '{"version":"0.2.0","workspaces":[],"teams":{"teams":[]},"hints":[]}',
  };
};

await import(`file://${nodePath.join(root, "client.js").replaceAll("\\", "/")}`);

assert.ok(loaded !== null, "client.js 必须调用 window.__ModuleLoader__.load");
assert.equal(loaded.id, "@stofone/dsh-agent-roster", "模块 id 必须是包名");

const module = loaded.factory((name) => {
  if (name === "react") return React;
  return {};
});
assert.deepEqual(module.inject, ["slots"], "客户端插件必须只依赖 slots");
assert.equal(typeof module.apply, "function", "必须导出 apply");

/** 槽位与上下文桩：注册内容记录下来，供断言检查。 */
const registrations = [];
const injected = [];
const offs = [];
const slotCtx = {
  slots: {
    inject(name, callback) {
      injected.push(name);
      callback();
    },
    register(entry, component) {
      registrations.push({ entry, component });
      return () => {};
    },
  },
  effect(fn) {
    const off = fn();
    if (typeof off === "function") offs.push(off);
  },
  get(name) {
    if (name === "locale") {
      return {
        getLocale: () => ({ active: "zh-CN", locales: ["zh-CN"], revision: 1 }),
        register() {},
        subscribe: () => () => {},
      };
    }
    if (name === "configForms") {
      return {
        get: () => ({
          get: (key) => (key === "language" ? { get: () => "auto" } : undefined),
          subscribe: () => () => {},
          set: () => {},
          getSnapshot: () => ({ value: { language: "auto" } }),
        }),
      };
    }
    if (name === "layout") return { selectPanel() {} };
    return undefined;
  },
};

module.apply(slotCtx);

assert.deepEqual(injected.sort(), ["main", "settings.section", "sidebar.panellist"], "必须注册三处槽位");
const names = registrations.map((item) => item.entry.name).sort();
assert.deepEqual(names, ["main", "settings.section", "sidebar.panellist"]);

const main = registrations.find((item) => item.entry.name === "main");
const sidebar = registrations.find((item) => item.entry.name === "sidebar.panellist");
const section = registrations.find((item) => item.entry.name === "settings.section");
assert.equal(main.entry.key, "agent-roster", "main 槽必须用键控槽");
assert.equal(sidebar.entry.id, "agent-roster", "左栏行 id 必须与 main 的 key 一致");
assert.equal(section.entry.id, "agent-roster", "设置小节同一身份");
for (const item of [main, sidebar, section]) {
  assert.equal(typeof item.component, "function", `${item.entry.name} 必须挂组件`);
}

assert.equal(styleNodes.length, 1, "样式只注入一次");
for (const off of offs) off();

console.log("client smoke: module loaded, three slots registered, styles injected, effects disposable");
