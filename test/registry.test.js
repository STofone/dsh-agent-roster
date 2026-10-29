/**
 * 档案库扫描测试：布局约定、坏档案隔离、以及"找不到时不许猜"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { findRoster, scanRosterLibrary } from "../lib/registry.js";
import { makeLibrary, rosterDocument } from "./helpers.js";

/** 造一座含两份合法档案的库。 */
function validLibrary() {
  return makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "research/roster.json": rosterDocument({
      roster: "research",
      title: "调研组",
      members: [
        { name: "scout", role: "外部调研", systemPrompt: "你负责找一手资料并标注出处。" },
        { name: "reviewer", role: "交叉复核", systemPrompt: "你负责质疑别人的结论。" },
      ],
    }),
  });
}

test("扫描合法档案库：两份档案、成员统计正确", () => {
  const library = validLibrary();
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.missing, false);
    assert.equal(scan.stats.total, 2);
    assert.equal(scan.stats.ok, 2);
    assert.equal(scan.stats.failed, 0);
    assert.equal(scan.stats.members, 4);
    assert.deepEqual(
      scan.rosters.map((roster) => roster.id).sort(),
      ["core-review", "research"],
    );
    assert.equal(scan.rosters[0].file, "core-review/roster.json");
  } finally {
    library.cleanup();
  }
});

test("支持 YAML 档案", () => {
  const library = makeLibrary({
    "yaml-team/roster.yaml": [
      "kind: dsh-agent-roster/v1",
      "roster: yaml-team",
      "version: 0.1.0",
      "members:",
      "  - name: writer",
      "    role: 写作",
      "    systemPrompt: 你负责把结论写成可执行的说明。",
    ].join("\n"),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.ok, 1, JSON.stringify(scan.diagnostics));
    assert.equal(scan.rosters[0].format, "yaml");
    assert.equal(scan.rosters[0].members[0].name, "writer");
  } finally {
    library.cleanup();
  }
});

test("档案库不存在：不是错误，也不该有任何诊断噪音", () => {
  const scan = scanRosterLibrary({ rootDir: nodePath.join(process.cwd(), "definitely-not-here") });
  assert.equal(scan.missing, true);
  assert.equal(scan.rosters.length, 0);
  assert.equal(scan.stats.errors, 0);
  assert.equal(scan.stats.warnings, 0);
  assert.equal(scan.stats.infos, 0);
  assert.deepEqual(scan.diagnostics, []);
});

test("坏档案被隔离：其余档案照常可用", () => {
  const library = makeLibrary({
    "good/roster.json": rosterDocument({ roster: "good" }),
    "bad-kind/roster.json": rosterDocument({ roster: "bad-kind", kind: "nope/v9" }),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.total, 2);
    assert.equal(scan.stats.ok, 1);
    assert.equal(scan.stats.failed, 1);
    assert.equal(scan.rosters[0].id, "good");
    assert.ok(scan.diagnostics.some((item) => item.code === "invalid-kind"));
    const badEntry = scan.entries.find((entry) => entry.id === "bad-kind");
    assert.equal(badEntry.roster, null);
  } finally {
    library.cleanup();
  }
});

test("YAML 语法错误被报成诊断，而不是抛出", () => {
  const library = makeLibrary({
    "broken/roster.yaml": "kind: dsh-agent-roster/v1\nroster: broken\nmembers: [\n  - name: x\n   bad: indent",
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.failed, 1);
    assert.ok(scan.diagnostics.some((item) => item.code === "yaml-syntax"));
  } finally {
    library.cleanup();
  }
});

test("目录里没有 roster.*：跳过并记 info，不算校验失败", () => {
  const library = makeLibrary({ "empty-dir/readme.md": "# 说明\n" });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.total, 0);
    assert.equal(scan.stats.failed, 0);
    assert.equal(scan.stats.skippedDirs, 1);
    const info = scan.diagnostics.find((item) => item.code === "missing-roster-file");
    assert.ok(info);
    assert.equal(info.severity, "info");
  } finally {
    library.cleanup();
  }
});

test("档案库根下散落的文件被警告：布局不对不能被静默忽略", () => {
  const library = makeLibrary({
    "loose.yaml": "kind: dsh-agent-roster/v1\n",
    "core-review/roster.json": rosterDocument(),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.ok, 1);
    const warn = scan.diagnostics.find((item) => item.code === "unexpected-file");
    assert.ok(warn);
    assert.equal(warn.severity, "warn");
    assert.equal(warn.file, "loose.yaml");
  } finally {
    library.cleanup();
  }
});

test("同一目录里多份 roster.*：只加载第一份并警告", () => {
  const library = makeLibrary({
    "core-review/roster.json": rosterDocument(),
    "core-review/roster.yaml": [
      "kind: dsh-agent-roster/v1",
      "roster: core-review",
      "version: 2.0.0",
      "members:",
      "  - name: yaml-writer",
      "    role: 写作",
      "    systemPrompt: 来自 YAML 的成员。",
    ].join("\n"),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.ok, 1, JSON.stringify(scan.diagnostics));
    // MEMBER_FILE_NAMES 的顺序决定谁生效：roster.yaml 在前，JSON 被忽略
    assert.equal(scan.rosters[0].format, "yaml");
    assert.equal(scan.rosters[0].version, "2.0.0");
    assert.equal(scan.rosters[0].members[0].name, "yaml-writer");
    assert.ok(scan.diagnostics.some((item) => item.code === "multiple-roster-files"));
  } finally {
    library.cleanup();
  }
});

test("整库全坏时给出明确的库级错误", () => {
  const library = makeLibrary({ "only/roster.json": rosterDocument({ kind: "bad/v1" }) });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.ok(scan.diagnostics.some((item) => item.code === "library-unusable"));
  } finally {
    library.cleanup();
  }
});

test("findRoster：按 id、按成员名、歧义、找不到", () => {
  const library = validLibrary();
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });

    const byId = findRoster(scan.rosters, "research");
    assert.equal(byId.via, "id");
    assert.equal(byId.roster.id, "research");

    const byMember = findRoster(scan.rosters, "scout");
    assert.equal(byMember.via, "member");
    assert.equal(byMember.roster.id, "research");

    // 两份档案里都有 reviewer：必须返回歧义，不能替用户挑
    const ambiguous = findRoster(scan.rosters, "reviewer");
    assert.ok(ambiguous.ambiguous, "同名成员应返回歧义列表");
    assert.deepEqual(
      ambiguous.ambiguous.map((roster) => roster.id).sort(),
      ["core-review", "research"],
    );

    assert.equal(findRoster(scan.rosters, "nobody"), null);
    assert.equal(findRoster(scan.rosters, "  "), null);
  } finally {
    library.cleanup();
  }
});

test("跳过 node_modules 与隐藏目录", () => {
  const library = makeLibrary({
    "node_modules/pkg/roster.json": rosterDocument({ roster: "pkg" }),
    ".cache/roster.json": rosterDocument({ roster: "cache" }),
    "real/roster.json": rosterDocument({ roster: "real" }),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.deepEqual(scan.rosters.map((roster) => roster.id), ["real"]);
  } finally {
    library.cleanup();
  }
});

test("超大文件被拒绝而不是读进内存", () => {
  const library = makeLibrary({});
  try {
    const dir = nodePath.join(library.rootDir, "huge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(nodePath.join(dir, "roster.json"), `{"kind":"${"x".repeat(300 * 1024)}"}`, "utf8");
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.failed, 1);
    assert.ok(scan.diagnostics.some((item) => item.code === "document-too-large"));
  } finally {
    library.cleanup();
  }
});

test("没有任何档案时，档案库层零诊断（空库不该有噪音）", () => {
  const library = makeLibrary({});
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.stats.total, 0);
    assert.deepEqual(scan.diagnostics, []);
    assert.equal(scan.stats.infos, 0);
    assert.equal(scan.stats.warnings, 0);
  } finally {
    library.cleanup();
  }
});

test("档案没人声明 toolPolicy 时，不提交叉校验被跳过", () => {
  const library = makeLibrary({
    "plain/roster.json": rosterDocument({
      roster: "plain",
      members: [{ name: "alpha", role: "普通成员", systemPrompt: "你只做只读调研。" }],
    }),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    assert.equal(scan.diagnostics.some((item) => item.code === "tool-policy-cross-check-skipped"), false);
  } finally {
    library.cleanup();
  }
});

test("有档案声明 toolPolicy 时，只发一条档案库级提示，不按档案重复", () => {
  const library = makeLibrary({
    "guarded/roster.json": rosterDocument({
      roster: "guarded",
      members: [{ name: "alpha", role: "受限成员", systemPrompt: "你只做只读调研。", toolPolicy: "readonly" }],
    }),
    "guarded-two/roster.json": rosterDocument({
      roster: "guarded-two",
      members: [{ name: "beta", role: "受限成员", systemPrompt: "你只做只读调研。", toolPolicy: "readonly" }],
    }),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir });
    const skipped = scan.diagnostics.filter((item) => item.code === "tool-policy-cross-check-skipped");
    assert.equal(skipped.length, 1, "两份档案也只能有一条");
    assert.equal(skipped[0].severity, "info");
    assert.equal(scan.stats.warnings, 0, "这不是警告，不该抬高警告计数");
  } finally {
    library.cleanup();
  }
});

test("配了已知策略列表后不再发“跳过校验”提示", () => {
  const library = makeLibrary({
    "guarded/roster.json": rosterDocument({
      roster: "guarded",
      members: [{ name: "alpha", role: "受限成员", systemPrompt: "你只做只读调研。", toolPolicy: "readonly" }],
    }),
  });
  try {
    const scan = scanRosterLibrary({ rootDir: library.rootDir, knownToolPolicies: ["readonly"] });
    assert.equal(scan.diagnostics.some((item) => item.code === "tool-policy-cross-check-skipped"), false);
  } finally {
    library.cleanup();
  }
});
