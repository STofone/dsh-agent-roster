/**
 * 档案库快照：把"文件系统里的档案"折叠成面板与只读路由能直接渲染的 JSON。
 *
 * 这一层是纯数据投影：不碰 ctx 的生命周期、不注册任何东西，只做三件可以单测的事——
 * 展开工作区 × 档案库目录、给每份档案配上它自己的诊断、跨库同名时点名冲突。
 * 放在 lib/ 而不是 index.js，是为了让测试不必拉起宿主（index.js 会 import dsh-tools）。
 *
 * @module dsh-agent-roster/library
 */
import nodePath from "node:path";

import { scanRosterLibrary } from "./registry.js";

/**
 * 采集档案库快照。
 *
 * 枚举宿主已知的每个工作区 × 每个配置的档案库目录；拿不到工作区注册表时退回进程工作目录
 * 并如实标注 `fallbackWorkspace`，而不是假装知道当前工作区。
 *
 * 多目录是并列的"库"，不合并：每座库单独出统计，同名档案（id 相同）在跨库时会被点名——
 * 两份同 id 的档案并存意味着"改了 A 生效的是 B"，这必须让用户看见。
 *
 * @param {{ get?: (key: string) => unknown }} ctx 只用到工作区注册表这一项能力
 * @param {object} config 插件配置
 * @param {{ name: string, version: string }} meta 插件自身元信息
 * @returns {object}
 */
export function collectLibrary(ctx, config, meta) {
  const registry = ctx.get?.("workspaceRegistry") ?? ctx.get?.("workspace") ?? undefined;
  const workspaces =
    registry !== undefined && typeof registry.list === "function"
      ? registry.list().map((workspace) => ({ title: workspace.title ?? "", path: workspace.path }))
      : [{ title: "", path: process.cwd(), fallback: true }];

  const dirSpecs = Array.isArray(config.rosterDirs) && config.rosterDirs.length > 0 ? config.rosterDirs : ["rosters"];

  const reports = [];
  for (const workspace of workspaces) {
    for (const dirSpec of dirSpecs) {
      const rootDir = nodePath.isAbsolute(dirSpec) ? dirSpec : nodePath.resolve(workspace.path, dirSpec);
      const scan = scanRosterLibrary({
        rootDir,
        knownToolPolicies: config.knownToolPolicies ?? null,
      });
      reports.push({
        workspace: workspace.title,
        workspacePath: workspace.path,
        fallbackWorkspace: workspace.fallback === true,
        dirSpec,
        rootDir,
        stats: scan.stats,
        rosters: scan.rosters.map((roster) => serializeRoster(roster, scan.diagnostics)),
        diagnostics: scan.diagnostics,
      });
    }
  }

  markDuplicateIds(reports);

  return {
    plugin: meta.name,
    version: meta.version,
    rosterDirs: dirSpecs,
    agentTeamsStateDir: config.agentTeamsStateDir,
    workspaces: reports,
  };
}

/**
 * 同一工作区里跨库重复的档案 id：在后来者上追加一条警告，列出先前那份文件。
 *
 * 只警告、不删档：用户的文件不该被插件悄悄忽略；面板与工具都会显示这条冲突。
 *
 * @param {object[]} reports
 * @returns {void}
 */
export function markDuplicateIds(reports) {
  const seen = new Map();
  for (const report of reports) {
    for (const roster of report.rosters) {
      const key = `${report.workspacePath}::${roster.id}`;
      const previous = seen.get(key);
      if (previous !== undefined) {
        const diagnostic = {
          severity: "warn",
          code: "duplicate-roster-id",
          path: "",
          file: roster.file,
          reason:
            `档案 id "${roster.id}" 与 ${previous} 重复。两份同 id 档案并存时，` +
            "工具按配置顺序取先出现的那份，改另一份不会生效；请删除或改名其中一份。",
        };
        report.diagnostics = [...report.diagnostics, diagnostic];
        roster.diagnostics = [...roster.diagnostics, diagnostic];
      } else {
        seen.set(key, `${report.rootDir}/${roster.file}`);
      }
    }
  }
}

/**
 * 面板用的档案投影：字段名保持档案里的 camelCase，减少一次翻译。
 *
 * 人设正文不外发（可能上千字），只给长度；与这份档案同目录的诊断会被带上，
 * 让面板在卡片上就能标出"这份有问题"，而不用把整张诊断表翻一遍。
 *
 * @param {object} roster 已通过校验的档案
 * @param {object[]} [scanDiagnostics] 整座库的诊断
 * @returns {object}
 */
export function serializeRoster(roster, scanDiagnostics = []) {
  const dir = roster.file.includes("/") ? roster.file.slice(0, roster.file.indexOf("/")) : "";
  const diagnostics = scanDiagnostics.filter(
    (item) => item?.file != null && (item.file === roster.file || String(item.file).startsWith(`${dir}/`)),
  );
  return {
    id: roster.id,
    version: roster.version,
    title: roster.title,
    description: roster.description,
    file: roster.file,
    tags: roster.tags,
    maintainers: roster.maintainers,
    defaults: roster.defaults,
    diagnostics,
    members: roster.members.map((member) => ({
      name: member.name,
      role: member.role,
      title: member.title,
      provider: member.provider ?? null,
      model: member.model ?? null,
      reasoningEffort: member.reasoningEffort ?? null,
      toolPolicy: member.toolPolicy ?? null,
      toolScope: member.toolScope ?? null,
      fallback: member.fallback ?? null,
      maxTokens: member.maxTokens ?? null,
      inherited: member.inherited ?? [],
      tags: member.tags,
      notes: member.notes,
      systemPromptChars: member.systemPrompt.length,
    })),
  };
}
