/**
 * 路由契约测试：用桩上下文跑 `apply()`，直接调用四个 handler。
 *
 * 它验证的不是"路由存在"，而是"面板真的要用的那几条路径能走通"：
 * 快照、单份原文、保存、删除、导入、方法不符、词典型。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { apply } from "../index.js";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const examples = nodePath.join(root, "examples");

/** 造一个宿主桩：注册的工具与路由都被收集起来，effect 可回收。 */
function makeHost() {
  const routes = new Map();
  const tools = new Map();
  const cleanups = [];
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      // 快照需要一个工作区注册表，否则回退到 process.cwd()（在临时目录里跑会扫错地方）。
      if (name === "workspaceRegistry") return { list: () => [{ title: "test", path: root }] };
      return undefined;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    inject(_deps, callback) {
      callback({
        webServer: {
          register(entry) {
            routes.set(entry.path, entry.handler);
            return () => routes.delete(entry.path);
          },
        },
        // 没有 connection：闸门放行，正好测最简组合。
        effect: ctx.effect,
      });
    },
  };
  return { ctx, routes, tools, cleanups };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: new Map(),
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    },
    end(payload) {
      this.body = payload === undefined ? "" : String(payload);
      this.ended = true;
    },
  };
  return res;
}

function makeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]);
  return Object.assign(stream, {
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
  });
}

async function call(host, path, request) {
  const handler = host.routes.get(path);
  assert.ok(handler, `未注册路由 ${path}`);
  const res = makeRes();
  await handler(request, res);
  const parsed = res.body === "" ? null : JSON.parse(res.body);
  return { status: res.statusCode, headers: res.headers, body: parsed, raw: res.body };
}

const CONFIG = {
  rosterDirs: ["examples"],
  knownToolPolicies: [],
  agentTeamsStateDir: ".agent-teams",
  language: "auto",
};

test("library：200 + 快照里能看到示例库的两份档案", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(host, "/plugins/dsh-agent-roster/library", makeReq());
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.rosters, 2);
  assert.ok(result.body.workspaces.length >= 1);
  assert.deepEqual(
    result.body.workspaces[0].rosters.map((roster) => roster.id).sort(),
    ["core-review", "research"],
  );
  assert.equal(typeof result.body.hints, "object");
  assert.equal(typeof result.body.teams, "object");
});

test("library：方法不符返回 405 且声明 allow", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(host, "/plugins/dsh-agent-roster/library", makeReq({ method: "POST" }));
  assert.equal(result.status, 405);
  assert.equal(result.headers.get("allow"), "GET");
});

test("document：取出原文与解析后的档案", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const result = await call(
    host,
    "/plugins/dsh-agent-roster/document",
    makeReq({ url: `/plugins/dsh-agent-roster/document?rootDir=${encodeURIComponent(examples)}&id=core-review` }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.match(result.raw, /core-review/);
  assert.equal(result.body.roster.id, "core-review");
  assert.ok(result.body.roster.members.length >= 2);
});

test("document：不存在的档案是 404，越界 id 是 400", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const missing = await call(
    host,
    "/plugins/dsh-agent-roster/document",
    makeReq({ url: `/plugins/dsh-agent-roster/document?rootDir=${encodeURIComponent(examples)}&id=nope` }),
  );
  assert.equal(missing.status, 404);
  const unsafe = await call(
    host,
    "/plugins/dsh-agent-roster/document",
    makeReq({ url: "/plugins/dsh-agent-roster/document?id=..%2F..%2Fetc" }),
  );
  assert.equal(unsafe.status, 400);
});

test("locale：返回对应语言词典，未知语言回落到 en", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const expected = JSON.parse(readFileSync(nodePath.join(root, "locale", "zh.json"), "utf8"));
  const zh = await call(host, "/plugins/dsh-agent-roster/locale", makeReq({ url: "/plugins/dsh-agent-roster/locale?lang=zh" }));
  assert.equal(zh.status, 200);
  assert.equal(zh.body.settings.nav, expected.settings.nav);
  const fallback = await call(host, "/plugins/dsh-agent-roster/locale", makeReq({ url: "/plugins/dsh-agent-roster/locale?lang=xx" }));
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.settings.nav, "Agent Roster", "未知语言必须回落到 en");
});

test("rosters：保存、再读、删除一条龙", async () => {
  const temp = mkdtempSync(nodePath.join(tmpdir(), "roster-routes-"));
  try {
    mkdirSync(nodePath.join(temp, "mylib"), { recursive: true });
    const host = makeHost();
    apply(host.ctx, { ...CONFIG, rosterDirs: [temp] });

    const text = [
      "kind: dsh-agent-roster/v1",
      "roster: panel-made",
      "version: 1.0.0",
      "title: Panel made",
      "members:",
      "  - name: scribe",
      "    role: writer",
      "    systemPrompt: |",
      "      Write things down.",
      "",
    ].join("\n");

    const saved = await call(
      host,
      "/plugins/dsh-agent-roster/rosters",
      makeReq({ method: "POST", body: { action: "save", rootDir: temp, text, format: "yaml", overwrite: false } }),
    );
    assert.equal(saved.status, 200, saved.raw);
    assert.equal(saved.body.ok, true);
    assert.equal(readFileSync(nodePath.join(temp, "panel-made", "roster.yaml"), "utf8"), text);

    const again = await call(
      host,
      "/plugins/dsh-agent-roster/rosters",
      makeReq({ method: "POST", body: { action: "save", rootDir: temp, text, format: "yaml", overwrite: false } }),
    );
    assert.equal(again.status, 409, "重复保存必须撞 exists，而不是静默覆盖");

    const removed = await call(
      host,
      "/plugins/dsh-agent-roster/rosters",
      makeReq({ method: "POST", body: { action: "delete", rootDir: temp, id: "panel-made" } }),
    );
    assert.equal(removed.status, 200, removed.raw);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("rosters：非 JSON content-type 是 415，非法动作是 400", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const wrongType = await call(
    host,
    "/plugins/dsh-agent-roster/rosters",
    makeReq({ method: "POST", headers: { "content-type": "text/plain" }, body: { action: "save" } }),
  );
  assert.equal(wrongType.status, 415);

  const badAction = await call(
    host,
    "/plugins/dsh-agent-roster/rosters",
    makeReq({ method: "POST", body: { action: "rename" } }),
  );
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error.code, "unknown-action");
});

test("rosters：越界的 rootDir 不会被当成路径信任", async () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  const outside = await call(
    host,
    "/plugins/dsh-agent-roster/rosters",
    makeReq({
      method: "POST",
      body: { action: "save", rootDir: nodePath.join(root, "no-such-library"), text: "kind: dsh-agent-roster/v1", format: "yaml" },
    }),
  );
  assert.equal(outside.status, 403);
  assert.equal(outside.body.error.code, "unknown-root");
});

test("工具：apply() 之后四个工具都在注册表里", () => {
  const host = makeHost();
  apply(host.ctx, CONFIG);
  assert.deepEqual(
    [...host.tools.keys()].sort(),
    ["roster_create", "roster_list", "roster_show", "roster_verify"],
  );
});
