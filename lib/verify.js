/**
 * 核对：把"档案里写的"和"运行时实际记下的"逐字段摆在一起。
 *
 * 这一步是整个插件的判据所在。桥接参数生成得再漂亮，成员也可能因为运行时采用了队长默认模型、
 * 或者策略 id 不存在而悄悄降级；只有比对 `team.json` 里的实际值才能发现。
 *
 * @module dsh-agent-roster/verify
 */
import { buildMemberBinding, isBindingFaithful, reconcileBinding, summarizeBinding } from "./bridge.js";

/**
 * 逐个成员核对档案与团队状态。
 *
 * @param {object[]} rosters 已校验档案
 * @param {object[]} teams `readTeamStates` 产出的团队记录
 * @returns {{ checks: object[], unmanaged: object[], summary: object }}
 */
export function verifyBindings(rosters, teams) {
  const checks = [];
  const managedNames = new Set();

  for (const roster of rosters) {
    for (const member of roster.members) {
      managedNames.add(member.name);
      const matches = [];
      for (const team of teams) {
        const found = team.members.find((candidate) => candidate.name === member.name);
        if (found !== undefined) matches.push({ team, teamMember: found });
      }

      if (matches.length === 0) {
        checks.push({
          rosterId: roster.id,
          rosterVersion: roster.version,
          member: member.name,
          role: member.role,
          found: false,
          teamId: null,
          teamName: null,
          binding: null,
          faithful: false,
          summary: null,
        });
        continue;
      }

      for (const { team, teamMember } of matches) {
        const { binding } = buildMemberBinding(roster, member);
        reconcileBinding(binding, teamMember);
        checks.push({
          rosterId: roster.id,
          rosterVersion: roster.version,
          member: member.name,
          role: member.role,
          found: true,
          teamId: team.id,
          teamName: team.name,
          binding,
          faithful: isBindingFaithful(binding),
          summary: summarizeBinding(binding),
        });
      }
    }
  }

  const unmanaged = [];
  for (const team of teams) {
    for (const member of team.members) {
      if (managedNames.has(member.name)) continue;
      unmanaged.push({
        teamId: team.id,
        teamName: team.name,
        name: typeof member.name === "string" ? member.name : "",
        provider: typeof member.provider === "string" ? member.provider : "",
        model: typeof member.model === "string" ? member.model : "",
        toolPolicy: typeof member.toolPolicy === "string" ? member.toolPolicy : "",
      });
    }
  }

  const summary = {
    members: checks.length,
    deployed: checks.filter((check) => check.found).length,
    faithful: checks.filter((check) => check.found && check.faithful).length,
    degraded: checks.filter((check) => check.found && !check.faithful).length,
    missing: checks.filter((check) => !check.found).length,
    unmanaged: unmanaged.length,
  };

  return { checks, unmanaged, summary };
}

/**
 * 只核对指定成员（工具的参数级筛选）；其余成员不进入结果。
 *
 * @param {object} report `verifyBindings` 的结果
 * @param {string[]} names 成员名
 * @returns {object}
 */
export function filterChecks(report, names) {
  if (!Array.isArray(names) || names.length === 0) return report;
  const wanted = new Set(names);
  const checks = report.checks.filter((check) => wanted.has(check.member));
  const summary = {
    members: checks.length,
    deployed: checks.filter((check) => check.found).length,
    faithful: checks.filter((check) => check.found && check.faithful).length,
    degraded: checks.filter((check) => check.found && !check.faithful).length,
    missing: checks.filter((check) => !check.found).length,
    unmanaged: report.summary.unmanaged,
  };
  return { ...report, checks, summary };
}
