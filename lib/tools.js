/**
 * 四个模型可见工具：列档案、看成员、生成桥接调用、核对运行时。
 *
 * 只读优先：`roster_list` / `roster_show` / `roster_verify` 只读文件系统；
 * `roster_create` 也不写任何东西——它输出的是**参数**，真正的成员创建仍由队长调用
 * dsh-agent-teams 的工具完成。插件不替运行时做决定，也不在背后改别人的状态。
 *
 * @module dsh-agent-roster/tools
 */
import path from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { buildMemberBinding, describeField, summarizeBinding } from "./bridge.js";
import { LIMITS } from "./format.js";
import { lossless } from "./json.js";
import { scanRosterLibrary, findRoster } from "./registry.js";
import { renderBridgePlan, renderRosterDetail, renderRosterList, renderVerifyReport } from "./render.js";
import { readTeamStates, resolveStateDir } from "./teams-state.js";
import { filterChecks, verifyBindings } from "./verify.js";

/** 工具输出统一的对象 schema：结构字段给程序，`text` 给人读。 */
const OUTPUT = { type: "object", additionalProperties: true };

/**
 * 模型可读内容 = `render()` 产出的文本块；结构化对象不会自动出现在里面。
 * 所以每个工具的首行都放一行 `k=v` 状态摘要：人扫一眼能懂，
 * 另一个模型也不必靠中文字样去猜这次调用是成功还是失败。
 */
function statusLine(tool, fields) {
  const body = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `[${tool}] ${body}`;
}

/**
 * 把工具注册进运行时。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config 由 index.js 的 Config 解析后的插件配置
 * @param {{ version: string }} meta 插件自身元信息（`roster_list` 里显示来源）
 * @returns {void}
 */
export function registerRosterTools(ctx, config, meta) {
  // args.path 是显式的档案库覆盖；没有就给配置里的 rosterDirs[0]。
  const resolve = (exec, override) => resolvePaths(config, exec, override);
  const scanAt = (rootDir) => scanRosterLibrary({ rootDir, knownToolPolicies: config.knownToolPolicies ?? null });

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_list",
          description:
            "列出一座本地档案库（roster 目录）里的全部成员档案，以及每份档案的校验结果。" +
            "档案是静态配置：写的是成员是谁、用什么模型、受哪些工具约束。" +
            "本工具只读不写；校验不通过的档案会单独列出原因，不会静默跳过。" +
            "需要看某个成员的完整人设时用 roster_show。",
          parameters: {
            path: {
              type: "string",
              description: "档案库目录；省略则用配置的 rosterDirs 第一项，再退到当前工作区的 rosters/",
            },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir, workspace } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const text = [
              statusLine("roster_list", {
                rootDir: rosterDir,
                total: scan.stats.total,
                ok: scan.stats.ok,
                failed: scan.stats.failed,
                members: scan.stats.members,
              }),
              renderRosterList(scan),
            ].join("\n\n");
            return lossless({
              source: `@stofone/dsh-agent-roster@${meta.version}`,
              workspace,
              rootDir: rosterDir,
              stats: scan.stats,
              rosters: scan.rosters.map((roster) => ({
                id: roster.id,
                version: roster.version,
                title: roster.title,
                file: roster.file,
                members: roster.members.map((member) => ({ name: member.name, role: member.role })),
                tags: roster.tags,
              })),
              diagnostics: scan.diagnostics,
              text,
            });
          },
          presentCall: () => ({ card: "generic", title: "档案列表" }),
          presentResult: (_args, result) => ({
            card: "generic",
            title: result.isError ? "档案列表失败" : "档案列表",
          }),
        }),
      ),
    "dsh-agent-roster: roster_list",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_show",
          description:
            "按档案 id 或成员名查看一份档案的完整内容：每个成员的模型路由、工具策略、声明层约束、人设长度与人设开头。" +
            "同时给出该成员的桥接字段清单（哪些字段运行时会真正接收、哪些只是声明）。" +
            "档案 id 与成员名冲突时返回歧义列表，不替你猜。",
          parameters: {
            ref: {
              type: "string",
              required: true,
              description: "档案 id（如 core-review）或其中某个成员名（如 reviewer）",
            },
            member: { type: "string", description: "只看这一名成员" },
            path: { type: "string", description: "档案库目录；省略时同 roster_list" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const hit = findRoster(scan.rosters, args.ref);
            if (hit === null) {
              const known = scan.rosters.map((roster) => `${roster.id}（${roster.members.map((m) => m.name).join(",")}）`);
              return lossless({
                found: false,
                text: [
                  statusLine("roster_show", { found: false, ref: args.ref }),
                  `没有档案或成员叫 "${args.ref}"。\n已知档案：${known.join("  ") || "（空）"}`,
                ].join("\n\n"),
                diagnostics: scan.diagnostics,
              });
            }
            if (hit.ambiguous !== undefined) {
              return lossless({
                found: false,
                ambiguous: hit.ambiguous.map((roster) => roster.id),
                text: [
                  statusLine("roster_show", {
                    found: false,
                    ambiguous: hit.ambiguous.map((roster) => roster.id).join(","),
                  }),
                  `成员名 "${args.ref}" 同时出现在多份档案里：${hit.ambiguous.map((roster) => roster.id).join(", ")}。\n` +
                    "请改用档案 id 指定要看哪一份。",
                ].join("\n\n"),
                diagnostics: scan.diagnostics,
              });
            }
            const roster = hit.roster;
            const only = args.member === undefined ? undefined : [args.member];
            const members = roster.members
              .filter((member) => only === undefined || only.includes(member.name))
              .map((member) => {
                const { binding } = buildMemberBinding(roster, member);
                return { member, fields: binding.fields, summary: summarizeBinding(binding) };
              });
            const text = [
              statusLine("roster_show", {
                found: true,
                roster: roster.id,
                version: roster.version,
                members: members.length,
                matchedBy: hit.via,
              }),
              renderRosterDetail(roster, only),
            ].join("\n\n");
            return lossless({
              found: true,
              matchedBy: hit.via,
              roster: {
                id: roster.id,
                version: roster.version,
                title: roster.title,
                description: roster.description,
                file: roster.file,
                tags: roster.tags,
                maintainers: roster.maintainers,
                defaults: roster.defaults,
              },
              members: members.map(({ member, fields, summary }) => ({
                name: member.name,
                role: member.role,
                provider: member.provider ?? null,
                model: member.model ?? null,
                reasoningEffort: member.reasoningEffort ?? null,
                toolPolicy: member.toolPolicy ?? null,
                systemPromptChars: member.systemPrompt.length,
                binding: fields,
                bindingSummary: summary,
              })),
              diagnostics: scan.diagnostics,
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: `查看档案 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "查看档案失败" : "档案详情" }),
        }),
      ),
    "dsh-agent-roster: roster_show",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_create",
          description:
            "把档案里的成员翻译成 dsh-agent-teams 的建员参数，逐个输出可直接使用的 agent_teams_add_member 调用（以及 agent_teams_create 的 plan.members 形式）。" +
            "本工具不创建成员、不写入团队状态；它只把档案翻译成参数，并逐个字段标注归宿：" +
            "运行时真正接收的、只作声明的、需要落部署配置的，分开写清楚。" +
            "拿到参数后由你原样调用 agent_teams_add_member；成员建好后用 roster_verify 核对实际值。",
          parameters: {
            ref: {
              type: "string",
              required: true,
              description: "档案 id 或成员名（成员名需在该档案中唯一）",
            },
            members: {
              type: "array",
              items: { type: "string" },
              description: "只桥接这些成员；省略则整份档案",
            },
            path: { type: "string", description: "档案库目录；省略时同 roster_list" },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            const hit = findRoster(scan.rosters, args.ref);
            const fail = (message) =>
              lossless({
                ok: false,
                text: [statusLine("roster_create", { ok: false, ref: args.ref }), message].join("\n\n"),
                diagnostics: scan.diagnostics,
              });
            if (hit === null) return fail(`没有档案或成员叫 "${args.ref}"。`);
            if (hit.ambiguous !== undefined) {
              return fail(`成员名 "${args.ref}" 在多份档案里都有，请改用档案 id：${hit.ambiguous.map((r) => r.id).join(", ")}`);
            }
            const roster = hit.roster;
            const wanted = Array.isArray(args.members) && args.members.length > 0 ? new Set(args.members) : null;
            const selected = roster.members.filter((member) => wanted === null || wanted.has(member.name));
            if (selected.length === 0) {
              return fail(
                `档案 ${roster.id} 里没有成员 ${[...(wanted ?? [])].join(", ")}；可用：${roster.members.map((m) => m.name).join(", ")}`,
              );
            }
            const entries = selected.map((member) => ({ member, ...buildMemberBinding(roster, member) }));
            const text = [
              statusLine("roster_create", {
                ok: true,
                roster: roster.id,
                version: roster.version,
                calls: entries.length,
              }),
              renderBridgePlan({ roster, entries }),
            ].join("\n\n");
            return lossless({
              ok: true,
              rosterId: roster.id,
              rosterVersion: roster.version,
              calls: entries.map((entry) => ({ tool: "agent_teams_add_member", arguments: entry.args })),
              planMembers: entries.map((entry) => entry.planMember),
              bindings: entries.map((entry) => ({
                member: entry.member.name,
                fields: entry.binding.fields,
                summary: summarizeBinding(entry.binding),
              })),
              nextStep: "把每个 calls[].arguments 原样传给 agent_teams_add_member；随后用 roster_verify 核对运行时实际值",
              diagnostics: scan.diagnostics,
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: `桥接档案 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "桥接失败" : "桥接参数" }),
        }),
      ),
    "dsh-agent-roster: roster_create",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "roster_verify",
          description:
            "核对档案是否真的进了运行时：读取 dsh-agent-teams 的 team.json，把每个成员持久化的 provider/model/reasoningEffort/toolPolicy/executionPrompt 与档案逐字段比对，报出一致、降级、缺失、未部署。" +
            "比对的是运行时实际记下的值，不是我们发出的参数，所以能发现被静默覆盖的模型或失效的工具策略。" +
            "运行时状态缺失时如实降级为「无法核对」，不会假装通过。本工具只读，不写团队状态。",
          parameters: {
            ref: { type: "string", description: "只核对这份档案（id 或成员名）；省略则核对整座档案库" },
            team: { type: "string", description: "只核对这个团队 id；省略则核对全部在用团队" },
            stateDir: {
              type: "string",
              description: "AgentTeams 状态目录；省略则用配置的 agentTeamsStateDir（默认 .agent-teams，相对当前工作区）",
            },
            path: { type: "string", description: "档案库目录；省略时同 roster_list" },
            members: {
              type: "array",
              items: { type: "string" },
              description: "只核对这些成员名",
            },
          },
          output: { schema: OUTPUT, render: (_args, value) => [{ type: "text", text: value.text }] },
          async execute(args, exec) {
            const { rosterDir, workspace } = resolve(exec, args.path);
            const scan = scanAt(rosterDir);
            let rosters = scan.rosters;
            let refRosterIds = [];
            if (args.ref !== undefined) {
              const hit = findRoster(rosters, args.ref);
              if (hit === null) {
                return lossless({
                  ok: false,
                  text: [statusLine("roster_verify", { ok: false, ref: args.ref }), `没有档案或成员叫 "${args.ref}"，无从核对。`].join(
                    "\n\n",
                  ),
                  diagnostics: scan.diagnostics,
                });
              }
              if (hit.ambiguous !== undefined) {
                return lossless({
                  ok: false,
                  text: [
                    statusLine("roster_verify", { ok: false, ambiguous: hit.ambiguous.map((r) => r.id).join(",") }),
                    `成员名 "${args.ref}" 在多份档案里都有，请改用档案 id：${hit.ambiguous.map((r) => r.id).join(", ")}`,
                  ].join("\n\n"),
                  diagnostics: scan.diagnostics,
                });
              }
              rosters = [hit.roster];
              refRosterIds = [hit.roster.id];
            }

            const stateDir = resolveStateDir(args.stateDir ?? config.agentTeamsStateDir ?? ".agent-teams", workspace);
            const state = readTeamStates({ stateDir, teamId: args.team });
            let report = verifyBindings(rosters, state.teams);
            if (Array.isArray(args.members) && args.members.length > 0) {
              report = filterChecks(report, args.members);
            }
            const ok = report.summary.degraded === 0 && state.available;
            const text = [
              statusLine("roster_verify", {
                ok,
                state: state.available ? "available" : "unavailable",
                members: report.summary.members,
                deployed: report.summary.deployed,
                faithful: report.summary.faithful,
                degraded: report.summary.degraded,
                missing: report.summary.missing,
                unmanaged: report.summary.unmanaged,
              }),
              renderVerifyReport(report, { rosterIds: refRosterIds }),
            ].join("\n\n");
            return lossless({
              ok,
              stateDir,
              teams: state.teams.map((team) => ({ id: team.id, name: team.name, phase: team.phase, file: team.file })),
              summary: report.summary,
              checks: report.checks.map((check) => ({
                rosterId: check.rosterId,
                rosterVersion: check.rosterVersion,
                member: check.member,
                found: check.found,
                teamId: check.teamId,
                faithful: check.faithful,
                fields: check.binding === null ? [] : check.binding.fields,
              })),
              unmanaged: report.unmanaged,
              diagnostics: [...scan.diagnostics, ...state.diagnostics],
              text,
            });
          },
          presentCall: (args) => ({ card: "generic", title: args.ref === undefined ? "核对全部档案" : `核对 ${args.ref}` }),
          presentResult: (_args, result) => ({ card: "generic", title: result.isError ? "核对失败" : "档案核对报告" }),
        }),
      ),
    "dsh-agent-roster: roster_verify",
  );
}

/**
 * 解析档案库与工作区路径。
 *
 * 相对路径一律相对当前会话工作区（和 agent-teams 解析 `.agent-teams` 的方式一致）；
 * 拿不到会话时退回进程工作目录，并在诊断里说明——猜测工作区比报错更糟。
 *
 * 工具参数里的 `path` 是**显式覆盖**：给了就只信它，不再回落配置，避免"传了参数却
 * 静默读默认目录"这种最难查的行为（真机验证里正是这个 bug）。
 *
 * @param {object} config
 * @param {{ agent?: object }} exec
 * @param {string | undefined} override 工具参数里的档案库目录
 * @returns {{ rosterDir: string, workspace: string, workspaceKnown: boolean, overridden: boolean }}
 */
export function resolvePaths(config, exec, override) {
  const fromSession = exec?.agent?.session?.header?.cwd;
  const workspaceKnown = typeof fromSession === "string" && fromSession !== "";
  const workspace = workspaceKnown ? fromSession : process.cwd();
  const hasOverride = typeof override === "string" && override !== "";
  const configured = hasOverride
    ? override
    : Array.isArray(config.rosterDirs) && config.rosterDirs.length > 0
      ? config.rosterDirs[0]
      : "rosters";
  const rosterDir = path.isAbsolute(configured) ? configured : path.resolve(workspace, configured);
  return { rosterDir, workspace, workspaceKnown, overridden: hasOverride };
}

/** 供 CLI 与测试复用：把诊断折成一行摘要。 */
export function summarizeDiagnostics(diagnostics) {
  const list = diagnostics ?? [];
  const errors = list.filter((item) => item.severity === "error").length;
  const warnings = list.filter((item) => item.severity === "warn").length;
  return { errors, warnings, total: list.length, maxChars: LIMITS.descriptionChars };
}

/** 供 CLI 复用的字段说明行。 */
export { describeField };
