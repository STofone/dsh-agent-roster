/**
 * 只读地读取 dsh-agent-teams 的团队状态，用于核对"档案是否真的进了运行时"。
 *
 * 为什么读别人的状态文件，而不是问运行时 API：
 * - 状态文件是运行时自己写下的**实际值**（provider/model/toolPolicy/executionPrompt 都在里面），
 *   而工具调用参数只是"请求值"。验证必须比对实际值，否则就是让模型自我报告。
 * - agent-teams 的 `agent_teams_status` 只回传筛选后的视图，字段不全；
 *   `team.json` 里的 {@link TeamMember} 才是完整记录。
 *
 * 代价是耦合了它的目录布局与字段名（`.agent-teams/<teamId>/team.json`，TeamMember 用 camelCase）。
 * 因此这里**只读、容错、缺失即降级为诊断**：目录不在、字段没有、结构变了，都只是"无法核对"，
 * 绝不让档案层因为运行时升级而崩掉。适配其它运行时的实现只要提供同样的 `readTeamStates()`
 * 形状即可——这就是预留的适配层边界。
 *
 * @module dsh-agent-roster/teams-state
 */
import nodeFs from "node:fs";
import path from "node:path";

import { diagnostic } from "./parse.js";
import { messageOf } from "./registry.js";

/** 团队状态里用于核对桥接结果的字段（camelCase，取自 TeamMember）。 */
export const TEAM_MEMBER_KEYS = ["name", "role", "provider", "model", "reasoningEffort", "toolPolicy", "executionPrompt"];

/** 不属于任何团队的目录名：归档区不在核对范围内。 */
const NON_TEAM_DIRS = new Set(["archive"]);

/**
 * 读取一个 AgentTeams 状态根目录下的全部团队记录。
 *
 * @param {{ stateDir: string, fs?: object, teamId?: string }} options
 * @returns {{
 *   stateDir: string,
 *   teams: object[],
 *   diagnostics: object[],
 *   available: boolean,
 * }}
 */
export function readTeamStates(options = {}) {
  const stateDir = typeof options.stateDir === "string" ? options.stateDir : "";
  const fs = options.fs ?? nodeFs;
  const teamId = typeof options.teamId === "string" && options.teamId !== "" ? options.teamId : null;

  const result = { stateDir, teams: [], diagnostics: [], available: false };
  const report = (severity, code, p, reason) =>
    result.diagnostics.push(diagnostic(severity, code, p, reason, stateDir));

  if (stateDir === "") {
    report("error", "team-state-dir-unset", "", "没有配置 AgentTeams 状态目录（config.agentTeamsStateDir）");
    return result;
  }

  let stats;
  try {
    stats = fs.statSync(stateDir);
  } catch {
    report(
      "warn",
      "team-state-missing",
      "",
      `没有找到 AgentTeams 状态目录 ${stateDir}；只做档案静态校验，不核对运行时`,
    );
    return result;
  }
  if (!stats.isDirectory()) {
    report("error", "team-state-not-directory", "", `AgentTeams 状态路径不是目录：${stateDir}`);
    return result;
  }
  result.available = true;

  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch (error) {
    report("error", "team-state-unreadable", "", `无法读取团队状态目录：${messageOf(error)}`);
    result.available = false;
    return result;
  }

  for (const name of names.slice().sort()) {
    if (name.startsWith(".") || NON_TEAM_DIRS.has(name)) continue;
    if (teamId !== null && name !== teamId) continue;
    const dir = path.join(stateDir, name);
    let kind;
    try {
      kind = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!kind.isDirectory()) continue;
    const file = path.join(dir, "team.json");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      report("warn", "team-state-file-missing", name, `团队目录里没有 team.json，已跳过：${dir}`);
      continue;
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch (error) {
      report("error", "team-state-invalid-json", name, `team.json 不是合法 JSON：${messageOf(error)}`);
      continue;
    }
    if (state === null || typeof state !== "object" || !Array.isArray(state.members)) {
      report("error", "team-state-invalid-shape", name, "team.json 缺少 members 数组，无法核对");
      continue;
    }
    result.teams.push({
      id: typeof state.id === "string" && state.id !== "" ? state.id : name,
      dirName: name,
      name: typeof state.name === "string" ? state.name : name,
      description: typeof state.description === "string" ? state.description : "",
      phase: state.phase === "staged" ? "staged" : "running",
      planReviewState: typeof state.planReviewState === "string" ? state.planReviewState : null,
      halted: state.halted === true,
      escalated: state.escalated === true,
      captainSessionId: typeof state.captainSessionId === "string" ? state.captainSessionId : "",
      tasks: Array.isArray(state.tasks) ? state.tasks.filter((task) => task !== null && typeof task === "object") : [],
      file,
      members: state.members.filter((member) => member !== null && typeof member === "object"),
    });
  }

  if (result.teams.length === 0 && teamId === null) {
    report("warn", "team-state-empty", "", `状态目录里没有任何团队：${stateDir}`);
  }
  return result;
}

/**
 * 解析 AgentTeams 状态目录的绝对路径。
 *
 * 相对路径以当前会话工作区为基准（和 agent-teams 自己的 `join(workspace, stateDir)` 一致），
 * 拿不到工作区时退回进程工作目录。
 *
 * @param {string} stateDir 配置值
 * @param {string | undefined} workspacePath 会话工作区
 * @returns {string}
 */
export function resolveStateDir(stateDir, workspacePath) {
  const base = typeof workspacePath === "string" && workspacePath !== "" ? workspacePath : process.cwd();
  return path.isAbsolute(stateDir) ? stateDir : path.resolve(base, stateDir);
}
