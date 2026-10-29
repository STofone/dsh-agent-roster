/**
 * 档案语义校验：纯函数、零 IO。
 *
 * 同一份规则同时供运行时（加载档案时）与 CI（`dsh-agent-roster validate --check`）使用，
 * 因此这里不允许读文件、不允许打印、不允许抛异常。
 *
 * 原则：**未知键拒绝**。一个拼错的字段名如果被放过，档案看起来生效了而运行时什么也没做，
 * 这比直接报错危险得多。
 *
 * @module dsh-agent-roster/validate
 */
import { diagnostic } from "./parse.js";
import {
  CAPTAIN_FIELDS,
  DEFAULTS_FIELDS,
  FIELD_BINDING,
  LIMITS,
  MEMBER_FIELDS,
  PATTERNS,
  REASONING_EFFORTS,
  ROSTER_FIELDS,
  ROSTER_KIND,
} from "./format.js";

const SINGLE_LINE_FIELDS = new Set(["title", "role", "description", "notes", "license"]);
const PIPE_SAFE_FIELDS = new Set(["title", "role"]);
const MAX_TOKENS_CEILING = 4_000_000;
const MAX_TOOL_PATTERNS = 64;

/**
 * 校验一份已解析的档案文档。
 *
 * @param {unknown} value `parse.js` 产出的对象树
 * @param {{
 *   file?: string,
 *   expectedId?: string,
 *   knownToolPolicies?: string[],
 * }} [options]
 * @returns {{ ok: boolean, roster: object | null, diagnostics: object[] }}
 */
export function validateRoster(value, options = {}) {
  const file = String(options.file ?? "");
  const expectedId = typeof options.expectedId === "string" ? options.expectedId : null;
  const knownToolPolicies = Array.isArray(options.knownToolPolicies)
    ? options.knownToolPolicies.filter((id) => typeof id === "string" && id !== "")
    : null;
  const diagnostics = [];
  const report = (severity, code, path, reason) =>
    diagnostics.push(diagnostic(severity, code, path, reason, file));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    report("error", "document-not-mapping", "", "文档顶层必须是映射（对象）");
    return { ok: false, roster: null, diagnostics };
  }

  rejectUnknownKeys(value, ROSTER_FIELDS, "", "顶层", report);
  guardContent(value, "", report);

  // ── 标识与版本 ────────────────────────────────────────────────────────────
  if (value.kind !== ROSTER_KIND) {
    report(
      "error",
      "invalid-kind",
      "kind",
      `kind 必须是 "${ROSTER_KIND}"，实际是 ${describe(value.kind)}`,
    );
  }

  const rosterId = value.roster;
  if (typeof rosterId !== "string" || rosterId === "") {
    report("error", "missing-field", "roster", "缺少 roster（档案 id）");
  } else if (!PATTERNS.id.test(rosterId)) {
    report("error", "invalid-id", "roster", `roster 必须是 kebab-case 的 2~64 字符：${rosterId}`);
  } else if (expectedId !== null && rosterId !== expectedId) {
    report(
      "error",
      "roster-id-mismatch",
      "roster",
      `roster 字段（${rosterId}）必须与所在目录名（${expectedId}）一致`,
    );
  }

  if (typeof value.version !== "string" || value.version === "") {
    report("error", "missing-field", "version", "缺少 version（精确 SemVer）");
  } else if (!PATTERNS.semver.test(value.version)) {
    report("error", "invalid-semver", "version", `version 必须是精确 SemVer：${value.version}`);
  }

  const title = optionalSingleLine(value.title, "title", LIMITS.titleChars, report);
  const description = optionalSingleLine(value.description, "description", LIMITS.descriptionChars, report);
  const license = optionalSingleLine(value.license, "license", LIMITS.titleChars, report);
  const maintainers = stringList(value.maintainers, "maintainers", 16, LIMITS.titleChars, report);
  const tags = tagList(value.tags, "tags", report);

  // ── defaults ─────────────────────────────────────────────────────────────
  const defaults = validateDefaults(value.defaults, report);

  // ── members ──────────────────────────────────────────────────────────────
  const members = [];
  const rawMembers = value.members;
  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    report("error", "missing-field", "members", "members 必须是非空数组");
  } else if (rawMembers.length > LIMITS.members) {
    report("error", "too-many-members", "members", `members 最多 ${LIMITS.members} 个`);
  } else {
    const seen = new Map();
    rawMembers.forEach((raw, index) => {
      const member = validateMember(
        raw,
        defaults,
        `members[${index}]`,
        knownToolPolicies,
        report,
        diagnostics,
      );
      if (member === null) return;
      const previous = seen.get(member.name);
      if (previous !== undefined) {
        report(
          "error",
          "duplicate-member",
          `${at(index)}.name`,
          `成员 name 重复：${member.name}（另见 members[${previous}]）`,
        );
        return;
      }
      seen.set(member.name, index);
      members.push(member);
    });
  }

  const failed = diagnostics.some((item) => item.severity === "error");
  if (failed) return { ok: false, roster: null, diagnostics };

  const beforeCaptain = diagnostics.length;
  const captain = validateCaptainDocument(value.captain, report);
  if (diagnostics.length > beforeCaptain) {
    return { ok: false, roster: null, diagnostics };
  }
  reportAliasCollisions(members, report);

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, roster: null, diagnostics };
  }

  return {
    ok: true,
    roster: {
      kind: value.kind,
      id: rosterId,
      version: value.version,
      title: title ?? rosterId,
      description: description ?? "",
      license: license ?? "",
      maintainers,
      tags,
      defaults,
      captain,
      members,
      file,
    },
    diagnostics,
  };
}

/**
 * `aliases` 是"成员改过名"的显式记录：核对时旧名会被认作同一个成员。
 * 因此别名既不能撞别人，也不能互相撞——否则核对结果取决于遍历顺序。
 */
function reportAliasCollisions(members, report) {
  const names = new Map();
  for (const member of members) names.set(member.name, member.name);
  const aliases = new Map();
  members.forEach((member, index) => {
    member.aliases.forEach((alias, aliasIndex) => {
      const path = `members[${index}].aliases[${aliasIndex}]`;
      if (names.has(alias)) {
        report("error", "alias-collision", path, `别名 "${alias}" 与现有成员重名`);
        return;
      }
      const owner = aliases.get(alias);
      if (owner !== undefined) {
        report("error", "alias-collision", path, `别名 "${alias}" 已被成员 "${owner}" 占用`);
        return;
      }
      aliases.set(alias, member.name);
    });
  });
}

/**
 * 校验可选的 captain 段。返回 null 表示未写，false 表示写错，其余是归一化对象。
 *
 * 队长不是成员：agent-teams 里它就是创建团队的那个会话。这里只允许"描述它应该是什么样"，
 * 并给出落地提示，绝不假装档案能改写队长的路由。
 */
function validateCaptainDocument(raw, report) {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    report("error", "invalid-type", "captain", "captain 必须是映射（对象）");
    return null;
  }
  rejectUnknownKeys(raw, CAPTAIN_FIELDS, "captain", "captain", report);

  const name = raw.name;
  if (typeof name !== "string" || name === "") {
    report("error", "missing-field", "captain.name", "captain 需要 name（给队长一个可引用的名字）");
  } else if (!PATTERNS.id.test(name)) {
    report("error", "invalid-id", "captain.name", `captain.name 必须是 kebab-case 的 2~64 字符：${name}`);
  }

  const description = optionalSingleLine(raw.description, "captain.description", LIMITS.descriptionChars, report);
  const personaPrefix = optionalText(raw.personaPrefix, "captain.personaPrefix", LIMITS.captainChars, report);
  const systemPrompt = optionalText(raw.systemPrompt, "captain.systemPrompt", LIMITS.systemPromptChars, report);

  const route = {};
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !PATTERNS.provider.test(raw.provider)) {
      report("error", "invalid-provider", "captain.provider", `provider 形态不合法：${describe(raw.provider)}`);
    } else {
      route.provider = raw.provider;
    }
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !PATTERNS.model.test(raw.model)) {
      report("error", "invalid-model", "captain.model", `model 形态不合法：${describe(raw.model)}`);
    } else {
      route.model = raw.model;
    }
  }
  if (raw.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(raw.reasoningEffort)) {
      report(
        "error",
        "invalid-reasoning-effort",
        "captain.reasoningEffort",
        `reasoningEffort 只能是 ${REASONING_EFFORTS.join("|")}`,
      );
    } else {
      route.reasoningEffort = raw.reasoningEffort;
    }
  }
  if ((route.provider === undefined) !== (route.model === undefined)) {
    report(
      "error",
      "pair-required",
      route.provider === undefined ? "captain.provider" : "captain.model",
      "captain 的 provider 与 model 必须同时出现",
    );
  }

  const captain = { name, description: description ?? "", systemPrompt: systemPrompt ?? "", personaPrefix: personaPrefix ?? "" };
  Object.assign(captain, route);
  return captain;
}

/** 多行可选文本（persona/prompt 片段）：只卡长度与 NUL，换行是合法的。 */
function optionalText(raw, path, maxChars, report) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    report("error", "invalid-type", path, "必须是字符串");
    return undefined;
  }
  const value = raw.replace(/\r\n/g, "\n").trim();
  if (value === "") {
    report("error", "invalid-value", path, "不允许空字符串（不需要这个字段就整个省略）");
    return undefined;
  }
  if (value.length > maxChars) {
    report("error", "string-too-long", path, `${value.length} 字符，超过上限 ${maxChars}`);
    return undefined;
  }
  return value;
}

/** 校验 defaults 段；返回只含合法字段的归一化对象。 */
function validateDefaults(raw, report) {
  const defaults = {};
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    report("error", "invalid-type", "defaults", "defaults 必须是映射（对象）");
    return defaults;
  }
  rejectUnknownKeys(raw, DEFAULTS_FIELDS, "defaults", "defaults", report);
  const route = validateRoute(raw, "defaults", report);
  if (route.provider !== undefined) defaults.provider = route.provider;
  if (route.model !== undefined) defaults.model = route.model;
  if (route.reasoningEffort !== undefined) defaults.reasoningEffort = route.reasoningEffort;
  if (route.toolPolicy !== undefined) defaults.toolPolicy = route.toolPolicy;
  if (route.toolScope !== undefined) defaults.toolScope = route.toolScope;
  if (route.fallback !== undefined) defaults.fallback = route.fallback;
  return defaults;
}

/** 校验一个成员；返回归一化成员或 null（已产生 error 时）。 */
function validateMember(raw, defaults, path, knownToolPolicies, report, diagnostics) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    report("error", "invalid-type", path, "成员必须是映射（对象）");
    return null;
  }
  const before = diagnostics.length;
  rejectUnknownKeys(raw, MEMBER_FIELDS, path, "成员", report);

  const name = raw.name;
  if (typeof name !== "string" || name === "") {
    report("error", "missing-field", `${path}.name`, "缺少 name（成员的运行时唯一名）");
  } else if (!PATTERNS.id.test(name)) {
    report("error", "invalid-id", `${path}.name`, `name 必须是 kebab-case 的 2~64 字符：${name}`);
  }

  const role = requiredSingleLine(raw.role, `${path}.role`, LIMITS.roleChars, report);

  const systemPrompt = raw.systemPrompt;
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    report("error", "missing-field", `${path}.systemPrompt`, "缺少 systemPrompt（成员人设）");
  } else if (systemPrompt.length > LIMITS.systemPromptChars) {
    report(
      "error",
      "string-too-long",
      `${path}.systemPrompt`,
      `systemPrompt 共 ${systemPrompt.length} 字符，超过上限 ${LIMITS.systemPromptChars}`,
    );
  } else if (/\n\s*````/.test(systemPrompt)) {
    report(
      "error",
      "fence-injection",
      `${path}.systemPrompt`,
      "systemPrompt 含 4 个及以上反引号的围栏行，会破坏下游提示结构",
    );
  }

  const route = validateRoute(raw, path, report);
  const inherited = [];
  const merged = {};
  for (const key of ["provider", "model", "reasoningEffort", "toolPolicy", "toolScope", "fallback"]) {
    if (route[key] !== undefined) {
      merged[key] = route[key];
    } else if (defaults[key] !== undefined) {
      merged[key] = defaults[key];
      inherited.push(key);
    }
  }

  // provider / model 必须成对：只给 provider 时 agent-teams 会退回队长模型，
  // 档案的意图就静默丢失了，所以这里直接拒绝。
  const hasProvider = merged.provider !== undefined;
  const hasModel = merged.model !== undefined;
  if (hasProvider !== hasModel) {
    report(
      "error",
      "pair-required",
      hasProvider ? `${path}.model` : `${path}.provider`,
      "provider 与 model 必须同时出现；缺一个会让运行时静默沿用队长模型",
    );
  }

  const toolPolicy = merged.toolPolicy;
  if (
    typeof toolPolicy === "string" &&
    knownToolPolicies !== null &&
    knownToolPolicies.length > 0 &&
    !knownToolPolicies.includes(toolPolicy)
  ) {
    report(
      "error",
      "unknown-tool-policy",
      `${path}.toolPolicy`,
      `toolPolicy "toolPolicy=${toolPolicy}" 不在部署已声明的策略里（已知：${knownToolPolicies.join(", ")}）；` +
        "运行时只接受已声明 id，请改用已存在的策略或把它写进 agent-teams 的 toolPolicies 配置",
    );
  }

  const maxTokens = optionalMaxTokens(raw.maxTokens, `${path}.maxTokens`, report);
  const title = optionalSingleLine(raw.title, `${path}.title`, LIMITS.titleChars, report);
  const notes = optionalSingleLine(raw.notes, `${path}.notes`, LIMITS.notesChars, report);
  const description = optionalSingleLine(raw.description, `${path}.description`, LIMITS.descriptionChars, report);
  const tags = tagList(raw.tags, `${path}.tags`, report);
  const aliases = idList(raw.aliases, `${path}.aliases`, LIMITS.aliasesPerMember, report);
  const skills = skillList(raw.skills, `${path}.skills`, LIMITS.skillsPerMember, report);
  const examples = textList(raw.examples, `${path}.examples`, LIMITS.examplesPerMember, LIMITS.exampleChars, report);

  if (typeof name === "string" && aliases.includes(name)) {
    report("error", "alias-collision", `${path}.aliases`, `别名不允许包含成员自己的名字：${name}`);
  }

  if (before !== diagnostics.length) return null;

  const member = {
    name,
    role,
    systemPrompt,
    title: title ?? name,
    notes: notes ?? "",
    description: description ?? "",
    tags,
    aliases,
    skills,
    examples,
  };
  for (const key of ["provider", "model", "reasoningEffort", "toolPolicy", "toolScope", "fallback"]) {
    if (merged[key] !== undefined) member[key] = merged[key];
  }
  if (maxTokens !== undefined) member.maxTokens = maxTokens;
  if (inherited.length > 0) member.inherited = inherited;
  return member;
}

/** 校验 provider/model/reasoningEffort/toolPolicy/toolScope/fallback 这一组路由字段。 */
function validateRoute(raw, path, report) {
  const out = {};
  const p = (key) => (path === "" ? key : `${path}.${key}`);

  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !PATTERNS.provider.test(raw.provider)) {
      report("error", "invalid-provider", p("provider"), `provider 形态不合法：${describe(raw.provider)}`);
    } else {
      out.provider = raw.provider;
    }
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !PATTERNS.model.test(raw.model)) {
      report("error", "invalid-model", p("model"), `model 形态不合法：${describe(raw.model)}`);
    } else {
      out.model = raw.model;
    }
  }
  if (raw.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(raw.reasoningEffort)) {
      report(
        "error",
        "invalid-reasoning-effort",
        p("reasoningEffort"),
        `reasoningEffort 只能是 ${REASONING_EFFORTS.join("|")}，实际是 ${describe(raw.reasoningEffort)}`,
      );
    } else {
      out.reasoningEffort = raw.reasoningEffort;
    }
  }
  if (raw.toolPolicy !== undefined) {
    if (typeof raw.toolPolicy !== "string" || !PATTERNS.id.test(raw.toolPolicy)) {
      report("error", "invalid-tool-policy-id", p("toolPolicy"), `toolPolicy 必须是策略 id：${describe(raw.toolPolicy)}`);
    } else {
      out.toolPolicy = raw.toolPolicy;
    }
  }
  if (raw.toolScope !== undefined) {
    const scope = validateToolScope(raw.toolScope, p("toolScope"), report);
    if (scope !== null) out.toolScope = scope;
  }
  if (raw.fallback !== undefined) {
    const fallback = validateFallback(raw.fallback, p("fallback"), report);
    if (fallback !== null) out.fallback = fallback;
  }
  return out;
}

/** `{allow?: string[], deny?: string[]}`：声明层工具范围。 */
function validateToolScope(raw, path, report) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    report("error", "invalid-type", path, "toolScope 必须是映射（对象）");
    return null;
  }
  const allowed = ["allow", "deny"];
  let bad = false;
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      report("error", "unknown-key", `${path}.${key}`, `toolScope 只接受 allow 与 deny，收到 ${key}`);
      bad = true;
    }
  }
  const out = {};
  for (const key of allowed) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) {
      report("error", "invalid-type", `${path}.${key}`, `toolScope.${key} 必须是字符串数组`);
      bad = true;
      continue;
    }
    if (raw[key].length > MAX_TOOL_PATTERNS) {
      report("error", "too-many-values", `${path}.${key}`, `toolScope.${key} 最多 ${MAX_TOOL_PATTERNS} 项`);
      bad = true;
      continue;
    }
    const values = [];
    raw[key].forEach((item, index) => {
      if (typeof item !== "string" || !PATTERNS.toolPattern.test(item)) {
        report("error", "invalid-tool-name", `${path}.${key}[${index}]`, `工具名不合法：${describe(item)}`);
        bad = true;
        return;
      }
      values.push(item);
    });
    out[key] = values;
  }
  if (!bad && (out.allow?.length ?? 0) === 0 && (out.deny?.length ?? 0) === 0) {
    report("warn", "empty-tool-scope", path, "toolScope 既没有 allow 也没有 deny，等于没写");
  }
  return bad ? null : out;
}

/** 备用路由：provider 与 model 必须同时给出。 */
function validateFallback(raw, path, report) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    report("error", "invalid-type", path, "fallback 必须是 {provider, model} 对象");
    return null;
  }
  let bad = false;
  for (const key of Object.keys(raw)) {
    if (key !== "provider" && key !== "model") {
      report("error", "unknown-key", `${path}.${key}`, `fallback 只接受 provider 与 model，收到 ${key}`);
      bad = true;
    }
  }
  if (typeof raw.provider !== "string" || !PATTERNS.provider.test(raw.provider)) {
    report("error", "invalid-provider", `${path}.provider`, `fallback.provider 形态不合法：${describe(raw.provider)}`);
    bad = true;
  }
  if (typeof raw.model !== "string" || !PATTERNS.model.test(raw.model)) {
    report("error", "invalid-model", `${path}.model`, `fallback.model 形态不合法：${describe(raw.model)}`);
    bad = true;
  }
  return bad ? null : { provider: raw.provider, model: raw.model };
}

function optionalMaxTokens(raw, path, report) {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_TOKENS_CEILING) {
    report("error", "invalid-number", path, `maxTokens 必须是 1~${MAX_TOKENS_CEILING} 的整数：${describe(raw)}`);
    return undefined;
  }
  return raw;
}

function tagList(raw, path, report) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-type", path, "tags 必须是字符串数组");
    return [];
  }
  if (raw.length > LIMITS.tagsPerEntry) {
    report("error", "too-many-values", path, `tags 最多 ${LIMITS.tagsPerEntry} 项`);
    return [];
  }
  const out = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !PATTERNS.tag.test(item)) {
      report("error", "invalid-tag", `${path}[${index}]`, `tag 必须是小写 kebab-case：${describe(item)}`);
      return;
    }
    out.push(item);
  });
  return out;
}

/** kebab-case id 数组（别名用）：去重、限数量、不允许空串。 */
function idList(raw, path, max, report) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-type", path, "必须是字符串数组");
    return [];
  }
  if (raw.length > max) {
    report("error", "too-many-values", path, `最多 ${max} 项`);
    return [];
  }
  const out = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !PATTERNS.id.test(item)) {
      report("error", "invalid-id", `${path}[${index}]`, `必须是 kebab-case 的 2~64 字符：${describe(item)}`);
      return;
    }
    if (out.includes(item)) {
      report("error", "duplicate-value", `${path}[${index}]`, `重复项：${item}`);
      return;
    }
    out.push(item);
  });
  return out;
}

/** 技能名数组：与 DSH 技能目录同名，允许点与下划线。 */
function skillList(raw, path, max, report) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-type", path, "必须是字符串数组");
    return [];
  }
  if (raw.length > max) {
    report("error", "too-many-values", path, `最多 ${max} 项`);
    return [];
  }
  const out = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || !PATTERNS.skill.test(item)) {
      report("error", "invalid-skill", `${path}[${index}]`, `技能名不合法：${describe(item)}`);
      return;
    }
    if (out.includes(item)) {
      report("error", "duplicate-value", `${path}[${index}]`, `重复项：${item}`);
      return;
    }
    out.push(item);
  });
  return out;
}

/** 单行文本数组（examples 用）。 */
function textList(raw, path, max, maxChars, report) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-type", path, "必须是字符串数组");
    return [];
  }
  if (raw.length > max) {
    report("error", "too-many-values", path, `最多 ${max} 项`);
    return [];
  }
  const out = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      report("error", "invalid-value", `${path}[${index}]`, "必须是非空字符串");
      return;
    }
    const value = item.trim();
    if (value.length > maxChars) {
      report("error", "string-too-long", `${path}[${index}]`, `${value.length} 字符，超过上限 ${maxChars}`);
      return;
    }
    if (/[\r\n]/.test(value)) {
      report("error", "single-line-required", `${path}[${index}]`, "必须是单行文本");
      return;
    }
    out.push(value);
  });
  return out;
}

function stringList(raw, path, max, maxChars, report) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    report("error", "invalid-type", path, "必须是字符串数组");
    return [];
  }
  if (raw.length > max) {
    report("error", "too-many-values", path, `最多 ${max} 项`);
    return [];
  }
  const out = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "" || item.length > maxChars) {
      report("error", "invalid-value", `${path}[${index}]`, `必须是 1~${maxChars} 字符的非空字符串`);
      return;
    }
    out.push(item.trim());
  });
  return out;
}

function requiredSingleLine(raw, path, maxChars, report) {
  if (typeof raw !== "string" || raw.trim() === "") {
    report("error", "missing-field", path, "必填的单行文本");
    return "";
  }
  const value = raw.trim();
  if (value.length > maxChars) {
    report("error", "string-too-long", path, `${value.length} 字符，超过上限 ${maxChars}`);
    return value;
  }
  if (/[\r\n]/.test(value)) {
    report("error", "single-line-required", path, "必须是单行文本");
  }
  if (PIPE_SAFE_FIELDS.has(path.split(".").pop() ?? "") && value.includes("|")) {
    report("error", "reserved-character", path, "不允许出现竖线，会破坏下游表格渲染");
  }
  return value;
}

/** 单行可选文本；换行一律拒绝（下游会把它拼进表格与提示）。 */
function optionalSingleLine(raw, path, maxChars, report) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    report("error", "invalid-type", path, "必须是单行字符串");
    return undefined;
  }
  const value = raw.trim();
  if (value === "") {
    report("error", "invalid-value", path, "不允许空字符串（不需要这个字段就整个省略）");
    return undefined;
  }
  if (value.length > maxChars) {
    report("error", "string-too-long", path, `${value.length} 字符，超过上限 ${maxChars}`);
    return undefined;
  }
  const leaf = path.split(".").pop() ?? "";
  if (SINGLE_LINE_FIELDS.has(leaf) && /[\r\n]/.test(value)) {
    report("error", "single-line-required", path, "必须是单行文本");
  }
  if (PIPE_SAFE_FIELDS.has(leaf) && value.includes("|")) {
    report("error", "reserved-character", path, "不允许出现竖线，会破坏下游表格渲染");
  }
  return value;
}

function rejectUnknownKeys(raw, allowed, path, label, report) {
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    report(
      "error",
      "unknown-key",
      path === "" ? key : `${path}.${key}`,
      `${label}不接受字段 "${key}"（允许：${allowed.join(", ")}）`,
    );
  }
}

/** 内容级护栏：NUL 字节、以及超出 UTF-8 基本面的控制字符。 */
function guardContent(value, path, report) {
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      report("error", "forbidden-content", path, "文本不允许包含 NUL 字符");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => guardContent(item, path === "" ? `[${index}]` : `${path}[${index}]`, report));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      guardContent(item, path === "" ? key : `${path}.${key}`, report);
    }
  }
}

function at(index) {
  return `members[${index}]`;
}

/** 把任意值折成一句可读描述，用于错误消息。 */
function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(${value.length})`;
  if (typeof value === "object") return "对象";
  return String(value);
}
