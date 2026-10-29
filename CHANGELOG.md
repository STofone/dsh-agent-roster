# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 档案格式 `dsh-agent-roster/v1`：`<root>/<roster-id>/roster.{yaml,yml,json}`，一份档案一个目录。
- 校验器：结构、取值、上限、安全（保留字符 / 提示注入特征）四类检查；未知键直接报错。
- 档案库扫描：按目录探测档案文件，重复文件、散落文件、不可读目录都出诊断，不静默跳过。
- 桥接层：把成员翻译成 `agent_teams_add_member` 参数与 `agent_teams_create` 的 `plan.members`，
  每个字段标注 `direct` / `config` / `declaration` 归宿。
- 核对层：只读 `dsh-agent-teams` 的 `team.json`，逐字段比对并判为 `applied` / `overridden` /
  `omitted` / `unconfirmed`；状态缺失时降级而不是假装通过。
- 四个工具：`roster_list`、`roster_show`、`roster_create`、`roster_verify`。
- 设置页面板：工作区 × 档案库快照（只读路由 `/plugins/dsh-agent-roster/library`），
  档案卡片与成员表；取不到工作区注册表时标注回退到进程工作目录。
- CLI `dsh-agent-roster`：`validate` / `list` / `version`，`--dir`、`--known-policy`、`--json`；
  退出码 0 = 通过，1 = 至少一个 error，2 = 用法错误。
- 两座示例档案库（`examples/core-review`、`examples/research`）。
- 单测 86 个用例，覆盖格式、解析、校验、扫描、路径解析、桥接、核对、无损 JSON、工具契约（状态行/无损输出）、客户端加载器契约、面板快照与包清单自洽。
- 宿主半边冒烟脚本 `scripts/host-smoke.mjs`：用真实 `defineTool` 注册并调用四个工具，断言输出可无损往返。

### Changed

- 「没配 `knownToolPolicies`」改为档案库级只发一条 `tool-policy-cross-check-skipped`（info），
  不再每份档案重复一条 `tool-policy-unverified` 警告——一个库级事实不该放大成 n 行噪音。
- 四个工具的渲染文本首行改为 `k=v` 状态行（如 `[roster_list] rootDir=… total=2 ok=2`）：
  模型读到的是渲染文本，结构化字段不会自动出现，状态行让"成功没有/命中没有"不必靠中文措辞去猜。

### Fixed

- `volatile` 配置字段在 `apply()` 里是 `{ get, write }` 引用对象，原来被当成普通值读，导致面板与工具
  永远读默认值。改为经 `lib/config-view.js` 每次访问取当前值。
- `roster_list` / `roster_show` / `roster_create` 忽略 `path` 参数、只扫配置目录；现在显式 `path` 即覆盖。
- 工具返回值含 `undefined` 键，运行时按 `value is not lossless JSON` 整次拒绝；缺失值统一写 `null`，
  且所有返回值先过 `lib/json.js#lossless`。

[Unreleased]: https://github.com/STofone/dsh-agent-roster/commits/main
