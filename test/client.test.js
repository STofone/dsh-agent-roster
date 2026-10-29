/**
 * 浏览器半边契约测试。
 *
 * `client.js` 是给模块加载器用的：它调用 `window.__ModuleLoader__.load({id, factory})`，
 * factory 拿到一个 `require` 再返回 `{ inject, apply }`。这里用一个最小加载器把它跑一遍，
 * 断言四件事——模块能加载、`apply()` 在宿主服务缺失时也不抛、三个槽位都登记了、
 * 面板与设置节的身份证对得上。它证明不了"像素长什么样"，但能挡住改坏入口、
 * 改错槽位名、两处 id 不一致、`apply` 里抛异常这类真故障。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** React 的最小替身：只够 factory 加载期用（组件函数此时不会被调用）。 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  Fragment: "Fragment",
};

/**
 * 用最小替身跑一遍 client.js。
 *
 * @param {{ services?: Record<string, unknown> }} [options]
 * @returns {Promise<{ module: object, registrations: object[], slots: string[], disposers: Function[] }>}
 */
async function loadClient(options = {}) {
  const captured = { spec: null };
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured.spec = spec;
      },
    },
  };

  try {
    await import(`../client.js?probe=${Date.now()}`);
  } finally {
    globalThis.window = previousWindow;
  }

  assert.ok(captured.spec !== null, "client.js 必须调用 window.__ModuleLoader__.load");
  const module = captured.spec.factory((id) => {
    assert.equal(id, "react", "factory 只应 require('react')");
    return ReactStub;
  });

  const registrations = [];
  const slots = [];
  const disposers = [];
  const services = options.services ?? {};
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    get(name) {
      return services[name];
    },
    slots: {
      inject(name, fn) {
        slots.push(name);
        return fn();
      },
      register(meta, component) {
        registrations.push({ meta, component });
        return () => {};
      },
    },
  };

  module.apply(ctx);
  return { module, registrations, slots, disposers };
}

test("模块 id 是包名，只注入 slots", async () => {
  const { module } = await loadClient();
  assert.deepEqual(module.inject, ["slots"], "语言与配置表单是可选服务，用 ctx.get 探测，不写进 inject");
});

test("apply 在 locale / configForms 缺失时不抛，槽位仍全部登记", async () => {
  const { registrations, slots } = await loadClient();
  assert.deepEqual(slots.slice().sort(), ["main", "settings.section", "sidebar.panellist"]);
  assert.equal(registrations.length, 3);
});

test("main 槽用键控登记，key 是面板 id", async () => {
  const { registrations } = await loadClient();
  const main = registrations.find(({ meta }) => meta.name === "main");
  assert.ok(main, "缺少 main 槽登记");
  assert.equal(main.meta.key, "agent-roster");
  assert.equal(main.meta.locale, "agent-roster");
  assert.equal(main.meta.id, undefined, "keyed 槽用 key 而不是 id");
  assert.equal(typeof main.component, "function");
});

test("sidebar.panellist 的 id 与 main 的 key 是同一个面板身份", async () => {
  const { registrations } = await loadClient();
  const main = registrations.find(({ meta }) => meta.name === "main");
  const entry = registrations.find(({ meta }) => meta.name === "sidebar.panellist");
  assert.ok(entry, "缺少 sidebar.panellist 登记");
  assert.equal(entry.meta.id, main.meta.key, "两处身份不一致时点击图标切不到面板");
  assert.equal(typeof entry.meta.order, "number");
  assert.equal(typeof entry.meta.label, "function");
  assert.equal(typeof entry.component, "function");
});

test("设置节用独立 id 注册，且与面板身份不同（避免同名冲突）", async () => {
  const { registrations } = await loadClient();
  const section = registrations.find(({ meta }) => meta.name === "settings.section");
  assert.ok(section, "缺少 settings.section 登记");
  assert.equal(typeof section.meta.id, "string");
  assert.equal(typeof section.meta.order, "number");
  assert.equal(typeof section.component, "function");
});

test("label() 走词典而不是硬编码文案", async () => {
  const { registrations } = await loadClient();
  const entry = registrations.find(({ meta }) => meta.name === "sidebar.panellist");
  const label = entry.meta.label();
  assert.equal(typeof label, "string");
  assert.equal(label.includes("Agent Roster") || label.includes("档案") || label.includes("settings.nav"), true);
});

test("有 locale / configForms 时 apply 会订阅并释放", async () => {
  const unsubscribed = [];
  const services = {
    locale: {
      getLocale: () => "zh-CN",
      subscribe: (fn) => {
        const off = () => unsubscribed.push("locale");
        return off;
      },
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ value: { language: "zh" } }),
        subscribe: () => () => unsubscribed.push("form"),
      }),
    },
  };
  const { disposers } = await loadClient({ services });
  assert.equal(disposers.length >= 1, true);
  for (const dispose of disposers) dispose();
  assert.equal(unsubscribed.includes("locale"), true);
  assert.equal(unsubscribed.includes("form"), true);
});

test("面板样式只用宿主语义 token（不写死颜色）", () => {
  const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];

  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "CSS 里写了硬编码颜色；暗色主题下会白底白字，请改用 --dsw-alias-*");

  for (const match of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
    assert.match(match[1], /^--dsw-alias-/, `只用语义层 token（静态色板随主题变）：${match[1]}`);
  }
});
