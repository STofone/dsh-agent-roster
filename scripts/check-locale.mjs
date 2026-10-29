#!/usr/bin/env node
/**
 * 词典一致性检查（开发用）：client.js 里静态出现的 `t("key")` 必须在 en/zh 两份词典里都存在，
 * 两份词典的键集合也必须一致。动态拼出来的键（如 `diagnostics.severity${Sev}`）无法静态检查，
 * 这里只报出静态键，避免“界面漏词”在医院里才发现。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(nodePath.join(root, "client.js"), "utf8");
const en = JSON.parse(readFileSync(nodePath.join(root, "locale/en.json"), "utf8"));
const zh = JSON.parse(readFileSync(nodePath.join(root, "locale/zh.json"), "utf8"));

const flat = (object, prefix = "") =>
  Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === "object" ? flat(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );

const used = [...new Set([...source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((match) => match[1]))];
const enKeys = new Set(flat(en));
const zhKeys = new Set(flat(zh));

const missingEn = used.filter((key) => !enKeys.has(key));
const missingZh = used.filter((key) => !zhKeys.has(key));
const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key));
const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key));

const report = (label, list) => {
  console.log(`${label}: ${list.length}`);
  for (const key of list.slice(0, 40)) console.log(`  - ${key}`);
};

report("client.js 用到但 en.json 缺失", missingEn);
report("client.js 用到但 zh.json 缺失", missingZh);
report("只在 en.json 里", onlyEn);
report("只在 zh.json 里", onlyZh);

if (missingEn.length + missingZh.length + onlyEn.length + onlyZh.length > 0) process.exitCode = 1;
