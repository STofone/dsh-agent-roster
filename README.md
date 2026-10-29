# @stofone/dsh-agent-roster

Static member rosters for multi-agent teams in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A roster is a file on disk: who is on the team, what each member is for, which model route they use, and which tools they are allowed to touch. This plugin defines that file format, validates it, and translates it into `agent_teams_*` call arguments — nothing more.

## What it is / what it is not

| | |
|---|---|
| **It is** a definition and validation layer | rosters are versioned, reviewable files; mistakes fail loudly with a file and field path |
| **It is** a bridge to `dsh-agent-teams` | `roster_create` emits ready-to-use `agent_teams_add_member` arguments and marks, field by field, what the runtime actually accepts |
| **It is** a verification aid | `roster_verify` reads `team.json` and compares persisted values against the roster |
| **It is not** a team runner | it never creates members, schedules tasks, or writes `.agent-teams/` state |
| **It is not** a scheduler or a runtime | dispatch, retries and review loops belong to `dsh-agent-teams` |

## Install

Requires DSH with the `tools` service (any recent build) and `yaml` — both are declared as dependencies.

From the plugin manager, point it at this repository (absolute path) or at the package name after publication:

```
@stofone/dsh-agent-roster
```

The bundle ships `cordis.patch.yml`, so installing it inserts the plugin into the profile automatically. After install you should see four tools (`roster_list`, `roster_show`, `roster_create`, `roster_verify`) and an **Agent Roster** entry in the left sidebar (a full main panel, not a Settings section).

## Quick start

The library is **global**: one per machine, not per workspace, and it lives under the DSH data
directory (`$DSH_HOME/agent-roster`, which is `~/.dsh/agent-roster` by default — in Docker that is
the mounted volume). It is created on first save; you do not have to make it yourself.

```
~/.dsh/agent-roster/
└── core-review/
    └── roster.yaml
```

```yaml
kind: dsh-agent-roster/v1
roster: core-review          # must equal the directory name
version: 1.0.0               # exact SemVer
title: Core review team
description: Fixed members for code review and release gatekeeping.
license: MIT
maintainers: [STofone]
tags: [review, release]

defaults:                    # team-wide fallback for route fields
  provider: deepseek
  model: deepseek-v4.1-flash
  reasoningEffort: high

members:
  - name: reviewer          # kebab-case, unique in the team
    role: Code review
    systemPrompt: |
      You review for semantic bugs first, style second.
    toolPolicy: readonly
  - name: release-manager
    role: Release gatekeeper
    systemPrompt: |
      You check the diff, the version and the rollback plan.
    model: deepseek-v4.1-pro
    reasoningEffort: low
```

JSON works too (`roster.json`); YAML and JSON are probed in the order `roster.yaml`, `roster.yml`, `roster.json`. Exactly one file per directory — a second one is reported, never silently picked.

This package ships two example libraries in [`examples/`](./examples). `rosterDirs` is empty by
default, meaning the global library above, which is empty in a fresh install — so the panel shows
"0 rosters" until you create one in the UI. To look at the examples instead, point the CLI at them:

```bash
# see what the example libraries look like
npx dsh-agent-roster list --dir examples
```

Then ask the model to run `roster_list`, or call the CLI (it reads the same global library by
default):

```bash
npx dsh-agent-roster validate
npx dsh-agent-roster list
```

## File reference

Top level: only these keys are allowed — unknown keys are errors, not warnings.

| Key | Required | Notes |
|---|---|---|
| `kind` | yes | must be `dsh-agent-roster/v1` |
| `roster` | yes | kebab-case id, must equal the containing directory name |
| `version` | yes | exact SemVer (`1.2.0`, not `^1.2.0`) |
| `title` | no | single line, at most 120 chars (defaults to the id) |
| `description` | no | at most 500 chars |
| `license` | no | SPDX-ish single line |
| `maintainers` | no | non-empty strings if present |
| `tags` | no | at most 16 tags, each lowercase kebab-case |
| `defaults` | no | route fields inherited by members |
| `members` | yes | 1 to 32 entries |

Member keys: `name`, `role`, `systemPrompt` (all required), plus `provider`, `model`, `reasoningEffort`, `toolPolicy`, `fallback`, `toolScope`, `maxTokens`, `title`, `tags`, `notes`.

`systemPrompt` is capped at 8000 characters. Members that omit a route field inherit it from `defaults`; the resolved value is recorded in the member's `inherited` list so you can see where it came from.

### Where each field actually lands

The bridge never pretends a field took effect. Every member field is classified:

| Class | Fields | Meaning |
|---|---|---|
| `direct` | `name`, `role`, `systemPrompt`, `provider`, `model`, `reasoningEffort`, `toolPolicy` | passed to `agent_teams_add_member` and stored by the runtime |
| `config` | `fallback` | no runtime argument; needs owner-side configuration |
| `declaration` | `toolScope`, `maxTokens`, `title`, `tags`, `notes` | documentation and validation only — explicitly reported as not applied |

`roster_create` emits `agent_teams_add_member` arguments (`systemPrompt` → `executionPrompt`, `reasoningEffort` → `reasoning_effort`, `toolPolicy` → `tool_policy`) and a per-field summary; `roster_verify` then reports each field as `applied`, `overridden`, `omitted` or `unconfirmed`.

## Tools

| Tool | Purpose |
|---|---|
| `roster_list` | list rosters in a library with per-roster validation results |
| `roster_show` | show one roster (or one member) in full, including bridge field classes |
| `roster_create` | translate members into `agent_teams_add_member` arguments / `plan.members` |
| `roster_verify` | compare a roster against `dsh-agent-teams`' `team.json`; degrades to "cannot verify" when state is absent |

All four are read-only with respect to team state. `roster_create` only produces arguments — the model still has to call `agent_teams_add_member` itself.

`roster_list`, `roster_show`, `roster_create` and `roster_verify` all accept a `path` argument: when given, it is the library root, with no silent fallback to the configured directory.

## Sidebar panel

The client plugin adds an **Agent Roster** entry to the left sidebar: one row in the `sidebar.panellist` slot plus the matching key in the `main` slot. Clicking the row opens a full-width page with three tabs — the panel is not only a viewer:

| Tab | What you can do |
|---|---|
| Rosters | browse every workspace × library, expand members, and **create / edit / duplicate / delete / import / export** rosters. The editor has a form mode and a source mode (the file as-is); the host validates before writing and keeps a `.bak` next to an overwritten file |
| Teams | read one configured state directory (`.agent-teams` by default) and see every team the runtime created: profile, member profiles and model routes, whether each persisted member really matches its roster, plus the team's tasks |
| Health | the "configuration points somewhere wrong" questions in one place: which directories resolved, whether the state directory exists, how many declarations are unconfirmed, and what to change |

A badge at the top summarises how many items need attention; the Health tab explains each one. All write operations go through `POST /plugins/dsh-agent-roster/rosters`, which enforces same-origin (`connection`), a JSON content type, a body-size cap and a library-root whitelist — the client never writes files itself.

The panel is bilingual. Its language defaults to the DSH language and can be pinned in **Settings → Plugins → Agent Roster** (the same section shows a read-only summary of the configuration). Both the panel and the host-side texts are translated; dictionaries live in `locale/` and are served by the host, so switching the DSH language re-renders the panel without a reload.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/plugins/dsh-agent-roster/library` | GET | panel snapshot: libraries, rosters, teams, hints, counts |
| `/plugins/dsh-agent-roster/document` | GET | one roster's raw text plus its parsed form (editor) |
| `/plugins/dsh-agent-roster/rosters` | POST | create / update / delete / import / export one roster |
| `/plugins/dsh-agent-roster/locale` | GET | `en` / `zh` dictionary for the panel |

All four are `exact` routes behind the host's `connection` fence and answer `405` for other methods.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rosterDirs` | `[]` | library directories. Empty means the global library `$DSH_HOME/agent-roster`; an absolute or `~` path is global too; only a relative path is resolved per workspace. The first entry is what the tools read by default |
| `knownToolPolicies` | `[]` | tool-policy ids declared by your deployment; enables cross-checks |
| `agentTeamsStateDir` | `.agent-teams` | read only: where `roster_verify` and the Teams tab look for team state |
| `language` | `"auto"` | panel language: `auto` follows DSH, or pin `zh` / `en` |

All four are `volatile`: changes apply immediately, no host restart.

## Diagnostics

Validation reports errors, warnings and infos with `file`, `path` and `reason`. Families:

- structure: `missing-field`, `unknown-key`, `invalid-type`, `invalid-kind`, `pair-required`, `invalid-value`
- values: `invalid-id`, `invalid-provider`, `invalid-model`, `invalid-semver`, `invalid-tag`, `invalid-tool-name`, `invalid-tool-policy-id`, `invalid-number`, `empty-tool-scope`
- safety: `reserved-character` (`^`, `$`, `|`, braces), `forbidden-content` (prompt-injection patterns), `single-line-required`
- limits: `string-too-long`, `too-many-members`, `too-many-values`
- library level: `library-missing`, `library-unusable`, `missing-roster-file`, `multiple-roster-files`, `unexpected-file`, `unreadable-file`, `unreadable-dir`, `duplicate-roster-id`, `tool-policy-cross-check-skipped`

An empty library is not an error. A missing one is reported as info, not error. `tool-policy-cross-check-skipped` is emitted **once per library** (not once per roster) when no `knownToolPolicies` are configured — a per-roster warning would turn one fact into n lines of noise.

## Relationship to `dsh-agent-teams`

`dsh-agent-teams` owns team lifecycles, task dispatch and member persistence. This plugin owns the *definition* of members and the honesty of the handoff: it reads `.agent-teams/<team>/team.json` (read-only) to verify what the runtime actually stored, and it degrades to "unconfirmed" when it cannot read it. No state is ever written.

## Development

```bash
npm install
npm test          # node --test, 133 cases
npm run smoke     # registers the tools against a real DSH bundle, asserts lossless output
node scripts/check-locale.mjs   # static t() keys must exist in both dictionaries
```

Layout:

```
index.js          host plugin: Config, apply, four routes
lib/              format, parse, validate, registry, bridge, verify, render, library,
                  config-view, json, http, write, service, teams-state, tools
client.js         client plugin: sidebar entry, main panel (rosters/teams/health), settings section
locale/           panel + listing dictionaries (en/zh)
bin/cli.mjs       validate/list/version for CI
scripts/          host-smoke.mjs, client-smoke.mjs, check-locale.mjs (dev only, not shipped)
examples/         two example libraries
test/             unit tests
```

## Verification status

Verified on this machine:

- `npm test` — 133/133 passing (format, parse, validate, registry, paths, bridge, verify, lossless JSON, write plan/apply, the four routes, panel snapshot and hints, dictionary consistency, tool contracts, client loader contract, library snapshot, config view, package manifest).
- `npm run smoke` — `apply()` registers all four tools through a real `defineTool` from a DSH bundle; `roster_list` / `roster_show` / `roster_create` / `roster_verify` execute, every output survives `lossless` checks, `path` overrides are honored, effect disposal runs cleanly. The same command then loads `client.js` against a stubbed module table and asserts the three slot registrations, style injection and effect disposal.
- CLI: `validate --dir examples` returns exit 0 over both example libraries.
- Installed into a real profile with the plugin manager (`plugin_manager install_bundle` against this directory → `link:` dependency + bundle entry); the profile re-reads the linked files on restart.
- The read-only route answered from the running host: `GET /plugins/dsh-agent-roster/library` → 200 with the plugin version and resolved rosters.
- A second agent session saw all four tools in its tool list and called them.
- The sidebar panel was confirmed visible with real roster data.

Not verified in this pass: the 0.2.0 management UI (tabs, editors, Teams view, language switch, `document` / `rosters` routes) inside a live page — those need a host restart to load the new modules, and are verified after it.

Three real defects were found by this verification and fixed:

1. `volatile()` config fields reach `apply()` as `{ get, write }` reference objects, so the panel and every tool were reading the defaults no matter what the settings form said. Reads now go through `lib/config-view.js`, which resolves references per access and falls back on type mismatch.
2. `roster_list` ignored its `path` argument and always scanned the configured directory. `resolvePaths` now treats an explicit `path` as an override.
3. Tool outputs carried `undefined`-valued keys, which the runtime rejects as `value is not lossless JSON`. Absent values are now `null` (or omitted), and every return value goes through `lib/json.js#lossless` first.

## License

MIT — see [LICENSE](./LICENSE).
