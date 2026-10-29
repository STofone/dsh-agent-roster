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

/**
 * 公共档案库目录（registry）的格式标识。
 *
 * 与 {@link INDEX_KIND} 的区别：index 是“一个档案库扫描后的清单”（roster 指针），
 * registry 是“许多档案库的登记簿”（collection 指针）——后者才是订阅/共享的入口。
 */
export const REGISTRY_KIND = "dsh-agent-roster-registry/v1";

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
  aliasesPerMember: 8,
  skillsPerMember: 16,
  examplesPerMember: 5,
  exampleChars: 200,
  captainChars: 4000,
  collections: 500,
  rostersPerCollection: 200,
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
  /** 技能名：与 DSH 技能目录同名，允许点与下划线（如 `frontend-skill`、`eastmoney-quant`）。 */
  skill: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  /** 仓库坐标：`github:owner/repo` 或 `owner/repo`（只允许 GitHub 与普通字符）。 */
  repo: /^(?:github:)?[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/,
  /** git ref：分支、标签或 40 位 commit（不接受 `..` 之类会让 URL 跑出仓库的写法）。 */
  ref: /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|[0-9a-f]{40})$/,
  /** 仓库内相对目录：不允许绝对路径、`..` 与反斜杠。 */
  relPath: /^(?:\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*$/,
  /** npm 包名（含 scoped）。 */
  npmName: /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,99}$/,
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
  description: "declaration",
  aliases: "declaration",
  skills: "declaration",
  examples: "declaration",
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
  "captain",
];

/**
 * 队长段允许的字段。
 *
 * 队长就是创建团队的那个会话本身，agent-teams 没有 `captain` 成员行，
 * 也没有任何工具参数能改写它的路由，所以这里全是「声明 + 落地提示」：
 * 真正生效要改 profile 的 `agent-default-model` 与 agent preset 的 persona。
 */
export const CAPTAIN_FIELDS = [
  "name",
  "description",
  "systemPrompt",
  "personaPrefix",
  "provider",
  "model",
  "reasoningEffort",
];

/** 队长字段 → 生效方式（与 FIELD_BINDING 同语义）。 */
export const CAPTAIN_BINDING = {
  name: "declaration",
  description: "declaration",
  systemPrompt: "declaration",
  personaPrefix: "config",
  provider: "config",
  model: "config",
  reasoningEffort: "config",
};

/** 索引文档允许的顶层字段。 */
export const INDEX_FIELDS = [
  "$schema",
  "format",
  "generatedAt",
  "generator",
  "source",
  "rosters",
];

/** registry 文档允许的顶层字段。 */
export const REGISTRY_FIELDS = [
  "$schema",
  "kind",
  "version",
  "generatedAt",
  "generator",
  "source",
  "collections",
];

/**
 * registry 里一条 collection 允许的字段。
 *
 * `repo` + `ref` + `path` 决定去哪个仓库的哪个目录取档案；
 * `rosters` 是目录里真的有哪几份（索引不撒谎，客户端据此逐份拉取并自行校验）。
 */
export const COLLECTION_FIELDS = [
  "id",
  "title",
  "description",
  "repo",
  "ref",
  "path",
  "rosters",
  "tags",
  "license",
  "maintainers",
  "homepage",
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
