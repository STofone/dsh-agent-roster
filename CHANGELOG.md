# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-10-30

### Captain verification and applying a roster

- The panel now compares an archive's `captain` block with what the deployment actually says:
  provider / model / reasoning-effort / persona prefix are read from every profile's
  `cordis.patch.yml` and reported as `match`, `differ`, `undeclared` or `unknown`.
  Unreadable deployment config is never reported as a pass.
- New `POST /plugins/dsh-agent-roster/apply`: picks an existing session or creates a new one,
  applies the declared model to that session, and queues a prompt that builds the team with
  `agent_teams_create` + `agent_teams_add_member` + `roster_verify`. The plugin still never
  creates teams itself.
- `/library` now also returns the session list (read-only) and the captain section.
- `roster_verify` reports the captain checks next to the member checks.
- Panel: captain card inside each archive with the declared routing, the four-state checks and an
  "apply" row (existing session / new session + optional working directory).
- Locale dictionary gained the `captain` section in both languages.
- Header actions moved to where they act: import/new archive on the archive tab, "refresh sources"
  on the sources tab (bypasses the TTL and re-reads the index), and a gear button that opens a
  settings dialog (language, download region, roster directories, resolved paths).
- The panel fills the whole page (no `max-width` on the outer container) and the archive
  list gains a tag pool on the left: every tag in the library with its count, multi-select
  narrows with AND semantics, one click clears.

## [0.5.1] - 2026-10-29

### Fixed

- **配置视图漏了两个字段**：`configView` 只转发了 `rosterDirs`/`knownToolPolicies`/`agentTeamsStateDir`，
  面板与路由读不到 `indexes` 与 `region`——于是设置里关掉远端（`indexes: false`）不生效、
  `region: china` 也不生效。现在四个字段都转发，`indexes` 的三种取值（`undefined`/空数组 = 官方源、
  `false` = 关掉远端、数组 = 自定义源）原样保留。
- **缺省档案库目录退回旧的相对路径**：`rosterDirs` 未配置时曾退回 `["rosters"]`（相对当前工作区），
  与 0.3.0 起的“留空 = 全局库 `$DSH_HOME/agent-roster`”不一致；一键拉取会把档案写进工作区而不是全局库。
  现在缺省统一为空串（全局库）。测试 162 → 163。

### Added

- 官方索引 `index/registry.json` 新增三个迁移自上游的 collection：
  `agent-teams`（wshobson/agents，MIT，4.2 万星）、`metagpt-company`（MetaGPT，MIT）、
  `openmanus`（OpenManus，MIT）。三份档案在各自仓库的 `rosters/<id>/roster.yaml`，可在面板“档案源”页一键拉取。

## [0.5.0] - 2026-10-29

### Added

- **公共档案源（registry）**：`indexes` 配置订阅 `https` 的 `registry.json` 或 `npm:pkg`；默认只有官方源
  `STofone/dsh-agent-roster` 的 `index/registry.json`。索引按 **TTL 一小时** 缓存（等于未认证 GitHub 的
  60 次/小时配额），`refresh=1` 才绕过缓存且有 60 秒最短间隔；网络失败沿用上次缓存并说明原因，
  不会把「没拉到」显示成「没有档案」。
- **一键拉取到本机**：面板新增「档案源」页签，列出每个 collection 的标题、仓库、登记份数与上次拉取时间，
  点「拉取到本机」把整目录写进全局档案库。写入是幂等的：内容相同跳过、本地改过默认**不覆盖**并报冲突数，
  只有显式 `overwrite` 才替换。对应 `POST /plugins/dsh-agent-roster/install`。
- 第 5 个工具 `roster_index`：列出索引源状态与 collection；给定 `collection` 时只读地把那套档案拉下来看。
- `lib/serialize.js`：把已校验档案还原成落盘 JSON（只写语义字段，不带 `inherited`/`origin`/`file` 之类副产物）。
- `.github/workflows/registry.yml`：校验 `index/registry.json`、比对仓库真实文件、跑测试。

### Fixed

- `indexes: []` 现在明确表示「用官方源」——此前空数组会被当成「没有源」，装上插件后档案源页签就是空的。

## [0.4.0] - 2026-10-29

### Added

- 成员声明字段 `description`、`aliases`、`skills`、`examples`：文档与派活用的信息，明确标注为声明层。
  `aliases` 参与核对匹配，改名后不再出现「未部署 + 无档案」的假报警；`skills` 与宿主技能目录交叉核对。
- 档案级 `captain` 段：记录队长（＝创建团队的那个会话）应该是什么样，给出可复制的 profile 片段。
  agent-teams 没有 captain 成员行，档案只声明、不改写会话。
- `schema/roster.v1.schema.json`：编辑器与外部工具用的 JSON Schema，由 `test/schema.test.js` 与运行时常量对齐。
- 测试：声明字段校验、别名冲突、队长段、别名核对、技能核对、schema 对齐（共 153 例）。

## [0.3.0] - 2026-10-29

### Changed

- **档案库默认全局**：`rosterDirs` 留空时使用 `<DSH_HOME>/agent-roster`（默认 `~/.dsh/agent-roster`），
  不再按工作区展开。docker 部署下 `$DSH_HOME` 就是被挂载的数据卷，档案天然落在持久化位置。
  只有显式写相对路径（如 `examples`）才按工作区解析——那是显式例外。
- 四个模型可见工具的默认档案库、面板快照、写路由白名单统一走同一套解析（`lib/home.js`），
  「工具读的库」和「面板写的库」不再可能指向不同目录。
- 面板配置区新增「数据目录」一行；档案库目录留空时显示全局默认路径，而不是空白。

### Added

- `lib/home.js`：`$DSH_HOME` > `~/.dsh` 的解析、`~` 展开、全局/工作区目录判定。
- 首次向不存在的全局目录写入时自动创建目录树（面板新建/导入即可用，无需先手动建目录）。
- 测试：全局库解析、空配置只有一个全局根目录、首次写入自动建目录（共 135 例）。

### Fixed

- 空档案库不再产出任何诊断或体检提示：目录还没建（首次保存会自动建）、目录里还没有档案、
  以及「没配 knownToolPolicies」都不再各发一条 info/warn。面板「体检」页签的角标只统计
  真正需要处理的问题（warn/error），info 不再挂数字。

## [0.2.1] - 2026-10-29

### Fixed

- 面板样式只用宿主语义 token（`--dsw-alias-*`），删掉全部硬编码颜色和浅色兜底——暗色主题下不再
  「白底白字」。正文、徽标、按钮、提示条、模态框在两个主题下都按 WCAG AA 复核过（脚本对真实
  token 求对比度，两主题 0 违规）。
- 徽标不再用「深色文字压浅色底」的语义色当正文色（宿主语义色本身是给图标用的，小字压不住），
  改为语义色描边 + 正文色文字；分段控件的选中态同理。
- 模态框改用 `bg-layer-1`，`bg-overlay` 在暗色下是中间灰，压不住次级文字。
- `README.zh.md` 的用例数从 122 更新为 123。

### Added

- 回归测试：`client.js` 的 CSS 不允许出现硬编码颜色，且只能引用 `--dsw-alias-*`。

## [0.2.0] - 2026-10-29

### Added

- 面板从「只看」变成「能管」：三个页签（档案 / 团队 / 体检）。档案页支持新建、编辑、复制、
  删除、导入、导出，编辑器有表单与源码两种模式，覆盖前留 `.bak`；团队页只读状态目录，列出每个
  团队的成员、模型路由、是否与档案一致，以及团队任务；体检页集中回答「配置有没有指错」。
- 写路由 `POST /plugins/dsh-agent-roster/rosters`：同源（`connection` 围栏）、`application/json`
  校验、请求体上限、档案库根目录白名单；`create` / `update` / `delete` / `import` / `export`
  五个动作，宿主侧校验失败原样返回诊断，客户端不直接写文件。
- 只读路由 `GET /plugins/dsh-agent-roster/document`：单份档案原文 + 解析结果，供编辑器源码模式。
- 只读路由 `GET /plugins/dsh-agent-roster/locale`：面板词典（`en` / `zh`）。
- 中英双语：面板与宿主文本都走词典（`locale/*.json`），设置页新增「语言」小节
  （`auto` / `zh` / `en`），默认跟随 DSH；语言变化时面板实时重渲染。
- 设置页 `settings.section` 小节：语言选择 + 只读配置摘要（目录、状态目录、已声明策略数）。
- 面板顶部一条「需要处理的事」徽标，配置类提示集中在体检页，不再把噪声堆到首屏。
- `scripts/check-locale.mjs`：静态 `t()` 键必须两本词典都存在，避免界面漏词。
- 面板快照扩展：`teams`（团队与成员核对）、`hints`（配置体检）、`counts`、`deployments`。
- `lib/http.js`、`lib/write.js`、`lib/service.js`、`lib/teams-state.js`：路由工具、写入计划与
  执行、面板快照投影、状态目录只读解析。
- 单测 111 个用例（新增写入计划/执行、快照与提示、路由契约）。

### Changed

- 面板改为整页布局（`main` 键控槽 + `sidebar.panellist`），设置页只保留语言与配置摘要。
- `package.json` `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-settings`。
- 版本 0.1.0 → 0.2.0。

## [0.1.0]

### Added

- 档案格式 `dsh-agent-roster/v1`：`<root>/<roster-id>/roster.{yaml,yml,json}`，一份档案一个目录。
- 校验器：结构、取值、上限、安全（保留字符 / 提示注入特征）四类检查；未知键直接报错。
- 档案库扫描：按目录探测档案文件，重复文件、散落文件、不可读目录都出诊断，不静默跳过。
- 桥接层：把成员翻译成 `agent_teams_add_member` 参数与 `agent_teams_create` 的 `plan.members`，
  每个字段标注 `direct` / `config` / `declaration` 归宿。
- 核对层：只读 `dsh-agent-teams` 的 `team.json`，逐字段比对并判为 `applied` / `overridden` /
  `omitted` / `unconfirmed`；状态缺失时降级而不是假装通过。
- 四个工具：`roster_list`、`roster_show`、`roster_create`、`roster_verify`。
- 左侧栏面板：`sidebar.panellist` 一行图标 + 同 id 的 `main` 键控槽整页内容；点击后在主区域
  打开工作区 × 档案库快照（只读路由 `/plugins/dsh-agent-roster/library`），档案卡片与成员表；
  取不到工作区注册表时标注回退到进程工作目录。
- CLI `dsh-agent-roster`：`validate` / `list` / `version`，`--dir`、`--known-policy`、`--json`；
  退出码 0 = 通过，1 = 至少一个 error，2 = 用法错误。
- 两座示例档案库（`examples/core-review`、`examples/research`）。
- 单测 88 个用例，覆盖格式、解析、校验、扫描、路径解析、桥接、核对、无损 JSON、工具契约（状态行/无损输出）、客户端加载器契约（两个槽位 + 身份一致）、面板快照与包清单自洽。
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

[Unreleased]: https://github.com/STofone/dsh-agent-roster/compare/v0.2.0...main
[0.2.0]: https://github.com/STofone/dsh-agent-roster/releases/tag/v0.2.0
