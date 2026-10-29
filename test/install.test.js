/**
 * 一键拉取：把公共目录里的档案落到本机档案库。
 *
 * 这里锁的是"用户资产不被静默改写"这条产品语义：
 * - 第一次点 → 写入；
 * - 再点一次（内容没变）→ unchanged，不写盘、不留备份；
 * - 本地改过、远端没变 → conflict，默认**不**覆盖；
 * - 显式 overwrite → updated。
 *
 * 全程用假 fetch，不联网：这类测试一旦联网，失败原因就从"逻辑错了"变成"今天网好不好"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installCollection } from "../lib/service.js";

const REGISTRY = {
  kind: "dsh-agent-roster-registry/v1",
  version: 1,
  collections: [
    {
      id: "demo",
      title: "演示目录",
      repo: "github:acme/demo",
      ref: "main",
      path: "rosters",
      rosters: ["alpha"],
    },
  ],
};

const ROSTER = `kind: dsh-agent-roster/v1
roster: alpha
version: 1.0.0
title: 演示档案
description: 只有一名成员的演示
members:
  - name: lead
    role: 队长
    systemPrompt: 你负责编排。
`;

/** 造一个只认识那两份文件的假 fetch。 */
function fakeFetch(rosterText = ROSTER) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/index/registry.json")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => JSON.stringify(REGISTRY),
      };
    }
    if (String(url).endsWith("/alpha/roster.yaml")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => rosterText,
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      text: async () => "not found",
    };
  };
  impl.calls = calls;
  return impl;
}

function tempLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roster-install-"));
  return { root, cacheDir: path.join(root, ".index-cache") };
}

const config = (lib) => ({
  rosterDirs: [lib.root],
  indexes: [],
  knownToolPolicies: null,
});

/** 本机库里的档案文件（拉取落盘是 JSON）。 */
function localFile(lib, id) {
  const dir = path.join(lib.root, id);
  const name = fs.readdirSync(dir).find((item) => item.startsWith("roster."));
  return path.join(dir, name);
}

/** 模拟用户改过本地档案：只动标题，保证文档仍然合法。 */
function editTitle(file, title) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  document.title = title;
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

test("第一次拉取把档案写进本机档案库", async () => {
  const lib = tempLibrary();
  const result = await installCollection(config(lib), {
    collectionId: "demo",
    fetchImpl: fakeFetch(),
    cacheDir: lib.cacheDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.written, 1);
  assert.deepEqual(
    result.results.map((item) => [item.id, item.action]),
    [["alpha", "created"]],
  );
  const file = localFile(lib, "alpha");
  assert.equal(fs.existsSync(file), true);
  assert.match(fs.readFileSync(file, "utf8"), /"roster": "alpha"/);
});

test("重复拉取同一版本是幂等的（unchanged，不写盘）", async () => {
  const lib = tempLibrary();
  const deps = { collectionId: "demo", fetchImpl: fakeFetch(), cacheDir: lib.cacheDir };
  await installCollection(config(lib), deps);
  const again = await installCollection(config(lib), deps);

  assert.equal(again.ok, true);
  assert.equal(again.written, 0);
  assert.equal(again.unchanged, 1);
  assert.deepEqual(
    again.results.map((item) => item.action),
    ["unchanged"],
  );
});

test("本地改过、远端没变：默认冲突而不是覆盖", async () => {
  const lib = tempLibrary();
  const deps = { collectionId: "demo", fetchImpl: fakeFetch(), cacheDir: lib.cacheDir };
  await installCollection(config(lib), deps);

  const file = localFile(lib, "alpha");
  editTitle(file, "我改过的标题");

  const conflicted = await installCollection(config(lib), deps);
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.conflicts, 1);
  assert.equal(conflicted.results[0].action, "conflict");
  assert.match(fs.readFileSync(file, "utf8"), /我改过的标题/);
});

test("显式 overwrite 才覆盖本地改动", async () => {
  const lib = tempLibrary();
  const deps = { collectionId: "demo", fetchImpl: fakeFetch(), cacheDir: lib.cacheDir };
  await installCollection(config(lib), deps);

  const file = localFile(lib, "alpha");
  editTitle(file, "我改过的标题");

  const replaced = await installCollection(config(lib), { ...deps, overwrite: true });
  assert.equal(replaced.ok, true);
  assert.deepEqual(
    replaced.results.map((item) => item.action),
    ["updated"],
  );
  assert.match(fs.readFileSync(file, "utf8"), /演示档案/);
});

test("目录里没有这个 collection 时明确报错并列出已知项", async () => {
  const lib = tempLibrary();
  const result = await installCollection(config(lib), {
    collectionId: "no-such",
    fetchImpl: fakeFetch(),
    cacheDir: lib.cacheDir,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "collection-not-found");
  assert.deepEqual(result.known, ["demo"]);
});

test("远端某一份档案不合法时：不写盘，并把校验错误带回给调用方", async () => {
  const lib = tempLibrary();
  const broken = "kind: dsh-agent-roster/v1\nroster: alpha\nmembers: []\n";
  const result = await installCollection(config(lib), {
    collectionId: "demo",
    fetchImpl: fakeFetch(broken),
    cacheDir: lib.cacheDir,
  });

  assert.equal(result.written, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, []);
  assert.ok(result.diagnostics.some((item) => item.severity === "error"));
});
