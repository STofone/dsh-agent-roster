/**
 * 测试辅助：在系统临时目录里搭一座档案库，用完删掉。
 *
 * 用临时目录而不是把一堆 fixture 文件签进仓库，是为了让每个用例的档案内容就在用例旁边——
 * 读测试的人不用在 fixture 目录和断言之间来回跳。
 *
 * @module test/helpers
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

/**
 * 建一座临时档案库。
 *
 * `spec` 形如 `{ "core-review/roster.json": {...对象或字符串...} }`：
 * 键是相对路径，值是文件内容（对象会被 JSON 序列化）。
 *
 * @param {Record<string, object | string>} spec
 * @returns {{ rootDir: string, cleanup: () => void }}
 */
export function makeLibrary(spec) {
  const rootDir = mkdtempSync(nodePath.join(tmpdir(), "dsh-agent-roster-"));
  for (const [relative, content] of Object.entries(spec)) {
    const absolute = nodePath.join(rootDir, ...relative.split("/"));
    mkdirSync(nodePath.dirname(absolute), { recursive: true });
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(absolute, text, "utf8");
  }
  return {
    rootDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

/**
 * 造一份合法档案，再按需覆盖字段（深合并只做一层，够测试用）。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function rosterDocument(overrides = {}) {
  const base = {
    kind: "dsh-agent-roster/v1",
    roster: "core-review",
    version: "1.2.0",
    title: "核心评审组",
    description: "负责代码评审与发布把关的固定成员",
    license: "MIT",
    maintainers: ["STofone"],
    tags: ["review", "release"],
    defaults: {
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
    },
    members: [
      {
        name: "reviewer",
        role: "代码评审",
        systemPrompt: "你是严格的代码评审者。先找语义错误，再看风格。",
        toolPolicy: "readonly",
      },
      {
        name: "release-manager",
        role: "发布把关",
        systemPrompt: "你负责核对变更、版本号与回滚方案。",
        provider: "deepseek",
        model: "deepseek-v4.1-pro",
        reasoningEffort: "low",
      },
    ],
  };
  return mergeOneLevel(base, overrides);
}

/** 造一个成员对象（按需覆盖）。 */
export function memberDocument(overrides = {}) {
  return {
    name: "reviewer",
    role: "代码评审",
    systemPrompt: "你是严格的代码评审者。",
    ...overrides,
  };
}

function mergeOneLevel(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && value !== undefined) {
      merged[key] = { ...(base[key] ?? {}), ...value };
    } else if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
