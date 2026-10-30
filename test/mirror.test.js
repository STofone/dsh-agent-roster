/**
 * 自定义镜像地址：规整与优先级。
 *
 * 这条路径出错不会抛异常，只会让"填了镜像"静默失效——继续走默认 registry，
 * 于是用户以为自己在用公司 Nexus，其实一直在出网拉 npmjs。所以钉死优先级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { NPM_REGISTRIES, normalizeRegistryUrl, resolveRegistryRoot } from "../lib/remote.js";

test("镜像地址：去掉首尾空白与尾斜杠，保留路径前缀", () => {
  assert.equal(normalizeRegistryUrl("https://registry.npmmirror.com"), "https://registry.npmmirror.com");
  assert.equal(normalizeRegistryUrl("  https://registry.npmmirror.com/  "), "https://registry.npmmirror.com");
  assert.equal(
    normalizeRegistryUrl("http://nexus.corp.local/repository/npm/"),
    "http://nexus.corp.local/repository/npm",
  );
});

test("镜像地址：非 http(s) 与空值一律视为没填", () => {
  assert.equal(normalizeRegistryUrl(""), null);
  assert.equal(normalizeRegistryUrl("   "), null);
  assert.equal(normalizeRegistryUrl(undefined), null);
  assert.equal(normalizeRegistryUrl(null), null);
  assert.equal(normalizeRegistryUrl(42), null);
  assert.equal(normalizeRegistryUrl("registry.npmmirror.com"), null);
  assert.equal(normalizeRegistryUrl("ftp://mirror.example/npm"), null);
  assert.equal(normalizeRegistryUrl("//mirror.example/npm"), null);
});

test("优先级：源自己写死的 registry 高于用户镜像", () => {
  const root = resolveRegistryRoot({
    sourceRegistry: "https://source.example/npm",
    mirror: "https://mirror.example/npm",
    region: "china",
  });
  assert.equal(root, "https://source.example/npm");
});

test("优先级：用户镜像高于下载区预置", () => {
  assert.equal(resolveRegistryRoot({ mirror: "https://mirror.example/npm", region: "china" }), "https://mirror.example/npm");
  assert.equal(resolveRegistryRoot({ mirror: "https://mirror.example/npm", region: "global" }), "https://mirror.example/npm");
});

test("优先级：没填镜像时按下载区选预置（auto 等同 global）", () => {
  assert.equal(resolveRegistryRoot({ region: "china" }), NPM_REGISTRIES.china);
  assert.equal(resolveRegistryRoot({ region: "global" }), NPM_REGISTRIES.global);
  assert.equal(resolveRegistryRoot({ region: "auto" }), NPM_REGISTRIES.global);
  assert.equal(resolveRegistryRoot({}), NPM_REGISTRIES.global);
  assert.equal(resolveRegistryRoot({ mirror: "   " }), NPM_REGISTRIES.global);
});
