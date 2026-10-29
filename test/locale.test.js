/**
 * 词典一致性：`client.js` 里静态出现的 `t("key")` 必须在两本词典里都存在，
 * 两本词典的键集合也必须一致——界面漏词不该等到用户看见才发现。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

const flat = (object, prefix = "") =>
  Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === "object" ? flat(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );

test("词典：client.js 的静态 t() 键在两本词典里都能查到", () => {
  const source = readFileSync(nodePath.join(root, "client.js"), "utf8");
  const used = [...new Set([...source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((match) => match[1]))];
  assert.ok(used.length > 40, `静态键数量异常：${used.length}`);

  for (const language of ["en", "zh"]) {
    const dict = JSON.parse(readFileSync(nodePath.join(root, "locale", `${language}.json`), "utf8"));
    const keys = new Set(flat(dict));
    const missing = used.filter((key) => !keys.has(key));
    assert.deepEqual(missing, [], `${language}.json 缺少 ${missing.length} 个键`);
  }
});

test("词典：两本的键集合必须一致", () => {
  const en = new Set(flat(JSON.parse(readFileSync(nodePath.join(root, "locale", "en.json"), "utf8"))));
  const zh = new Set(flat(JSON.parse(readFileSync(nodePath.join(root, "locale", "zh.json"), "utf8"))));
  assert.deepEqual([...en].filter((key) => !zh.has(key)), [], "只在 en 里出现的键");
  assert.deepEqual([...zh].filter((key) => !en.has(key)), [], "只在 zh 里出现的键");
});
