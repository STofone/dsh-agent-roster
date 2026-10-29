import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { listLibraryRoots, deleteRosterDocument, readRosterDocument, writeRosterDocument } from "../lib/write.js";

const VALID = `kind: dsh-agent-roster/v1
roster: demo
version: 1.0.0
title: Demo
members:
  - name: alpha
    role: researcher
    systemPrompt: |
      You are alpha.
`;

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-roster-write-"));
  const rootDir = path.join(workspace, "rosters");
  const roots = [{ dirSpec: "rosters", workspacePath: workspace, rootDir, exists: true }];
  return { workspace, rootDir, roots };
}

describe("writeRosterDocument", () => {
  let ctx;

  beforeEach(() => {
    ctx = fixture();
  });

  afterEach(() => {
    fs.rmSync(ctx.workspace, { recursive: true, force: true });
  });

  it("creates a roster file in its own directory", () => {
    const result = writeRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, text: VALID });

    assert.equal(result.ok, true);
    assert.equal(result.file, "demo/roster.yaml");
    assert.equal(result.roster.id, "demo");
    assert.equal(result.roster.members, 1);
    assert.equal(fs.readFileSync(path.join(ctx.rootDir, "demo", "roster.yaml"), "utf8"), VALID);
  });

  it("refuses a root that is not configured", () => {
    const result = writeRosterDocument({ roots: ctx.roots, rootDir: path.join(ctx.workspace, "elsewhere"), text: VALID });

    assert.deepEqual(result, { ok: false, code: "unknown-root" });
  });

  it("refuses to clobber an existing document without confirmation", () => {
    assert.equal(writeRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, text: VALID }).ok, true);

    const second = writeRosterDocument({
      roots: ctx.roots,
      rootDir: ctx.rootDir,
      text: VALID.replace("Demo", "Demo v2"),
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, "exists");
    assert.equal(second.existing.file, "demo/roster.yaml");

    const overwritten = writeRosterDocument({
      roots: ctx.roots,
      rootDir: ctx.rootDir,
      text: VALID.replace("Demo", "Demo v2"),
      overwrite: true,
    });
    assert.equal(overwritten.ok, true);

    const dir = path.join(ctx.rootDir, "demo");
    assert.equal(fs.existsSync(path.join(dir, "roster.yaml.bak")), true);
    assert.match(fs.readFileSync(path.join(dir, "roster.yaml"), "utf8"), /Demo v2/);
  });

  it("rejects an invalid document before touching the disk", () => {
    const result = writeRosterDocument({
      roots: ctx.roots,
      rootDir: ctx.rootDir,
      text: "kind: dsh-agent-roster/v1\nroster: broken\nversion: 1.0.0\n",
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid-document");
    assert.ok(result.diagnostics.length > 0);
    assert.equal(fs.existsSync(path.join(ctx.rootDir, "broken")), false);
  });

  it("rejects ids that cannot be used as a path segment", () => {
    const result = writeRosterDocument({
      roots: ctx.roots,
      rootDir: ctx.rootDir,
      text: VALID.replace("roster: demo", "roster: ../escape"),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid-id");
    assert.equal(fs.existsSync(path.join(ctx.workspace, "escape")), false);
  });

  it("refuses to switch the format of an existing roster without confirmation", () => {
    const jsonRoot = fixture();
    try {
      const asJson = JSON.stringify({
        kind: "dsh-agent-roster/v1",
        roster: "demo",
        version: "1.0.0",
        title: "Demo",
        members: [{ name: "alpha", role: "researcher", systemPrompt: "You are alpha." }],
      });
      assert.equal(writeRosterDocument({ roots: jsonRoot.roots, rootDir: jsonRoot.rootDir, text: asJson }).ok, true);

      const asYaml = writeRosterDocument({ roots: jsonRoot.roots, rootDir: jsonRoot.rootDir, text: VALID });
      assert.equal(asYaml.ok, false);
      assert.equal(asYaml.code, "format-conflict");

      const switched = writeRosterDocument({
        roots: jsonRoot.roots,
        rootDir: jsonRoot.rootDir,
        text: VALID,
        overwrite: true,
      });
      assert.equal(switched.ok, true);
      assert.deepEqual(switched.removed, ["demo/roster.json"]);
      assert.equal(fs.existsSync(path.join(jsonRoot.rootDir, "demo", "roster.yaml")), true);
      assert.equal(fs.existsSync(path.join(jsonRoot.rootDir, "demo", "roster.json.bak")), true);
    } finally {
      fs.rmSync(jsonRoot.workspace, { recursive: true, force: true });
    }
  });
});

describe("readRosterDocument / deleteRosterDocument", () => {
  let ctx;

  beforeEach(() => {
    ctx = fixture();
  });

  afterEach(() => {
    fs.rmSync(ctx.workspace, { recursive: true, force: true });
  });

  it("reads back the exact text that was written", () => {
    assert.equal(writeRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, text: VALID }).ok, true);

    const read = readRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, id: "demo" });
    assert.equal(read.ok, true);
    assert.equal(read.text, VALID);
    assert.equal(read.format, "yaml");
  });

  it("reports a missing roster and a missing root distinctly", () => {
    assert.equal(readRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, id: "nope" }).code, "not-found");
    assert.equal(
      readRosterDocument({ roots: ctx.roots, rootDir: path.join(ctx.workspace, "nope"), id: "demo" }).code,
      "unknown-root",
    );
    assert.equal(readRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, id: "../demo" }).code, "invalid-id");
  });

  it("removes only the document file, then the empty directory", () => {
    assert.equal(writeRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, text: VALID }).ok, true);

    const removed = deleteRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, id: "demo" });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.removed, ["demo/roster.yaml"]);
    assert.equal(fs.existsSync(path.join(ctx.rootDir, "demo")), false);
    assert.equal(deleteRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, id: "demo" }).code, "not-found");
  });

  it("keeps the directory when other files remain", () => {
    assert.equal(writeRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, text: VALID }).ok, true);
    fs.writeFileSync(path.join(ctx.rootDir, "demo", "README.md"), "notes");

    assert.equal(deleteRosterDocument({ roots: ctx.roots, rootDir: ctx.rootDir, id: "demo" }).ok, true);
    assert.equal(fs.existsSync(path.join(ctx.rootDir, "demo", "README.md")), true);
  });
});

describe("listLibraryRoots", () => {
  it("resolves every configured directory against every workspace", () => {
    const roots = listLibraryRoots({
      rosterDirs: ["rosters", "shared/rosters"],
      workspaces: [{ path: "C:\\work\\a" }, { path: "C:\\work\\b" }],
    });

    assert.equal(roots.length, 4);
    assert.equal(roots[0].rootDir, path.resolve("C:\\work\\a", "rosters"));
    assert.equal(roots[3].rootDir, path.resolve("C:\\work\\b", "shared/rosters"));
  });

  it("falls back to the process workspace when none is given", () => {
    const roots = listLibraryRoots({ rosterDirs: ["rosters"], workspaces: [] });
    assert.equal(roots.length, 1);
    assert.equal(roots[0].rootDir, path.resolve(process.cwd(), "rosters"));
  });
});
