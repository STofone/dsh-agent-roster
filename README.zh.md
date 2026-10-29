# @stofone/dsh-agent-roster

面向多 Agent 团队的**静态成员档案**插件（DeepSeek Harness）。

一份档案就是磁盘上的一个文件：团队里有谁、各自负责什么、走哪个模型路由、被允许碰哪些工具。本插件定义这套格式、校验它，并把它翻译成 `agent_teams_*` 的调用参数——仅此而已。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 定义与校验层：档案可版本化、可评审，写错时带文件路径与字段路径**直接报错**，不静默降级 | 团队运行时：从不建成员、不调度任务、不替代任何调度器 |
| 对 `dsh-agent-teams` 的桥接：`roster_create` 产出可直接使用的 `agent_teams_add_member` 参数，并逐字段标注运行时是否真的接收 | 不写 `.agent-teams/` 状态：只读，核对用 |
| 核对手段：`roster_verify` 读 `team.json`，比对运行时**实际存下的值** | 不假装通过：读不到运行时状态时如实降级为「无法核对」 |

## 安装

前置：DSH 提供 `tools` 服务；依赖已在 `package.json` 里声明（`yaml`、`@deepseek-ai/schemastery`）。

用插件管理器指向本仓库（绝对路径），或发布后按包名安装：

```
@stofone/dsh-agent-roster
```

包内带 `cordis.patch.yml`，安装即把插件插进 profile。装好后应看到四个工具（`roster_list`、`roster_show`、`roster_create`、`roster_verify`）以及左侧栏里的 **Agent Roster** 面板（独立主面板，不再放设置页）。

## 快速开始

```
your-workspace/
└── rosters/
    └── core-review/
        └── roster.yaml
```

```yaml
kind: dsh-agent-roster/v1
roster: core-review          # 必须与所在目录名一致
version: 1.0.0               # 精确 SemVer
title: 核心评审组
description: 负责代码评审与发布把关的固定成员。
license: MIT
maintainers: [STofone]
tags: [review, release]

defaults:                    # 团队成员共享的路由默认值
  provider: deepseek
  model: deepseek-v4.1-flash
  reasoningEffort: high

members:
  - name: reviewer          # kebab-case，团队内唯一
    role: 代码评审
    systemPrompt: |
      你先找语义错误，再看风格。
    toolPolicy: readonly
  - name: release-manager
    role: 发布把关
    systemPrompt: |
      你核对变更、版本号与回滚方案。
    model: deepseek-v4.1-pro
    reasoningEffort: low
```

JSON 也可以（`roster.json`）。同一目录下按 `roster.yaml` → `roster.yml` → `roster.json` 顺序探测，**只认一份**；出现第二份会报诊断，绝不静默挑一份。

本包自带两份示例档案库（[`examples/`](./examples)）。默认 `rosterDirs` 是 `["rosters"]`，新装的目录里是空的，所以面板一开始显示「0 份档案」——要么自己建一份，要么把设置里的 `rosterDirs` 指到 `examples`：

```bash
# 先看看示例库长什么样
npx dsh-agent-roster list --dir examples
```

之后让模型调用 `roster_list`，或用 CLI：

```bash
npx dsh-agent-roster validate --dir rosters
npx dsh-agent-roster list --dir rosters
```

## 格式说明

顶层只允许这些键，未知键是 **error** 而不是警告：

| 键 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | 必须是 `dsh-agent-roster/v1` |
| `roster` | 是 | kebab-case id，必须等于所在目录名 |
| `version` | 是 | 精确 SemVer（`1.2.0`，不接受 `^1.2.0`） |
| `title` | 否 | 单行，≤120 字符（省略时用 id） |
| `description` | 否 | ≤500 字符 |
| `license` | 否 | 单行 |
| `maintainers` | 否 | 非空字符串列表 |
| `tags` | 否 | ≤16 个，小写 kebab-case |
| `defaults` | 否 | 成员继承的路由字段 |
| `members` | 是 | 1 到 32 个 |

成员键：`name`、`role`、`systemPrompt`（必填），以及 `provider`、`model`、`reasoningEffort`、`toolPolicy`、`fallback`、`toolScope`、`maxTokens`、`title`、`tags`、`notes`。

`systemPrompt` 上限 8000 字符。成员省略路由字段时从 `defaults` 继承，继承结果记入 `inherited` 列表，能看清"这个值哪来的"。

### 每个字段到底落在哪

桥接绝不假装字段生效。每个成员字段都归类：

| 类别 | 字段 | 含义 |
|---|---|---|
| `direct` | `name`、`role`、`systemPrompt`、`provider`、`model`、`reasoningEffort`、`toolPolicy` | 进入 `agent_teams_add_member` 参数并被运行时持久化 |
| `config` | `fallback` | 运行时无对应参数，需落部署配置 |
| `declaration` | `toolScope`、`maxTokens`、`title`、`tags`、`notes` | 仅作文档与校验依据，明确标注未生效 |

`roster_create` 输出 `agent_teams_add_member` 参数（`systemPrompt` → `executionPrompt`、`reasoningEffort` → `reasoning_effort`、`toolPolicy` → `tool_policy`）与逐字段归宿；`roster_verify` 随后把每个字段判为 `applied`、`overridden`、`omitted` 或 `unconfirmed`。

## 工具

| 工具 | 作用 |
|---|---|
| `roster_list` | 列出档案库里的档案与每份的校验结果 |
| `roster_show` | 完整查看一份档案（或其中一名成员），含字段归宿 |
| `roster_create` | 把成员翻译成 `agent_teams_add_member` 参数 / `plan.members` |
| `roster_verify` | 与 `dsh-agent-teams` 的 `team.json` 比对；状态缺失时降级为「无法核对」 |

四个工具都不写团队状态。`roster_create` 只产出参数，真正的建员仍由模型调用 `agent_teams_add_member`。

三个带路径的工具（`roster_list` / `roster_show` / `roster_create`）都接受 `path` 参数：给了就只看那个目录，不会悄悄回落到配置目录。

## 左侧栏面板

客户端插件在左侧全局栏新增一行 **Agent Roster** 图标（`sidebar.panellist` 列表槽），并在 `main` 槽用同一个面板 id 注册整页内容；点图标即在主区域打开，宽度与对话页一致。面板分三个页签，不只是看：

| 页签 | 能做什么 |
|---|---|
| 档案 | 浏览每个工作区 × 每座档案库，展开成员；**新建 / 编辑 / 复制 / 删除 / 导入 / 导出**档案。编辑器有表单与源码两种模式（源码就是文件原文）；写之前由宿主校验，覆盖已有文件会留一份 `.bak` |
| 团队 | 读一个配置好的状态目录（默认 `.agent-teams`），列出运行时真正建出来的每个团队：档案、成员档案与模型路由、每个持久化成员是否真的与其档案一致，以及该团队的任务 |
| 体检 | 把「配置有没有指错」集中一处：目录解析到了哪、状态目录在不在、有多少声明未被确认，以及该改哪个设置 |

顶部一条徽标汇总「有几件事需要处理」，体检页逐条说明。所有写操作都走 `POST /plugins/dsh-agent-roster/rosters`：宿主侧校验同源（`connection`）、JSON content-type、请求体大小上限与档案库根目录白名单，客户端不直接写文件。

面板是中英双语，语言默认跟随 DSH，可在 **设置 → 插件 → Agent Roster** 里固定（同一节还有只读的配置摘要）。词典放在 `locale/` 由宿主提供，所以切 DSH 语言时面板无需刷新就会跟着变。

## 路由

| 路由 | 方法 | 用途 |
|---|---|---|
| `/plugins/dsh-agent-roster/library` | GET | 面板快照：工作区、档案库、档案、团队、提示、计数 |
| `/plugins/dsh-agent-roster/document` | GET | 单份档案的原文与解析结果（编辑器用） |
| `/plugins/dsh-agent-roster/rosters` | POST | 新建 / 更新 / 删除 / 导入 / 导出单份档案 |
| `/plugins/dsh-agent-roster/locale` | GET | 面板词典（`en` / `zh`） |

四条都是 `exact` 路由，走宿主的 `connection` 围栏，方法不符返回 `405`。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `rosterDirs` | `["rosters"]` | 档案库目录（相对工作区）；第一项是工具的默认目录 |
| `knownToolPolicies` | `[]` | 部署已声明的 toolPolicy id；填了才做交叉校验 |
| `agentTeamsStateDir` | `.agent-teams` | 只读：`roster_verify` 与「团队」页签在这里找团队状态 |
| `language` | `"auto"` | 面板语言：`auto` 跟随 DSH，或固定 `zh` / `en` |

四项都是 `volatile`：改完立即生效，无需重启。

## 诊断

校验输出 error / warn / info 三档，每条带 `file`、`path`、`reason`。主要代码族：

- 结构：`missing-field`、`unknown-key`、`invalid-type`、`invalid-kind`、`pair-required`、`invalid-value`
- 取值：`invalid-id`、`invalid-provider`、`invalid-model`、`invalid-semver`、`invalid-tag`、`invalid-tool-name`、`invalid-tool-policy-id`、`invalid-number`、`empty-tool-scope`
- 安全：`reserved-character`（`^`、`$`、`|`、花括号）、`forbidden-content`（提示注入特征）、`single-line-required`
- 上限：`string-too-long`、`too-many-members`、`too-many-values`
- 档案库级：`library-missing`、`library-unusable`、`missing-roster-file`、`multiple-roster-files`、`unexpected-file`、`unreadable-file`、`unreadable-dir`、`duplicate-roster-id`、`tool-policy-cross-check-skipped`

空档案库不是错误；目录不存在只算 info。`tool-policy-cross-check-skipped` **每座档案库只发一条**（不是每份档案一条）——没配 `knownToolPolicies` 是一件库级的事，按档案重复只会把一个事实放大成 n 行噪音。

## 与 dsh-agent-teams 的关系

团队生命周期、任务派发、成员持久化归 `dsh-agent-teams`；本插件只管成员**定义**与交接的诚实性：只读 `.agent-teams/<team>/team.json` 核对运行时真正存了什么，读不到就说「无法核对」。从不写状态。

## 开发

```bash
npm install
npm test          # node --test，123 个用例
npm run smoke     # 用真实 DSH bundle 注册工具，断言输出可无损往返
node scripts/check-locale.mjs   # client.js 里的静态 t() 键必须两本词典都有
```

```
index.js          宿主半边：Config、apply、四条路由
lib/              format / parse / validate / registry / bridge / verify / render / library /
                  config-view / json / http / write / service / teams-state / tools
client.js         客户端半边：左侧栏图标 + 主面板（档案/团队/体检）+ 设置页小节
locale/           面板与列表词典（en/zh）
bin/cli.mjs       validate / list / version，给 CI 用
scripts/          host-smoke.mjs、client-smoke.mjs、check-locale.mjs（开发用，不随包发布）
examples/         两座示例档案库
test/             单测
```

## 验证进度

本机已验证：

- `npm test` —— 123/123 通过（格式、解析、校验、扫描、路径、桥接、核对、无损 JSON、写入计划与执行、四条路由、快照与提示、两本词典一致、工具契约、客户端加载器契约、包清单、配置视图、样式 token 约束）。
- `npm run smoke` —— 用真实 DSH bundle 的 `defineTool` 注册四个工具，逐个调用：输出全部通过无损校验、`path` 覆盖生效、释放干净；同一条命令随后用桩模块表加载 `client.js`，断言三处槽位注册、样式只注入一次、effect 可回收。
- CLI：`validate --dir examples` 对两座示例库退出码 0。
- 用插件管理器真的装进了本机 profile（`plugin_manager install_bundle` 指向本仓库 → `link:` 依赖 + bundle 条目），重启后按链接读取本仓库文件。
- 运行中的宿主已能应答只读路由：`GET /plugins/dsh-agent-roster/library` 返回 200，带插件版本与解析出的档案目录。
- 另一个 agent 会话在工具清单里看到了四个工具，并实际调用了它们。
- 左侧栏面板已在活页面里确认可见，并展示了真实档案。

这一轮没验证到的：0.2.0 的管理界面（页签、编辑器、团队页、语言切换、`document` / `rosters` 路由）在活页面里的表现——这些改动要重启宿主才会被加载，重启后再验。

验证过程抓到三个真缺陷并已修：

1. `volatile()` 配置字段进 `apply()` 时是 `{ get, write }` 引用对象，导致面板和所有工具一直读默认值、设置表单形同虚设。现在读取统一走 `lib/config-view.js`，每次访问都取当前值，类型不对则退回默认值。
2. `roster_list` 忽略 `path` 参数，永远扫配置目录。`resolvePaths` 现在把显式 `path` 当作覆盖。
3. 工具返回值里带 `undefined` 键，运行时判 `value is not lossless JSON` 而整次失败。缺失值现在写 `null`（或直接省略），且所有返回值先过 `lib/json.js#lossless`。

## 许可

MIT，见 [LICENSE](./LICENSE)。
