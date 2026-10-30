import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import test from "node:test";

import { parseDeployedProfile, readDeployedCaptains, verifyCaptain } from "../lib/captain.js";

const PATCH = `# 本机 profile 的默认模型与一个 preset
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: tsingmicro
    model: deepseek-v4.1-flash
    reasoningEffort: high

- id: preset-standard
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: standard
    plugins:
      - id: persona
        name: "@deepseek-ai/dsh-persona"
        config:
          prefix: |
            先读后写。
            只改必要的地方。
`;

test("parseDeployedProfile 读出默认模型与 persona prefix", () => {
  const profile = parseDeployedProfile(PATCH, "web");
  assert.equal(profile.profile, "web");
  assert.equal(profile.provider, "tsingmicro");
  assert.equal(profile.model, "deepseek-v4.1-flash");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.personas.length, 1);
  assert.equal(profile.personas[0].preset, "preset-standard");
  assert.match(profile.personas[0].prefix, /先读后写。\n只改必要的地方。/);
});

test("parseDeployedProfile 对空文本给空值，不抛错", () => {
  const profile = parseDeployedProfile("", "web");
  assert.deepEqual(profile, { profile: "web", provider: "", model: "", reasoningEffort: "", personas: [] });
});

test("verifyCaptain 声明与部署一致时记 match", () => {
  const deployed = { profiles: [parseDeployedProfile(PATCH, "web")] };
  const verified = verifyCaptain({ provider: "tsingmicro", model: "deepseek-v4.1-flash" }, deployed);
  assert.equal(verified.ok, true);
  assert.deepEqual(
    verified.checks.filter((check) => check.status === "match").map((check) => check.field),
    ["provider", "model"],
  );
});

test("verifyCaptain 部署不一致时记 differ（要改部署，不是改档案）", () => {
  const deployed = { profiles: [parseDeployedProfile(PATCH, "web")] };
  const verified = verifyCaptain({ provider: "tsingmicro", model: "deepseek-v4.1-flash", personaPrefix: "别的" }, deployed);
  assert.equal(verified.ok, false);
  const persona = verified.checks.find((check) => check.field === "personaPrefix");
  assert.equal(persona.status, "differ");
});

test("verifyCaptain 读不到部署配置时记 unknown，不假装通过", () => {
  const verified = verifyCaptain({ provider: "tsingmicro", model: "deepseek-v4.1-flash" }, { profiles: [] });
  assert.equal(verified.ok, false);
  assert.deepEqual(
    verified.checks.filter((check) => check.status === "unknown").map((check) => check.field),
    ["provider", "model", "personaPrefix"],
  );
});

test("verifyCaptain 未声明时如实记 undeclared 并给出部署值", () => {
  const deployed = { profiles: [parseDeployedProfile(PATCH, "web")] };
  const verified = verifyCaptain({}, deployed);
  const provider = verified.checks.find((check) => check.field === "provider");
  assert.equal(provider.status, "undeclared");
  assert.equal(provider.actual, "tsingmicro");
  // 未声明不算“不一致”：它只是没有约束，运行时按部署默认走。
  assert.equal(verified.ok, true);
});

test("readDeployedCaptains 读指定 dshHome 下的 profiles", (t) => {
  const home = mkdtempSync(nodePath.join(tmpdir(), "roster-captain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(nodePath.join(home, "profiles", "web"), { recursive: true });
  writeFileSync(nodePath.join(home, "profiles", "web", "cordis.patch.yml"), PATCH, "utf8");

  const deployed = readDeployedCaptains({ dshHome: home, env: { DSH_HOME: home } });
  assert.equal(deployed.profiles.length, 1);
  assert.equal(deployed.profiles[0].profile, "web");
  assert.equal(deployed.profiles[0].model, "deepseek-v4.1-flash");
  assert.equal(deployed.displayed, "$DSH_HOME");
});

test("readDeployedCaptains 在没有 profiles 目录时给空列表而不是抛错", (t) => {
  const home = mkdtempSync(nodePath.join(tmpdir(), "roster-captain-empty-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const deployed = readDeployedCaptains({ dshHome: home, env: {} });
  assert.equal(deployed.profiles.length, 0);
  assert.deepEqual(deployed.diagnostics, []);
});
