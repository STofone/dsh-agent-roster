/**
 * @stofone/dsh-agent-roster —— 多 Agent 团队的静态成员档案层。
 *
 * 定位：**定义与校验 + 桥接参数生成**。本插件不运行团队、不调度任务、不替代任何团队运行时，
 * 也不写别人的状态。它做的事只有三件：
 *
 * 1. 把成员档案（谁、能做什么、用什么模型、受什么工具约束）固化成可校验、可版本化的静态文件；
 * 2. 校验失败时 fail-loud：带文件路径与字段路径报错，不静默降级；
 * 3. 在 dsh-agent-teams 创建成员时，把档案翻译成建员参数，并如实标注每个字段的归宿
 *    （运行时接收 / 仅声明 / 需落部署配置），事后再拿 team.json 的实际值核对。
 *
 * @module dsh-agent-roster
 */
import { readFileSync } from "node:fs";

import z from "@deepseek-ai/schemastery";

import { configView } from "./lib/config-view.js";
import { collectLibrary } from "./lib/library.js";
import { registerRosterTools } from "./lib/tools.js";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Cordis 插件名（出现在宿主日志与设置页）。 */
export const name = "agent-roster";

/** 只依赖工具注册表；档案库与团队状态都是普通文件，不依赖别的插件。 */
export const inject = ["tools"];

/**
 * 插件配置。
 *
 * 三项都是 plain value 且声明为 volatile：在设置页改完立即生效，不需要重启宿主——
 * 这几个值只是"去哪读文件"，没有需要重建的生命周期资源。
 */
export const Config = z.object({
  rosterDirs: z
    .array(z.string())
    .default(["rosters"])
    .description("档案库目录；相对路径以当前会话工作区为基准。第一项是工具默认读取的档案库。")
    .volatile(),
  knownToolPolicies: z
    .array(z.string())
    .default([])
    .description("部署已声明的 toolPolicy id 列表：填了就能在校验期发现档案里写错的策略 id。留空表示不做交叉校验。")
    .volatile(),
  agentTeamsStateDir: z
    .string()
    .default(".agent-teams")
    .description("dsh-agent-teams 的状态目录（只读，用于核对成员实际字段）。相对路径以工作区为基准。")
    .volatile(),
});

/**
 * 挂载插件。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config
 * @returns {void}
 */
export function apply(ctx, config) {
  // volatile 字段在运行时是引用对象，必须走视图按当前值读，见 lib/config-view.js。
  const settings = configView(config);

  registerRosterTools(ctx, settings, { version: pkg.version });
  ctx.logger?.info?.(`dsh-agent-roster ${pkg.version}: registered 4 tools`);

  // 只读查询路由：给客户端插件面板用。没有 webServer 也不影响工具可用性。
  ctx.inject(["webServer"], (webCtx) =>
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: "/plugins/dsh-agent-roster/library",
          handler: async (req, res) => {
            const payload = collectLibrary(ctx, settings, { name: pkg.name, version: pkg.version });
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
            });
            res.end(JSON.stringify(payload));
          },
        }),
      "dsh-agent-roster: library route",
    ),
  );
}

// 面板快照逻辑在 lib/library.js：纯数据投影，可脱离宿主单测。
export { collectLibrary, markDuplicateIds, serializeRoster } from "./lib/library.js";
