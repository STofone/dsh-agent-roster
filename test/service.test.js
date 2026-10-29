import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { globalRosterRoot } from "../lib/home.js";
import { buildHints, buildPanelSnapshot, countDeployments, resolveRoots } from "../lib/service.js";

const ROSTER = `kind: dsh-agent-roster/v1
roster: demo
version: 1.0.0
title: Demo
defaults:
  provider: deepseek
  model: deepseek-v4.1-flash
members:
  - name: alpha
    role: researcher
    systemPrompt: You are alpha.
  - name: beta
    role: reviewer
    systemPrompt: You are beta.
`;

const CONFIG = {
  rosterDirs: ["rosters"],
  knownToolPolicies: [],
  agentTeamsStateDir: ".agent-teams",
};

const META = { name: "@stofone/dsh-agent-roster", version: "9.9.9" };

function fakeCtx(workspace) {
  return {
    get: (key) => (key === "workspaceRegistry" ? { list: () => [{ title: "demo", path: workspace }] } : undefined),
  };
}

function writeTeam(workspace, id, state) {
  const dir = path.join(workspace, ".agent-teams", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(state));
}

describe("buildPanelSnapshot", () => {
  let workspace;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-agent-roster-service-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("projects rosters, teams and deployments in one payload", () => {
    fs.mkdirSync(path.join(workspace, "rosters", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rosters", "demo", "roster.yaml"), ROSTER);
    writeTeam(workspace, "team-a", {
      id: "team-a",
      name: "Team A",
      phase: "running",
      members: [
        { name: "alpha", role: "researcher", provider: "deepseek", model: "deepseek-v4.1-flash" },
        { name: "stranger", role: "outsider" },
      ],
      tasks: [{ status: "completed" }, { status: "pending" }, { status: "in_progress" }],
    });

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(snapshot.plugin, META.name);
    assert.equal(snapshot.version, "9.9.9");
    assert.equal(snapshot.generatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(snapshot.summary.rosters, 1);
    assert.equal(snapshot.summary.members, 2);
    assert.equal(snapshot.summary.teams, 1);

    const [team] = snapshot.teams.teams;
    assert.equal(team.id, "team-a");
    assert.equal(team.phase, "running");
    assert.deepEqual(team.tasks, { total: 3, completed: 1, failed: 0, pending: 1, active: 1 });

    const [managed, outsider] = team.members;
    assert.equal(managed.rosterId, "demo");
    assert.equal(managed.faithful, true);
    assert.deepEqual(managed.drift, []);
    assert.equal(outsider.rosterId, null);
    assert.equal(outsider.faithful, false);

    assert.deepEqual(snapshot.deployments.demo, { deployed: 1, total: 2, drifted: 0, teams: ["Team A"] });
  });

  it("reports drift when the runtime disagrees with the roster", () => {
    fs.mkdirSync(path.join(workspace, "rosters", "demo"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "rosters", "demo", "roster.yaml"), ROSTER);
    writeTeam(workspace, "team-a", {
      id: "team-a",
      name: "Team A",
      members: [{ name: "alpha", provider: "deepseek", model: "deepseek-v4.1-pro" }],
      tasks: [],
    });

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    const [alpha] = snapshot.teams.teams[0].members;

    assert.equal(alpha.faithful, false);
    assert.deepEqual(alpha.drift, [{ field: "model", roster: "deepseek-v4.1-flash", runtime: "deepseek-v4.1-pro" }]);
    assert.equal(snapshot.deployments.demo.drifted, 1);
  });

  it("keeps going when the state directory does not exist", () => {
    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);

    assert.equal(snapshot.teams.available, false);
    assert.equal(snapshot.teams.teams.length, 0);
    assert.ok(snapshot.hints.some((hint) => hint.code === "state-dir-missing"));
    assert.ok(snapshot.hints.some((hint) => hint.code === "roster-dir-missing"));
  });

  it("never leaks execution prompts into the payload", () => {
    writeTeam(workspace, "team-a", {
      id: "team-a",
      name: "Team A",
      members: [{ name: "alpha", executionPrompt: "SECRET PROMPT".repeat(100) }],
      tasks: [],
    });

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), CONFIG, META);
    const serialized = JSON.stringify(snapshot);

    assert.equal(serialized.includes("SECRET PROMPT"), false);
    assert.equal(snapshot.teams.teams[0].members[0].promptChars, "SECRET PROMPT".length * 100);
  });

  it("reports duplicate roster ids across libraries", () => {
    for (const dir of ["rosters", "shared"]) {
      fs.mkdirSync(path.join(workspace, dir, "demo"), { recursive: true });
      fs.writeFileSync(path.join(workspace, dir, "demo", "roster.yaml"), ROSTER);
    }

    const snapshot = buildPanelSnapshot(fakeCtx(workspace), { ...CONFIG, rosterDirs: ["rosters", "shared"] }, META);

    assert.equal(snapshot.summary.rosters, 2);
    assert.ok(snapshot.hints.some((hint) => hint.code === "duplicate-roster-id" && hint.params.count === 1));
  });
});

describe("resolveRoots", () => {
  it("expands configured directories across known workspaces", () => {
    const roots = resolveRoots(fakeCtx("C:\\work\\a"), { rosterDirs: ["rosters", "extra"] });

    assert.equal(roots.length, 2);
    assert.equal(roots[0].rootDir, path.resolve("C:\\work\\a", "rosters"));
    assert.equal(roots[1].rootDir, path.resolve("C:\\work\\a", "extra"));
  });

  it("defaults to the global library under DSH_HOME", () => {
    const roots = resolveRoots({ get: () => undefined }, { rosterDirs: [] });
    assert.equal(roots.length, 1);
    assert.equal(roots[0].rootDir, globalRosterRoot());
    assert.equal(roots[0].workspacePath, "", "全局库不属于任何工作区");
  });
});

describe("countDeployments", () => {
  it("counts only members that really exist in the runtime", () => {
    const rosters = [{ id: "demo", members: [{ name: "alpha" }, { name: "beta" }] }];
    const teams = [
      {
        id: "t1",
        name: "Team",
        members: [
          { name: "alpha", rosterId: "demo", faithful: true },
          { name: "gamma", rosterId: null, faithful: false },
        ],
      },
    ];

    assert.deepEqual(countDeployments(rosters, teams), {
      demo: { deployed: 1, total: 2, drifted: 0, teams: ["Team"] },
    });
  });
});

describe("buildHints", () => {
  const base = {
    library: { workspaces: [] },
    roots: [],
    rosters: [],
    teams: { available: true, teams: [], stateDir: ".agent-teams", diagnostics: [] },
    config: { knownToolPolicies: [] },
  };

  it("is silent when there is nothing to say", () => {
    assert.deepEqual(buildHints(base), [{ code: "teams-none", severity: "info", params: { stateDir: ".agent-teams" } }]);
  });

  it("flags a workspace that fell back to the process directory", () => {
    const hints = buildHints({ ...base, library: { workspaces: [{ fallbackWorkspace: true }] } });
    assert.ok(hints.some((hint) => hint.code === "workspace-fallback"));
  });

  it("flags unknown tool policies only when nothing is configured", () => {
    const rosters = [{ members: [{ toolPolicy: "read-only" }] }];
    assert.ok(buildHints({ ...base, rosters }).some((hint) => hint.code === "tool-policies-unset"));

    const configured = buildHints({ ...base, rosters, config: { knownToolPolicies: ["read-only"] } });
    assert.equal(configured.some((hint) => hint.code === "tool-policies-unset"), false);
  });
});
