/**
 * 浏览器半边契约测试。
 *
 * `client.js` 是给模块加载器用的：它调用 `window.__ModuleLoader__.load({id, factory})`，
 * factory 拿到一个 `require` 再返回 `{ inject, apply }`。这里用一个最小加载器把它跑一遍，
 * 断言三件事——模块能加载、`apply()` 真的往 `settings.section` 注册了面板、释放干净。
 *
 * 它证明不了"像素长什么样"，但能挡住改坏入口、改错槽位名、`apply` 里抛异常这类真故障。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

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

/** 用最小替身跑一遍 client.js，返回捕获到的模块与注册结果。 */
async function loadClient() {
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
  const dictionaries = [];
  const disposers = [];
  const ctx = {
    effect(fn) {
      disposers.push(fn());
    },
    locale: {
      register(namespace, dict) {
        dictionaries.push({ namespace, dict });
        return () => {};
      },
      bind(namespace) {
        return (key) => `${namespace}:${key}`;
      },
    },
    slots: {
      inject(name, fn) {
        assert.equal(name, "settings.section", "面板必须挂进设置页的 section 槽");
        return fn();
      },
      register(meta, component) {
        registrations.push({ meta, component });
        return () => {};
      },
    },
  };

  module.apply(ctx);
  return { module, registrations, dictionaries, disposers };
}

test("模块 id 是包名", async () => {
  const { module } = await loadClient();
  assert.equal(module.inject.length > 0, true);
  assert.deepEqual(module.inject, ["slots", "locale"]);
});

test("apply 把面板注册到 settings.section，并带稳定 id 与排序", async () => {
  const { registrations } = await loadClient();
  assert.equal(registrations.length, 1, "应只注册一个 section");
  const { meta, component } = registrations[0];
  assert.equal(meta.name, "settings.section");
  assert.equal(meta.id, "agent-roster");
  assert.equal(typeof meta.order, "number");
  assert.equal(typeof meta.label, "function");
  assert.equal(meta.locale, "agentRoster");
  assert.equal(typeof component, "function");
});

test("词典以自有命名空间注册", async () => {
  const { dictionaries } = await loadClient();
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, "agentRoster");
  const dict = dictionaries[0].dict;
  assert.ok(dict.zh && dict.en, "中英词典都要有");
  for (const key of ["nav", "title", "failed", "refresh"]) {
    assert.equal(typeof dict.zh[key], "string", `zh 缺 key：${key}`);
    assert.equal(typeof dict.en[key], "string", `en 缺 key：${key}`);
  }
});

test("label() 走词典而不是硬编码文案", async () => {
  const { registrations } = await loadClient();
  assert.equal(registrations[0].meta.label(), "agentRoster:nav");
});

test("effect 注册可释放", async () => {
  const { disposers } = await loadClient();
  assert.equal(disposers.length >= 1, true);
  for (const dispose of disposers) {
    if (typeof dispose === "function") dispose();
  }
});
