/**
 * 核对：把"档案里写的"和"运行时实际记下的"逐字段摆在一起。
 *
 * 这一步是整个插件的判据所在：桥接参数生成得再漂亮，成员也可能因为运行时采用了队长默认模型、
 * 或者策略 id 不存在而悄悄降级；只有比对 `team.json` 里的实际值才能发现。
 *
 * 两条补充规则：
 * - `aliases` 让改名后的成员仍然认得出旧名。团队状态里存的是旧名时不算漂移，
 *   否则每次重命名都会制造一堆"未托管"的假报警。
 * - `skills` 是声明层字段，运行时不会帮你加载技能；宿主把技能目录传进来时，
 *   这里只负责回答"声明了但没装"这一件事，不假装已生效。
 *
 * @module dsh-agent-roster/verify
 */
import { buildMemberBinding, isBindingFaithful, reconcileBinding, summarizeBinding } from "./bridge.js";

/**
 * 逐个成员核对档案与团队状态。
 *
 * @param {object[]} rosters 已校验档案
 * @param {object[]} teams `readTeamStates` 产出的团队记录
 * @param {{ knownSkills?: string[] }} [options] 宿主已知技能目录；缺省表示无法核对技能
 * @returns {{ checks: object[], unmanaged: object[], skills: object[], summary: object }}
 */
export function verifyBindings(rosters, teams, options = {}) {
  const knownSkills =
    Array.isArray(options.knownSkills) && options.knownSkills.length > 0
      ? new Set(options.knownSkills.filter((name) => typeof name === "string" && name !== ""))
      : null;

  const checks = [];
  const managedNames = new Set();

  for (const roster of rosters) {
    for (const member of roster.members) {
      managedNames.add(member.name);
      const aliases = new Set(Array.isArray(member.aliases) ? member.aliases : []);
      for (const alias of aliases) managedNames.add(alias);

      const matches = [];
      for (const team of teams) {
        const found = team.members.find(
          (candidate) => candidate.name === member.name || aliases.has(candidate.name),
        );
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
          matchedAs: null,
          binding: null,
          faithful: false,
          summary: null,
        });
        continue;
      }

      for (const { team, teamMember } of matches) {
        const { binding } = buildMemberBinding(roster, member);
        reconcileBinding(binding, teamMember);
        // 通过别名匹配上时，`name` 本来就该不同：把它记成"降级"会让每次改名都变成假报警。
        if (teamMember.name !== member.name) {
          const nameField = binding.fields.find((field) => field.field === "name");
          if (nameField !== undefined) {
            nameField.status = "applied";
            nameField.actual = teamMember.name;
            nameField.note = `运行时以曾用名 "${teamMember.name}" 记录`;
          }
        }
        checks.push({
          rosterId: roster.id,
          rosterVersion: roster.version,
          member: member.name,
          role: member.role,
          found: true,
          teamId: team.id,
          teamName: team.name,
          matchedAs: teamMember.name,
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

  const skills = [];
  for (const roster of rosters) {
    for (const member of roster.members) {
      const declared = Array.isArray(member.skills) ? member.skills : [];
      if (declared.length === 0) continue;
      const missing = knownSkills === null ? [] : declared.filter((name) => !knownSkills.has(name));
      skills.push({
        rosterId: roster.id,
        member: member.name,
        declared,
        missing,
        checked: knownSkills !== null,
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
    skillsDeclared: skills.length,
    skillsMissing: skills.filter((item) => item.missing.length > 0).length,
    skillsUnverified: skills.filter((item) => !item.checked).length,
  };

  return { checks, unmanaged, skills, summary };
}

/**
 * 只核对指定成员（工具的参数级筛选）；其余成员不进入结果。
 *
 * 筛选同时接受成员名与它的别名，免得对着旧名筛不出东西。
 *
 * @param {object} report `verifyBindings` 的结果
 * @param {string[]} names 成员名或别名
 * @returns {object}
 */
export function filterChecks(report, names) {
  if (!Array.isArray(names) || names.length === 0) return report;
  const wanted = new Set(names);
  const checks = report.checks.filter(
    (check) => wanted.has(check.member) || (check.matchedAs !== null && wanted.has(check.matchedAs)),
  );
  const summary = {
    ...report.summary,
    members: checks.length,
    deployed: checks.filter((check) => check.found).length,
    faithful: checks.filter((check) => check.found && check.faithful).length,
    degraded: checks.filter((check) => check.found && !check.faithful).length,
    missing: checks.filter((check) => !check.found).length,
  };
  return { ...report, checks, summary };
}
