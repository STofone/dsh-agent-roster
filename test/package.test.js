/**
 * 包清单一致性测试：一个 dsh 插件"看起来能装"的所有条件。
 *
 * 这里不测业务逻辑，只测发布前最容易漏的东西——导出路径与文件是否对得上、
 * 客户端半边是否真的能被模块表加载、词典是否两份都在。这类错误在安装时才暴露，
 * 一旦发布就是发一个装不上的包。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const root = nodePath.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(nodePath.join(root, "package.json"), "utf8"));

/** 把一个 export 目标解析成磁盘绝对路径。 */
function resolveExport(target) {
  return nodePath.resolve(root, target);
}

test("清单：名称、入口与打包范围自洽", () => {
  assert.equal(pkg.name, "@stofone/dsh-agent-roster");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "index.js");
  assert.ok(existsSync(nodePath.join(root, pkg.main)), "main 必须存在");
  assert.deepEqual(
    Object.keys(pkg.exports).sort(),
    [".", "./client", "./cordis.patch.yml", "./icon", "./locale/*.json", "./package.json"].sort(),
  );
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key.includes("*")) continue; // 子路径模式（./locale/*.json）不是单文件导出。
    assert.ok(existsSync(resolveExport(target)), `exports["${key}"] 指向了不存在的文件：${target}`);
  }
  assert.ok(pkg.files.includes("client.js"), "files 必须带上 client.js，否则浏览器半边不会被发布");
  assert.ok(pkg.files.includes("lib"), "files 必须带上 lib");
});

test("清单：dsh 声明指向真实存在的补丁与客户端平台", () => {
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(existsSync(nodePath.resolve(root, pkg.dsh.bundle.patch)), "cordis.patch.yml 必须存在");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0, "client.inject 至少包含设置页宿主");

  const patch = readFileSync(nodePath.resolve(root, pkg.dsh.bundle.patch), "utf8");
  assert.match(patch, /insert:/, "补丁必须是 loader 的 insert 方言");
  // YAML 里单双引号都合法，只认裸字符串会让补丁重写后测试假失败。
  assert.match(patch, /name: ['"]@stofone\/dsh-agent-roster['"]/, "补丁必须挂载本包");
});

test("清单：locale 两份齐全且 meta 可读", () => {
  for (const locale of ["en", "zh"]) {
    const file = nodePath.join(root, "locale", `${locale}.json`);
    const dict = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(typeof dict.meta?.title, "string", `${locale}.json 缺 meta.title`);
    assert.ok(dict.meta.title.length > 0, `${locale}.json 的 meta.title 不能为空`);
    assert.equal(typeof dict.meta?.description, "string", `${locale}.json 缺 meta.description`);
  }
});

test("清单：图标是合法 SVG 且没大得离谱", () => {
  const file = nodePath.join(root, "icon.svg");
  const svg = readFileSync(file, "utf8");
  assert.match(svg, /^<svg[\s>]/, "icon 必须是 SVG 文档");
  assert.ok(statSync(file).size < 64 * 1024, "icon 体积应远小于 256KiB 上限");
});

test("客户端半边：能被模块表加载，面板在左栏、语言与配置摘要在设置页", () => {
  const source = readFileSync(nodePath.join(root, "client.js"), "utf8");
  assert.match(source, /window\.__ModuleLoader__\.load\(/, "必须走模块表加载");
  assert.match(source, /id: "@stofone\/dsh-agent-roster"/, "模块 id 必须是包名");
  assert.match(source, /factory\(require\)/, "必须是 factory 形式");
  assert.match(source, /require\("react"\)/, "必须从宿主模块表拿 React");
  assert.match(source, /"main"/, "必须贡献主面板内容槽");
  assert.match(source, /"sidebar\.panellist"/, "必须在左侧全局栏占一行图标");
  // 设置页只留语言与配置摘要：档案与团队管理属于整页面板，不塞进设置页。
  assert.match(source, /"settings\.section"/, "语言与配置摘要需要挂在设置页");
  assert.match(source, /inject: \["slots"\]/, "必须声明 slots 依赖，配置表单走 ctx.get 可选读取");
  assert.match(source, /\/plugins\/dsh-agent-roster\/library/, "面板必须读 Host 的只读路由");
  assert.match(source, /\/plugins\/dsh-agent-roster\/rosters/, "写操作必须走 Host 的写路由");
  assert.match(source, /\/plugins\/dsh-agent-roster\/locale/, "词典必须从 Host 路由取");
  // 纯语法检查：编译通过即可，不执行（执行需要浏览器模块表）。
  assert.doesNotThrow(() => new Function(source), "client.js 必须语法合法");
});

test("Host 半边：源码导出 Cordis 插件约定字段", () => {
  // 不 import：@deepseek-ai/dsh-tools 是 peer 依赖，只有装在宿主里才解析得到；
  // 这里改为核对导出形态，真正的加载由宿主安装验证覆盖。
  const source = readFileSync(nodePath.join(root, "index.js"), "utf8");
  assert.match(source, /export const name = "agent-roster"/, "必须导出插件名");
  assert.match(source, /export const inject = \["tools"\]/, "必须声明 tools 依赖");
  assert.match(source, /export const Config/, "必须导出 Config 供设置页渲染");
  assert.match(source, /export function apply\(ctx, config\)/, "必须导出 apply(ctx, config)");
  assert.match(source, /webServer/, "Host 半边必须挂路由给面板用");
  assert.match(source, /\/plugins\/dsh-agent-roster\/library/, "路由路径必须与 client.js 一致");
  assert.match(source, /\/plugins\/dsh-agent-roster\/rosters/, "写路由必须与 client.js 一致");
  assert.match(source, /connection/, "写路由必须过宿主 connection 围栏（同源校验）");
});
