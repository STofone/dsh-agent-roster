/**
 * @stofone/dsh-agent-roster —— 多 Agent 团队的静态成员档案层。
 *
 * 定位：**定义与校验 + 桥接参数生成 + 可管理它的面板**。本插件不运行团队、不调度任务、
 * 不替代任何团队运行时，也不写别人的状态。它做的事是：
 *
 * 1. 把成员档案（谁、能做什么、用什么模型、受什么工具约束）固化成可校验、可版本化的静态文件；
 * 2. 校验失败时 fail-loud：带文件路径与字段路径报错，不静默降级；
 * 3. 在 dsh-agent-teams 创建成员时，把档案翻译成建员参数，并如实标注每个字段的归宿
 *    （运行时接收 / 仅声明 / 需落部署配置），事后再拿 team.json 的实际值核对；
 * 4. 给用户一个能看到、能编辑、能新建/导入/删除档案，并能查看/核对团队的面板。
 *
 * @module dsh-agent-roster
 */
import { readFileSync } from "node:fs";

import z from "@deepseek-ai/schemastery";

import { configView } from "./lib/config-view.js";
import { applyCaptain, listSessions } from "./lib/apply.js";
import { collectLibrary } from "./lib/library.js";
import { parseDocumentText } from "./lib/parse.js";
import { validateRoster } from "./lib/validate.js";
import { sendError, sendJson, createAuthGate, readJsonBody, requireMethod } from "./lib/http.js";
import { buildPanelSnapshot, installCollection, loadRemotePanel, resolveRoots } from "./lib/service.js";
import { fetchCollection } from "./lib/remote.js";
import { registerRosterTools } from "./lib/tools.js";
import { deleteRosterDocument, readRosterDocument, writeRosterDocument } from "./lib/write.js";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Cordis 插件名（出现在宿主日志与设置页）。 */
export const name = "agent-roster";

/** 只依赖工具注册表；档案库与团队状态都是普通文件，不依赖别的插件。 */
export const inject = ["tools"];

/**
 * 插件配置。
 *
 * 全部声明为 volatile：在设置页改完立即生效，不需要重启宿主——
 * 这些值只是"去哪读文件、界面说什么语言"，没有需要重建的生命周期资源。
 */
export const Config = z.object({
  rosterDirs: z
    .array(z.string())
    .default([])
    .description(
      "档案库目录。留空 = 全局默认目录 $DSH_HOME/agent-roster（默认 ~/.dsh/agent-roster，" +
        "docker 下就是被挂载的数据卷），与工作区无关。填绝对路径或 ~ 开头路径同样是全局的；" +
        "只有填相对路径（如 examples）才按工作区解析。第一项是四个工具默认读取的档案库。",
    )
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
  language: z
    .union([z.const("auto"), z.const("zh"), z.const("en")])
    .default("auto")
    .description("面板与设置项的语言：auto 跟随 DSH 当前语言，zh/en 固定中文或英文。")
    .volatile(),
  indexes: z
    .array(z.string())
    .default([])
    .description(
      "公共档案源（registry）列表，可填 https URL 或 npm:pkg。留空 = 只用官方源 " +
        "STofone/dsh-agent-roster 的 index/registry.json。拉取按 TTL 缓存（默认一小时一次），" +
        "网络失败时沿用上次缓存，不会把“没拉到”当成“没有档案”。",
    )
    .volatile(),
  region: z
    .union([z.const("auto"), z.const("global"), z.const("china")])
    .default("auto")
    .description("下载区：china 用腾讯 npm 镜像读 npm 形式的目录包；auto 等同 global（不自动探测，避免额外的出网请求）。")
    .volatile(),
  registryMirror: z
    .string()
    .default("")
    .description(
      "自定义 npm 镜像地址（如 https://registry.npmmirror.com 或公司 Nexus 的 /repository/npm 子路径）：" +
        "填了就优先于下载区的预置，用于按 npm 包形式发布的公共档案源。留空 = 用下载区的预置。",
    )
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
  ctx.logger?.info?.(`dsh-agent-roster ${pkg.version}: registered 5 tools`);

  // 面板路由：读快照 / 读单份档案原文 / 保存 / 删除 / 导入。
  // 没有 webServer 也不影响工具可用性。
  ctx.inject(["webServer", "connection"], (webCtx) => {
    const guard = createAuthGate(webCtx);
    const register = (path, handler, label) =>
      webCtx.effect(() => webCtx.webServer.register({ kind: "exact", path, handler }), `dsh-agent-roster: ${label}`);

    register(
      "/plugins/dsh-agent-roster/library",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const snapshot = buildPanelSnapshot(ctx, settings, { name: pkg.name, version: pkg.version });
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        // 远程源是“附属信息”：拉不到也不能让本地档案库的响应失败，所以失败只体现在 remote.diagnostics 里。
        const remote = await loadRemotePanel(settings, { refresh: query.get("refresh") === "1" });
        // 会话列表也是“附属信息”：没有 sessionController（或它报错）时面板仍要能用。
        const sessions = await listSessions(ctx.get?.("sessionController"));
        sendJson(res, 200, { ...snapshot, remote, sessions });
      },
      "library route",
    );

    register(
      "/plugins/dsh-agent-roster/collection",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const id = query.get("id") ?? "";
        const source = query.get("source") ?? "";
        const remote = await loadRemotePanel(settings, { refresh: query.get("refresh") === "1" });
        const collection = remote.collections.find(
          (item) => item.id === id && (source === "" || item.origin?.source === source),
        );
        if (collection === undefined) {
          sendJson(res, 404, { ok: false, error: { code: "collection-not-found" }, known: remote.collections.map((item) => item.id) });
          return;
        }
        const fetched = await fetchCollection(collection);
        sendJson(res, 200, {
          ok: fetched.diagnostics.every((item) => item.severity !== "error"),
          collection: {
            id: collection.id,
            title: collection.title,
            description: collection.description,
            repo: collection.repo,
            ref: collection.ref,
            path: collection.path,
            rosters: collection.rosters,
            license: collection.license,
            homepage: collection.homepage,
            origin: collection.origin,
          },
          rosters: fetched.rosters,
          diagnostics: fetched.diagnostics,
        });
      },
      "collection route",
    );

    register(
      "/plugins/dsh-agent-roster/locale",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const lang = query.get("lang") === "zh" ? "zh" : "en";
        try {
          const text = readFileSync(new URL(`./locale/${lang}.json`, import.meta.url), "utf8");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(text);
        } catch {
          sendError(res, 500, "locale-unavailable");
        }
      },
      "locale route",
    );

    register(
      "/plugins/dsh-agent-roster/document",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "GET")) return;
        const query = new URL(req.url ?? "/", "http://localhost").searchParams;
        const result = readRosterDocument({
          roots: resolveRoots(ctx, settings),
          rootDir: query.get("rootDir") ?? "",
          id: query.get("id") ?? "",
        });
        if (!result.ok) {
          sendError(res, result.code === "not-found" ? 404 : 400, result.code);
          return;
        }
        // 编辑表单需要人设原文：解析一份给编辑器用，解析失败也不挡"看源码"这条路。
        const parsed = parseDocumentText(result.text, { file: result.file, format: result.format });
        const validated = parsed.ok ? validateRoster(parsed.value, { file: result.file }) : null;
        sendJson(res, 200, {
          ok: true,
          file: result.file,
          format: result.format,
          text: result.text,
          roster: validated?.ok ? validated.roster : null,
        });
      },
      "document route",
    );

    register(
      "/plugins/dsh-agent-roster/install",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        if (typeof input.collection !== "string" || input.collection === "") {
          sendError(res, 400, "missing-collection");
          return;
        }
        const result = await installCollection(settings, {
          collectionId: input.collection,
          source: typeof input.source === "string" && input.source !== "" ? input.source : undefined,
          overwrite: input.overwrite === true,
        });
        if (result.ok !== true && result.code !== undefined) {
          sendJson(res, result.code === "collection-not-found" ? 404 : 400, {
            ok: false,
            error: { code: result.code },
            known: result.known ?? [],
            diagnostics: result.diagnostics ?? [],
          });
          return;
        }
        sendJson(res, 200, result);
      },
      "install route",
    );

    register(
      "/plugins/dsh-agent-roster/apply",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        const rosterId = typeof input.rosterId === "string" ? input.rosterId : "";
        if (rosterId === "") {
          sendError(res, 400, "missing-roster");
          return;
        }
        // 只允许对“档案库里真实存在且校验通过”的档案动手：输入不构造路径，也不走缓存。
        const library = collectLibrary(ctx, settings, { name: pkg.name, version: pkg.version });
        const rosters = library.workspaces.flatMap((workspace) => workspace.rosters);
        const roster = rosters.find((item) => item.id === rosterId);
        if (roster === undefined) {
          sendJson(res, 404, { ok: false, error: { code: "roster-not-found" }, known: rosters.map((item) => item.id) });
          return;
        }
        const result = await applyCaptain({
          sessionController: ctx.get?.("sessionController"),
          roster,
          mode: input.mode === "new" ? "new" : "existing",
          sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
          cwd: typeof input.cwd === "string" ? input.cwd : "",
        });
        const status = result.ok ? 200 : result.code === "session-controller-unavailable" ? 503 : 400;
        sendJson(res, status, result);
      },
      "apply route",
    );

    register(
      "/plugins/dsh-agent-roster/rosters",
      async (req, res) => {
        if (guard(req, res)) return;
        if (!requireMethod(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendError(res, body.status, body.code);
          return;
        }
        const input = body.value !== null && typeof body.value === "object" ? body.value : {};
        const roots = resolveRoots(ctx, settings);

        if (input.action === "delete") {
          const result = deleteRosterDocument({ roots, rootDir: input.rootDir, id: input.id });
          if (!result.ok) {
            sendError(res, result.code === "not-found" ? 404 : 400, result.code);
            return;
          }
          sendJson(res, 200, { ok: true, removed: result.removed });
          return;
        }

        if (input.action !== "save" && input.action !== "import") {
          sendError(res, 400, "unknown-action");
          return;
        }

        const result = writeRosterDocument({
          roots,
          rootDir: input.rootDir,
          text: input.text,
          format: input.format,
          // import 语义上就是"往库里放一份"，默认允许覆盖同名档案；save 必须由用户确认。
          overwrite: input.action === "import" ? input.overwrite !== false : input.overwrite === true,
          knownToolPolicies: settings.knownToolPolicies,
        });
        if (!result.ok) {
          const status =
            result.code === "exists" || result.code === "format-conflict" ? 409 : result.code === "unknown-root" ? 403 : 422;
          sendJson(res, status, {
            ok: false,
            error: { code: result.code },
            existing: result.existing ?? null,
            diagnostics: result.diagnostics ?? [],
          });
          return;
        }
        sendJson(res, 200, result);
      },
      "rosters route",
    );
  });
}

// 面板快照逻辑在 lib/library.js 与 lib/service.js：纯数据投影，可脱离宿主单测。
export { collectLibrary, markDuplicateIds, serializeRoster } from "./lib/library.js";
export { buildPanelSnapshot } from "./lib/service.js";
