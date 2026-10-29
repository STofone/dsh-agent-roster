/**
 * 档案与索引的格式常量：标识、上限、模式、字段白名单与绑定类别。
 *
 * 这个模块只有数据、没有逻辑，被校验器、桥接层、UI 共同引用；
 * 改这里等于改格式，必须同步 bump {@link ROSTER_KIND} 或索引格式。
 *
 * @module dsh-agent-roster/format
 */

/** 档案文档格式标识（出现在每份 roster.yaml 的 kind 字段）。 */
export const ROSTER_KIND = "dsh-agent-roster/v1";

/** 索引文档格式标识（由 scan CLI / GitHub Action 产出）。 */
export const INDEX_KIND = "dsh-agent-roster-index/v1";

/** 单份档案文档的字节上限，超过直接拒绝，避免把仓库当数据库用。 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/** 结构与长度上限。 */
export const LIMITS = {
  members: 32,
  systemPromptChars: 8000,
  titleChars: 120,
  descriptionChars: 500,
  roleChars: 120,
  idChars: 64,
  tagChars: 32,
  tagsPerEntry: 16,
  notesChars: 500,
  reasonChars: 400,
};

/** 形态模式。 */
export const PATTERNS = {
  /** roster id 与成员 name 共用：kebab-case，2~64 字符。 */
  id: /^[a-z0-9][a-z0-9-]{1,63}$/,
  /** LLM provider 路由名。 */
  provider: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  /** 模型 id：允许厂商前缀与版本号里的点、斜杠、冒号。 */
  model: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/,
  /** 工具名（命名空间分隔符，精确匹配）。 */
  toolName: /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/,
  /** 工具匹配模式：精确名，或末尾带一个 `*` 的前缀通配（如 `git:*`、`files*`）。 */
  toolPattern: /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,126}\*?$/,
  /** 精确 SemVer。 */
  semver: /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  /** 40 位小写 commit SHA（索引指针只接受这种精确形态）。 */
  commit: /^[0-9a-f]{40}$/,
  /** 标签令牌。 */
  tag: /^[a-z0-9][a-z0-9-]{0,31}$/,
};

/** reasoningEffort 的封闭枚举；未知值一律拒绝，不做静默降级。 */
export const REASONING_EFFORTS = ["low", "medium", "high", "default"];

/**
 * 成员字段 → 桥接生效方式。
 *
 * - `direct`：原样进入 agent-teams 的工具参数；
 * - `config`：运行时没有对应工具参数，只能生成配置片段，属「待 owner 落配置」；
 * - `declaration`：运行时无承载，仅作文档与校验依据，必须标注未生效。
 */
export const FIELD_BINDING = {
  name: "direct",
  role: "direct",
  systemPrompt: "direct",
  provider: "direct",
  model: "direct",
  reasoningEffort: "direct",
  toolPolicy: "direct",
  fallback: "config",
  toolScope: "declaration",
  maxTokens: "declaration",
  title: "declaration",
  tags: "declaration",
  notes: "declaration",
};

/** 成员允许的字段（未知键一律拒绝，防止拼写错误静默失效）。 */
export const MEMBER_FIELDS = Object.keys(FIELD_BINDING);

/** 一个档案目录里按顺序探测的档案文件名：<root>/<roster-id>/roster.{yaml,yml,json}。 */
export const MEMBER_FILE_NAMES = ["roster.yaml", "roster.yml", "roster.json"];

/** 团队级默认值允许的字段：只放真正参与桥接的成员字段。 */
export const DEFAULTS_FIELDS = [
  "provider",
  "model",
  "reasoningEffort",
  "toolPolicy",
  "toolScope",
  "fallback",
];

/** 档案文档允许的顶层字段。 */
export const ROSTER_FIELDS = [
  "$schema",
  "kind",
  "roster",
  "version",
  "title",
  "description",
  "license",
  "maintainers",
  "tags",
  "defaults",
  "members",
];

/** 索引文档允许的顶层字段。 */
export const INDEX_FIELDS = [
  "$schema",
  "format",
  "generatedAt",
  "generator",
  "source",
  "rosters",
];

/**
 * 档案字段 → dsh-agent-teams 成员参数名。
 *
 * 只有 direct 字段出现在这里；config/declaration 字段没有运行时参数，
 * 由 `bridge.js` 的 binding 报告如实标注。
 */
export const AGENT_TEAMS_FIELD = {
  name: "name",
  role: "role",
  systemPrompt: "executionPrompt",
  provider: "provider",
  model: "model",
  reasoningEffort: "reasoning_effort",
  toolPolicy: "tool_policy",
};
