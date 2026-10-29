/**
 * 浏览器半边：Agent 档案面板 + 设置页里的语言节。
 *
 * 三个页签对应三类"用户真正关心的事"：
 * - 档案：看得见、改得动。新建/编辑/复制/删除/导入/导出都在这里完成，不再只能靠工具。
 * - 团队：agent-teams 建出来的团队到底长什么样、成员是不是真的来自档案、字段有没有漂移。
 * - 体检：档案库、目录、状态目录、工具策略这些"配置有没有指对"的问题集中在这里，
 *   面板顶部只放一条"有几件事需要处理"的横幅，避免把配置噪声堆到首屏。
 *
 * 写操作一律走 Host 的 `/plugins/dsh-agent-roster/rosters`（同源 + 宿主 connection 围栏 +
 * 档案库根目录白名单）。客户端不做权威校验：它只做"少一次无谓往返"的本地提示，
 * 真正的校验仍在 Host 侧，失败时把诊断原样摆出来。
 *
 * 位置：`main` 键控槽 + `sidebar.panellist` 列表槽，同一个 PANEL_ID 关联；
 * 设置页另注册一个 `settings.section`，只放语言与只读的配置摘要。
 */
window.__ModuleLoader__.load({
  id: "@stofone/dsh-agent-roster",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** 本插件在配置表单里的命名空间（与 cordis.patch.yml 的插件 id 一致）。 */
    const NS = "agent-roster";

    /** 主面板身份：`main` 槽的 key 与 `sidebar.panellist` 的 id 必须一致。 */
    const PANEL_ID = "agent-roster";

    const LIBRARY_ROUTE = "/plugins/dsh-agent-roster/library";
    const LOCALE_ROUTE = "/plugins/dsh-agent-roster/locale";
    const DOCUMENT_ROUTE = "/plugins/dsh-agent-roster/document";
    const ROSTERS_ROUTE = "/plugins/dsh-agent-roster/rosters";
    const INSTALL_ROUTE = "/plugins/dsh-agent-roster/install";
    const COLLECTION_ROUTE = "/plugins/dsh-agent-roster/collection";

    const EFFORTS = ["low", "medium", "high", "default"];
    const LANGUAGES = ["auto", "zh", "en"];
    const FORMATS = ["yaml", "json"];
    const STYLE_ID = "dsh-agent-roster-style";

    /* ------------------------------------------------------------------ */
    /* i18n                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 词典运行时。语言来源有两处：插件设置里的 language，与 DSH 自己的当前语言。
     * `auto` 时跟随 DSH；用户显式选择后以插件设置为准。
     */
    const i18n = {
      preference: "auto",
      activeLocale: "",
      dicts: {},
      listeners: new Set(),

      language() {
        if (this.preference === "zh" || this.preference === "en") return this.preference;
        return String(this.activeLocale).toLowerCase().startsWith("zh") ? "zh" : "en";
      },

      dict() {
        return this.dicts[this.language()] ?? {};
      },

      emit() {
        for (const listener of [...this.listeners]) listener();
      },

      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },

      /** 词典来自 Host 的只读路由，静态文件，取一次即可；失败时静默降级为 key。 */
      async load() {
        await Promise.all(
          ["en", "zh"].map(async (language) => {
            if (this.dicts[language]) return;
            try {
              const response = await fetch(`${LOCALE_ROUTE}?lang=${language}`, {
                credentials: "same-origin",
                cache: "no-store",
              });
              if (response.ok) this.dicts[language] = await response.json();
            } catch {
              /* 词典拿不到不是致命错误：界面退化成 key 名。 */
            }
          }),
        );
        this.emit();
      },
    };

    /**
     * 取词：支持点号路径与 `{name}` 插值，缺失时退回英文，再退回 key 本身。
     *
     * @param {string} key
     * @param {Record<string, unknown>} [params]
     * @returns {string}
     */
    function t(key, params) {
      const value = readPath(i18n.dict(), key) ?? readPath(i18n.dicts.en ?? {}, key) ?? key;
      if (typeof value !== "string") return key;
      if (params === undefined) return value;
      return value.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] === undefined || params[name] === null ? match : String(params[name]),
      );
    }

    function readPath(object, path) {
      let node = object;
      for (const part of path.split(".")) {
        if (node === null || typeof node !== "object") return undefined;
        node = node[part];
      }
      return typeof node === "string" ? node : undefined;
    }

    /** 订阅词典与语言变化：语言一切换，所有用它的组件重渲染。 */
    function useTranslation() {
      const [, setVersion] = useState(0);
      useEffect(() => i18n.subscribe(() => setVersion((value) => value + 1)), []);
    }

    /* ------------------------------------------------------------------ */
    /* 数据访问                                                            */
    /* ------------------------------------------------------------------ */

    async function readJson(url, init) {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
      const text = await response.text();
      let body = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, ok: response.ok, body };
    }

    /**
     * 写操作：POST JSON 到 rosters 路由。
     *
     * @param {object} payload
     * @returns {Promise<{ ok: boolean, status: number, body: any }>}
     */
    function mutate(payload) {
      return readJson(ROSTERS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    function useLibrary() {
      const [state, setState] = useState({ status: "loading", data: null, error: false });
      const load = useCallback(async () => {
        setState((current) => ({ ...current, status: current.data === null ? "loading" : "refreshing" }));
        try {
          const result = await readJson(LIBRARY_ROUTE);
          if (!result.ok || result.body === null) throw new Error(String(result.status));
          setState({ status: "ready", data: result.body, error: false });
        } catch {
          setState((current) => ({ ...current, status: "error", error: true }));
        }
      }, []);
      useEffect(() => {
        load();
      }, [load]);
      return { ...state, reload: load };
    }

    /* ------------------------------------------------------------------ */
    /* YAML 生成（表单 → 源码）                                            */
    /* ------------------------------------------------------------------ */

    /**
     * YAML 标量：能裸写就裸写，可能被误读的一律加双引号。
     *
     * @param {unknown} value
     * @returns {string}
     */
    function quote(value) {
      const text = String(value ?? "");
      const plain = /^[A-Za-z0-9\u4e00-\u9fa5][^\n:#"']*$/.test(text) && !/\s$/.test(text);
      return plain ? text : JSON.stringify(text);
    }

    /**
     * 把草稿渲染成档案源码。缩进固定两格：与 README 里的样例保持一致，人读得动。
     *
     * @param {object} draft 表单草稿
     * @returns {string}
     */
    function renderDocument(draft) {
      const lines = [];
      const push = (indent, text) => lines.push(" ".repeat(indent) + text);
      const scalar = (key, value, indent = 0) => {
        if (value === undefined || value === null || value === "") return;
        push(indent, `${key}: ${quote(value)}`);
      };

      push(0, "kind: dsh-agent-roster/v1");
      scalar("roster", draft.id);
      scalar("version", draft.version || "0.1.0");
      scalar("title", draft.title);
      scalar("description", draft.description);

      for (const [key, raw] of [
        ["tags", draft.tags],
        ["maintainers", draft.maintainers],
      ]) {
        const values = splitList(raw);
        if (values.length === 0) continue;
        push(0, `${key}:`);
        for (const value of values) push(2, `- ${quote(value)}`);
      }

      push(0, "members:");
      for (const member of draft.members) {
        push(2, `- name: ${quote(member.name)}`);
        scalarAt(push, 4, "role", member.role);
        scalarAt(push, 4, "title", member.title);
        scalarAt(push, 4, "description", member.description);
        scalarAt(push, 4, "provider", member.provider);
        scalarAt(push, 4, "model", member.model);
        scalarAt(push, 4, "reasoningEffort", member.reasoningEffort);
        scalarAt(push, 4, "toolPolicy", member.toolPolicy);
        listAt(push, 4, "aliases", splitList(member.aliases));
        listAt(push, 4, "skills", splitList(member.skills));
        listAt(push, 4, "examples", splitList(member.examples));
        const tools = splitList(member.tools);
        if (tools.length > 0) {
          push(4, "toolScope:");
          push(6, "allow:");
          for (const tool of tools) push(8, `- ${quote(tool)}`);
        }
        const prompt = String(member.systemPrompt ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
        if (prompt !== "") {
          // 人设几乎都是多行：用块标量，避免把用户的长文压成一整行转义串。
          push(4, "systemPrompt: |");
          for (const line of prompt.split("\n")) push(6, line);
        }
        scalarAt(push, 4, "notes", member.notes);
      }

      const captain = draft.captain;
      if (captain !== null && typeof captain === "object" && String(captain.name ?? "").trim() !== "") {
        push(0, "captain:");
        scalarAt(push, 2, "name", captain.name);
        scalarAt(push, 2, "description", captain.description);
        scalarAt(push, 2, "provider", captain.provider);
        scalarAt(push, 2, "model", captain.model);
        scalarAt(push, 2, "reasoningEffort", captain.reasoningEffort);
        const persona = String(captain.personaPrefix ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
        if (persona !== "") {
          push(2, "personaPrefix: |");
          for (const line of persona.split("\n")) push(4, line);
        }
      }

      return `${lines.join("\n")}\n`;
    }

    /** 一列块状数组：空数组不写，避免产出 `aliases:` 后面什么都没有的残缺 YAML。 */
    function listAt(push, indent, key, values) {
      if (!Array.isArray(values) || values.length === 0) return;
      push(indent, `${key}:`);
      for (const value of values) push(indent + 2, `- ${quote(value)}`);
    }

    function scalarAt(push, indent, key, value) {
      if (value === undefined || value === null || value === "") return;
      push(indent, `${key}: ${quote(value)}`);
    }

    /**
     * 把草稿渲染成 JSON。字段与人读的 YAML 一致，方便机器读、diff。
     *
     * @param {object} draft
     * @returns {string}
     */
    function renderJson(draft) {
      const members = draft.members.map((member) => {
        const tools = splitList(member.tools);
        const entry = { name: member.name || "" };
        for (const field of ["role", "title", "description", "provider", "model", "reasoningEffort", "toolPolicy"]) {
          if (member[field]) entry[field] = member[field];
        }
        for (const field of ["aliases", "skills", "examples"]) {
          const values = splitList(member[field]);
          if (values.length > 0) entry[field] = values;
        }
        if (tools.length > 0) entry.toolScope = { allow: tools };
        entry.systemPrompt = String(member.systemPrompt ?? "");
        if (member.notes) entry.notes = member.notes;
        return entry;
      });
      const document = {
        kind: "dsh-agent-roster/v1",
        roster: draft.id || "",
        version: draft.version || "0.1.0",
        title: draft.title || "",
        description: draft.description || "",
        tags: splitList(draft.tags),
        maintainers: splitList(draft.maintainers),
        members,
      };
      const captain = draft.captain;
      if (captain !== null && typeof captain === "object" && String(captain.name ?? "").trim() !== "") {
        const block = { name: captain.name };
        for (const field of ["description", "provider", "model", "reasoningEffort"]) {
          if (captain[field]) block[field] = captain[field];
        }
        if (String(captain.personaPrefix ?? "").trim() !== "") block.personaPrefix = captain.personaPrefix;
        document.captain = block;
      }
      return `${JSON.stringify(document, null, 2)}\n`;
    }

    function splitList(value) {
      if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item !== "");
      if (typeof value !== "string") return [];
      return value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item !== "");
    }

    /* ------------------------------------------------------------------ */
    /* 小组件                                                              */
    /* ------------------------------------------------------------------ */

    function Chip({ children, tone }) {
      return h("span", { className: `rstr-chip${tone === undefined ? "" : ` rstr-chip-${tone}`}` }, children);
    }

    function Badge({ tone, children }) {
      return h("span", { className: `rstr-badge rstr-badge-${tone ?? "info"}` }, children);
    }

    function EmptyState({ title, body, cta, onCta }) {
      return h(
        "div",
        { className: "rstr-empty" },
        h("p", { className: "rstr-empty-title" }, title),
        h("p", { className: "rstr-muted" }, body),
        cta ? h("button", { type: "button", className: "rstr-btn rstr-btn-primary", onClick: onCta }, cta) : null,
      );
    }

    /**
     * 对话框：遮罩 + 居中卡片。Esc 关闭，打开时锁住 body 滚动。
     */
    function Modal({ title, children, footer, onClose, width }) {
      const ref = useRef(null);
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);

      return h(
        "div",
        {
          className: "rstr-overlay",
          onMouseDown: (event) => {
            if (event.target === ref.current) onClose();
          },
          ref,
        },
        h(
          "div",
          {
            className: "rstr-modal",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": title,
            style: width === undefined ? undefined : { width },
          },
          h(
            "div",
            { className: "rstr-modal-head" },
            h("h2", { className: "rstr-modal-title" }, title),
            h("button", { type: "button", className: "rstr-icon-btn", onClick: onClose, "aria-label": t("editor.cancel") }, "×"),
          ),
          h("div", { className: "rstr-modal-body" }, children),
          footer ? h("div", { className: "rstr-modal-foot" }, footer) : null,
        ),
      );
    }

    function Field({ label, hint, children }) {
      return h(
        "label",
        { className: "rstr-field" },
        h("span", { className: "rstr-label" }, label),
        children,
        hint ? h("span", { className: "rstr-hint" }, hint) : null,
      );
    }

    function TextInput({ value, onChange, placeholder, mono, disabled }) {
      return h("input", {
        className: `rstr-input${mono ? " rstr-mono" : ""}`,
        value: value ?? "",
        placeholder: placeholder ?? "",
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function TextArea({ value, onChange, rows, mono, placeholder }) {
      return h("textarea", {
        className: `rstr-input rstr-textarea${mono ? " rstr-mono" : ""}`,
        value: value ?? "",
        rows: rows ?? 4,
        placeholder: placeholder ?? "",
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function Select({ value, onChange, options }) {
      return h(
        "select",
        { className: "rstr-input", value: value ?? "", onChange: (event) => onChange(event.target.value) },
        options.map((option) =>
          h("option", { key: option.value, value: option.value }, option.label),
        ),
      );
    }

    /** 诊断列表：严重度 + code + 位置 + 说明。说明来自 Host，界面不翻译它。 */
    function DiagnosticList({ items }) {
      if (!Array.isArray(items) || items.length === 0) return null;
      return h(
        "ul",
        { className: "rstr-diagnostics" },
        items.filter(Boolean).map((item, index) =>
          h(
            "li",
            { key: `${item.code ?? "item"}-${index}`, className: `rstr-diag rstr-diag-${item.severity ?? "info"}` },
            h(Badge, { tone: item.severity }, t(`diagnostics.severity${capitalize(item.severity ?? "info")}`)),
            h("code", { className: "rstr-code" }, item.code ?? ""),
            item.path ? h("span", { className: "rstr-code" }, item.path) : null,
            h("span", { className: "rstr-diag-reason" }, item.reason ?? ""),
            item.file ? h("span", { className: "rstr-muted rstr-small" }, item.file) : null,
          ),
        ),
      );
    }

    function capitalize(value) {
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
    }

    /* ------------------------------------------------------------------ */
    /* 档案卡片                                                            */
    /* ------------------------------------------------------------------ */

    function MemberBlock({ member }) {
      return h(
        "div",
        { className: "rstr-member" },
        h(
          "div",
          { className: "rstr-member-head" },
          h("strong", null, member.name),
          member.role ? h(Chip, null, member.role) : null,
          member.toolPolicy ? h(Chip, { tone: "policy" }, `${t("member.policy")}: ${member.toolPolicy}`) : null,
        ),
        member.description ? h("p", { className: "rstr-member-desc" }, member.description) : null,
        Array.isArray(member.aliases) && member.aliases.length > 0
          ? h("p", { className: "rstr-muted rstr-small" }, `${t("member.aliases")}: ${member.aliases.join(", ")}`)
          : null,
        h(
          "div",
          { className: "rstr-member-meta" },
          member.model ? h("span", null, `${t("member.model")}: ${member.model}`) : null,
          member.reasoningEffort ? h("span", null, `${t("member.effort")}: ${member.reasoningEffort}`) : null,
          member.fallback ? h("span", null, `${t("member.fallback")}: ${member.fallback}`) : null,
          member.toolScope?.allow?.length
            ? h("span", null, `${t("member.tools")}: ${member.toolScope.allow.join(", ")}`)
            : null,
          h("span", { className: "rstr-muted" }, t("team.promptChars", { count: member.systemPromptChars })),
        ),
        Array.isArray(member.skills) && member.skills.length > 0
          ? h(
              "p",
              { className: "rstr-muted rstr-small" },
              `${t("member.skills")}: ${member.skills.join(", ")}（${t("member.skillsHint")}）`,
            )
          : null,
        Array.isArray(member.inherited) && member.inherited.length > 0
          ? h("p", { className: "rstr-muted rstr-small" }, `inherited: ${member.inherited.join(", ")}`)
          : null,
        member.notes ? h("p", { className: "rstr-muted rstr-small" }, member.notes) : null,
      );
    }

    function RosterCard({ roster, deployment, onEdit, onDuplicate, onDelete, onCopy }) {
      const [open, setOpen] = useState(false);
      const errors = (roster.diagnostics ?? []).filter((item) => item?.severity === "error").length;
      const deployed = deployment !== undefined && deployment.deployed > 0;

      return h(
        "article",
        { className: `rstr-card${errors > 0 ? " rstr-card-bad" : ""}` },
        h(
          "header",
          { className: "rstr-card-head" },
          h(
            "div",
            null,
            h(
              "div",
              { className: "rstr-card-id" },
              h("code", { className: "rstr-code rstr-code-strong" }, roster.id),
              h(Chip, null, t("roster.version", { version: roster.version })),
              errors > 0 ? h(Badge, { tone: "error" }, t("roster.diagnostics", { count: errors })) : null,
            ),
            h("h3", { className: "rstr-card-title" }, roster.title || roster.id),
            roster.description ? h("p", { className: "rstr-muted" }, roster.description) : null,
          ),
        ),
        h(
          "div",
          { className: "rstr-card-meta" },
          h("span", null, t("roster.members", { count: roster.members.length })),
          h("span", { className: "rstr-muted" }, roster.file),
          h(
            "span",
            { className: deployed ? "rstr-ok" : "rstr-muted" },
            deployed
              ? t("roster.deployed", { teams: (deployment.teams ?? []).join(", ") })
              : t("roster.notDeployed"),
          ),
          deployment !== undefined && deployment.drifted > 0
            ? h(Badge, { tone: "warn" }, t("roster.drifted", { count: deployment.drifted }))
            : null,
        ),
        h(
          "div",
          { className: "rstr-card-actions" },
          h("button", { type: "button", className: "rstr-btn", onClick: () => onEdit(roster) }, t("roster.edit")),
          h("button", { type: "button", className: "rstr-btn", onClick: () => onDuplicate(roster) }, t("roster.duplicate")),
          h("button", { type: "button", className: "rstr-btn", onClick: () => onCopy(roster) }, t("roster.copyCreate")),
          h(
            "button",
            { type: "button", className: "rstr-btn rstr-btn-danger", onClick: () => onDelete(roster) },
            t("roster.delete"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "rstr-btn rstr-btn-ghost",
              "aria-expanded": open,
              onClick: () => setOpen(!open),
            },
            open ? t("roster.hideMembers") : t("roster.showMembers"),
          ),
        ),
        open
          ? h(
              "div",
              { className: "rstr-members" },
              roster.members.length === 0
                ? h("p", { className: "rstr-muted" }, t("roster.noMembers"))
                : roster.members.map((member) => h(MemberBlock, { key: member.name, member })),
              h(DiagnosticList, { items: roster.diagnostics }),
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* 团队视图                                                            */
    /* ------------------------------------------------------------------ */

    function TeamCard({ team }) {
      return h(
        "article",
        { className: "rstr-card" },
        h(
          "header",
          { className: "rstr-card-head" },
          h(
            "div",
            null,
            h(
              "div",
              { className: "rstr-card-id" },
              h("code", { className: "rstr-code rstr-code-strong" }, team.id),
              h(Badge, { tone: team.phase === "staged" ? "warn" : "ok" }, t(team.phase === "staged" ? "team.phaseStaged" : "team.phaseRunning")),
              team.halted ? h(Badge, { tone: "warn" }, t("team.halted")) : null,
              team.escalated ? h(Badge, { tone: "error" }, t("team.escalated")) : null,
            ),
            h("h3", { className: "rstr-card-title" }, team.name || team.id),
            team.description ? h("p", { className: "rstr-muted" }, team.description) : null,
          ),
        ),
        h(
          "div",
          { className: "rstr-card-meta" },
          h("span", null, t("team.tasks", team.tasks)),
          h("span", { className: "rstr-muted rstr-small" }, t("team.file") + ": " + team.file),
        ),
        h(
          "div",
          { className: "rstr-members" },
          h("div", { className: "rstr-label rstr-mt" }, t("team.members")),
          team.members.map((member) =>
            h(
              "div",
              { key: member.name, className: "rstr-member" },
              h(
                "div",
                { className: "rstr-member-head" },
                h("strong", null, member.name),
                member.role ? h(Chip, null, member.role) : null,
                member.rosterId === null
                  ? h(Badge, { tone: "muted" }, t("team.unmanaged"))
                  : h(Badge, { tone: member.faithful ? "ok" : "warn" }, t(member.faithful ? "team.faithful" : "team.drift")),
              ),
              h(
                "div",
                { className: "rstr-member-meta" },
                member.model ? h("span", null, `${t("member.model")}: ${member.model}`) : null,
                member.reasoningEffort ? h("span", null, `${t("member.effort")}: ${member.reasoningEffort}`) : null,
                member.toolPolicy ? h("span", null, `${t("member.policy")}: ${member.toolPolicy}`) : null,
                member.rosterId !== null ? h("span", { className: "rstr-muted" }, t("team.managed", { roster: member.rosterId })) : null,
                h("span", { className: "rstr-muted" }, t("team.promptChars", { count: member.promptChars })),
              ),
              member.drift.length > 0
                ? h(
                    "ul",
                    { className: "rstr-drift" },
                    member.drift.map((item) =>
                      h(
                        "li",
                        { key: item.field },
                        t("team.driftDetail", { field: item.field, wanted: item.roster, actual: item.runtime }),
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 编辑器                                                              */
    /* ------------------------------------------------------------------ */

    /** 空草稿：新建时给一个"改完就能存"的起点，而不是一张空表单。 */
    function blankDraft() {
      return {
        id: "",
        title: "",
        version: "0.1.0",
        description: "",
        tags: "",
        maintainers: "",
        members: [{ name: "", role: "", title: "", description: "", provider: "", model: "", reasoningEffort: "", toolPolicy: "", aliases: "", skills: "", examples: "", tools: "", systemPrompt: "", notes: "" }],
        captain: null,
      };
    }

    function draftFromRoster(roster) {
      return {
        id: roster.id ?? "",
        title: roster.title ?? "",
        version: roster.version ?? "0.1.0",
        description: roster.description ?? "",
        tags: (roster.tags ?? []).join(", "),
        maintainers: (roster.maintainers ?? []).join(", "),
        members: (roster.members ?? []).map((member) => ({
          name: member.name ?? "",
          role: member.role ?? "",
          title: member.title ?? "",
          description: member.description ?? "",
          provider: member.provider ?? "",
          model: member.model ?? "",
          reasoningEffort: member.reasoningEffort ?? "",
          toolPolicy: member.toolPolicy ?? "",
          aliases: (member.aliases ?? []).join(", "),
          skills: (member.skills ?? []).join(", "),
          examples: (member.examples ?? []).join("\n"),
          tools: (member.toolScope?.allow ?? []).join(", "),
          systemPrompt: member.systemPrompt ?? "",
          notes: member.notes ?? "",
        })),
        captain:
          roster.captain === null || roster.captain === undefined
            ? null
            : {
                name: roster.captain.name ?? "",
                description: roster.captain.description ?? "",
                personaPrefix: roster.captain.personaPrefix ?? "",
                provider: roster.captain.provider ?? "",
                model: roster.captain.model ?? "",
                reasoningEffort: roster.captain.reasoningEffort ?? "",
              },
      };
    }

    function Editor({ target, onClose, onSaved }) {
      useTranslation();
      const existing = target.roster;
      const duplicate = target.duplicate === true;
      const [mode, setMode] = useState("form");
      const [format, setFormat] = useState(existing?.file?.endsWith(".json") ? "json" : "yaml");
      const [draft, setDraft] = useState(() => {
        if (existing === null) return blankDraft();
        const base = draftFromRoster(existing);
        if (duplicate) {
          // 复制出来的档案必须换 id，否则保存时会撞名——这里先替用户想好一个。
          base.id = `${existing.id}-copy`;
        }
        return base;
      });
      const [source, setSource] = useState("");
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);
      const [confirmOverwrite, setConfirmOverwrite] = useState(null);
      const [loaded, setLoaded] = useState(existing === null);

      // 编辑已有档案：先拉原文，表单与源码两个视图共用同一份内容。
      useEffect(() => {
        if (existing === null) return;
        let cancelled = false;
        (async () => {
          const result = await readJson(
            `${DOCUMENT_ROUTE}?rootDir=${encodeURIComponent(existing.rootDir)}&id=${encodeURIComponent(existing.id)}`,
          );
          if (cancelled) return;
          if (result.ok && result.body) {
            setSource(result.body.text ?? "");
            // 复制模式保留自己生成的 id，不拿原档案覆盖。
            if (result.body.roster && !duplicate) setDraft(draftFromRoster(result.body.roster));
            setFormat(result.body.format ?? format);
          } else {
            setFailure({ code: "document-unreadable" });
          }
          setLoaded(true);
        })();
        return () => {
          cancelled = true;
        };
      }, [existing?.id, existing?.rootDir]);

      const text = mode === "source" ? source : format === "json" ? renderJson(draft) : renderDocument(draft);

      useEffect(() => {
        if (mode === "form") setSource(format === "json" ? renderJson(draft) : renderDocument(draft));
      }, [mode, format, draft]);

      const validation = validateDraft(draft);

      async function save(overwrite) {
        setBusy(true);
        setFailure(null);
        const result = await mutate({
          action: "save",
          rootDir: existing?.rootDir ?? target.rootDir,
          text: mode === "source" ? source : text,
          format,
          overwrite: overwrite === true,
        });
        setBusy(false);
        if (result.ok) {
          onSaved(result.body?.file ?? `${draft.id}/${format === "json" ? "roster.json" : "roster.yaml"}`);
          return;
        }
        const code = result.body?.error?.code ?? "save-failed";
        if (code === "exists" || code === "format-conflict") {
          setConfirmOverwrite({ code, existing: result.body?.existing ?? null });
          return;
        }
        setFailure({ code, diagnostics: result.body?.diagnostics ?? [] });
      }

      const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
      const updateMember = (index, patch) =>
        setDraft((current) => ({
          ...current,
          members: current.members.map((member, position) => (position === index ? { ...member, ...patch } : member)),
        }));

      const body = [];
      body.push(
        h(
          "div",
          { className: "rstr-editor-toolbar" },
          h(
            "div",
            { className: "rstr-segmented", role: "group", "aria-label": t("editor.source") },
            h(
              "button",
              { type: "button", className: `rstr-seg${mode === "form" ? " rstr-seg-on" : ""}`, onClick: () => setMode("form") },
              t("editor.form"),
            ),
            h(
              "button",
              { type: "button", className: `rstr-seg${mode === "source" ? " rstr-seg-on" : ""}`, onClick: () => setMode("source") },
              t("editor.source"),
            ),
          ),
          h(Select, {
            value: format,
            onChange: setFormat,
            options: FORMATS.map((value) => ({ value, label: value.toUpperCase() })),
          }),
        ),
      );

      if (mode === "source") {
        body.push(
          h("p", { className: "rstr-hint" }, t("editor.sourceHint")),
          h(TextArea, { value: source, onChange: setSource, rows: 22, mono: true }),
        );
      } else {
        body.push(
          h(
            "div",
            { className: "rstr-grid" },
            h(Field, { label: t("editor.id"), hint: t("editor.idHint") }, h(TextInput, { value: draft.id, onChange: (value) => update({ id: value }), mono: true })),
            h(Field, { label: t("editor.titleField") }, h(TextInput, { value: draft.title, onChange: (value) => update({ title: value }) })),
            h(Field, { label: t("editor.version") }, h(TextInput, { value: draft.version, onChange: (value) => update({ version: value }), mono: true })),
            h(Field, { label: t("editor.tags"), hint: t("editor.tagsHint") }, h(TextInput, { value: draft.tags, onChange: (value) => update({ tags: value }) })),
          ),
          h(Field, { label: t("editor.description") }, h(TextArea, { value: draft.description, onChange: (value) => update({ description: value }), rows: 2 })),
          h("div", { className: "rstr-section-title rstr-mt" }, t("editor.members")),
        );

        draft.members.forEach((member, index) => {
          body.push(
            h(
              "div",
              { key: index, className: "rstr-member-editor" },
              h(
                "div",
                { className: "rstr-member-editor-head" },
                h("span", { className: "rstr-step" }, String(index + 1)),
                h(TextInput, { value: member.name, placeholder: t("editor.memberName"), mono: true, onChange: (value) => updateMember(index, { name: value }) }),
                draft.members.length > 1
                  ? h(
                      "button",
                      { type: "button", className: "rstr-btn rstr-btn-danger rstr-btn-sm", onClick: () => setDraft((current) => ({ ...current, members: current.members.filter((_, position) => position !== index) })) },
                      t("editor.removeMember"),
                    )
                  : null,
              ),
              h(
                "div",
                { className: "rstr-grid" },
                h(Field, { label: t("editor.memberRole") }, h(TextInput, { value: member.role, onChange: (value) => updateMember(index, { role: value }) })),
                h(Field, { label: t("editor.memberTitle") }, h(TextInput, { value: member.title, onChange: (value) => updateMember(index, { title: value }) })),
                h(Field, { label: t("editor.memberProvider") }, h(TextInput, { value: member.provider, mono: true, onChange: (value) => updateMember(index, { provider: value }) })),
                h(Field, { label: t("editor.memberModel") }, h(TextInput, { value: member.model, mono: true, onChange: (value) => updateMember(index, { model: value }) })),
                h(
                  Field,
                  { label: t("editor.memberEffort") },
                  h(Select, {
                    value: member.reasoningEffort,
                    onChange: (value) => updateMember(index, { reasoningEffort: value }),
                    options: [{ value: "", label: "—" }, ...EFFORTS.map((value) => ({ value, label: value }))],
                  }),
                ),
                h(Field, { label: t("editor.memberPolicy") }, h(TextInput, { value: member.toolPolicy, mono: true, onChange: (value) => updateMember(index, { toolPolicy: value }) })),
              ),
              h(Field, { label: t("editor.memberScope"), hint: t("editor.memberScopeHint") }, h(TextInput, { value: member.tools, mono: true, onChange: (value) => updateMember(index, { tools: value }) })),
              h(Field, { label: t("editor.memberDescription") }, h(TextInput, { value: member.description, onChange: (value) => updateMember(index, { description: value }) })),
              h(Field, { label: t("editor.memberAliases"), hint: t("editor.listHint") }, h(TextInput, { value: member.aliases, mono: true, onChange: (value) => updateMember(index, { aliases: value }) })),
              h(Field, { label: t("editor.memberSkills"), hint: t("editor.skillsHint") }, h(TextInput, { value: member.skills, mono: true, onChange: (value) => updateMember(index, { skills: value }) })),
              h(Field, { label: t("editor.memberExamples"), hint: t("editor.examplesHint") }, h(TextArea, { value: member.examples, rows: 3, onChange: (value) => updateMember(index, { examples: value }) })),
              h(Field, { label: t("editor.memberPrompt") }, h(TextArea, { value: member.systemPrompt, rows: 8, onChange: (value) => updateMember(index, { systemPrompt: value }) })),
            ),
          );
        });

        body.push(
          h(
            "button",
            { type: "button", className: "rstr-btn rstr-btn-dashed", onClick: () => setDraft((current) => ({ ...current, members: [...current.members, blankDraft().members[0]] })) },
            `+ ${t("editor.addMember")}`,
          ),
        );

        const captain = draft.captain ?? { name: "", description: "", personaPrefix: "", provider: "", model: "", reasoningEffort: "" };
        const updateCaptain = (patch) => setDraft((current) => ({ ...current, captain: { ...captain, ...patch } }));
        body.push(h("div", { className: "rstr-section-title rstr-mt" }, t("editor.captain")));
        body.push(h("p", { className: "rstr-hint" }, t("editor.captainHint")));
        body.push(
          h(
            "div",
            { className: "rstr-grid" },
            h(Field, { label: t("editor.captainName"), hint: t("editor.captainNameHint") }, h(TextInput, { value: captain.name, mono: true, onChange: (value) => updateCaptain({ name: value }) })),
            h(Field, { label: t("editor.captainDescription") }, h(TextInput, { value: captain.description, onChange: (value) => updateCaptain({ description: value }) })),
            h(Field, { label: t("editor.captainProvider") }, h(TextInput, { value: captain.provider, mono: true, onChange: (value) => updateCaptain({ provider: value }) })),
            h(Field, { label: t("editor.captainModel") }, h(TextInput, { value: captain.model, mono: true, onChange: (value) => updateCaptain({ model: value }) })),
            h(
              Field,
              { label: t("editor.captainEffort") },
              h(Select, {
                value: captain.reasoningEffort,
                onChange: (value) => updateCaptain({ reasoningEffort: value }),
                options: [{ value: "", label: "—" }, ...EFFORTS.map((value) => ({ value, label: value }))],
              }),
            ),
          ),
        );
        body.push(
          h(Field, { label: t("editor.captainPersona"), hint: t("editor.captainPersonaHint") }, h(TextArea, { value: captain.personaPrefix, rows: 4, onChange: (value) => updateCaptain({ personaPrefix: value }) })),
        );
      }

      if (Object.keys(validation).length > 0) {
        body.push(h("p", { className: "rstr-hint rstr-hint-warn" }, Object.values(validation).map((key) => t(key)).join(" ")));
      }
      if (failure !== null) {
        body.push(
          h(
            "div",
            { className: "rstr-error" },
            h("p", { className: "rstr-error-title" }, t("editor.failedTitle")),
            h("code", { className: "rstr-code" }, failure.code),
            h(DiagnosticList, { items: failure.diagnostics }),
          ),
        );
      }
      if (confirmOverwrite !== null) {
        body.push(
          h(
            "div",
            { className: "rstr-confirm" },
            h("p", null, t("editor.overwriteTitle")),
            h("p", { className: "rstr-muted" }, t("editor.overwriteBody", { file: confirmOverwrite.existing?.file ?? "" })),
            h(
              "button",
              { type: "button", className: "rstr-btn rstr-btn-danger", onClick: () => { setConfirmOverwrite(null); save(true); } },
              t("editor.overwriteConfirm"),
            ),
          ),
        );
      }

      const disabled = busy || !loaded || Object.keys(validation).length > 0;

      return h(
        Modal,
        {
          title: existing ? t("editor.editTitle", { id: existing.id }) : t("editor.createTitle"),
          onClose,
          width: "820px",
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("editor.cancel")),
            h("button", { type: "button", className: "rstr-btn rstr-btn-primary", disabled, onClick: () => save(false) }, busy ? t("editor.saving") : t("editor.save")),
          ),
        },
        body,
      );
    }

    /** 表单侧的"能省一次往返"的最小校验：权威校验仍在 Host。 */
    function validateDraft(draft) {
      const problems = {};
      if (draft.id.trim() === "") problems.id = "editor.emptyId";
      if (draft.title.trim() === "") problems.title = "editor.emptyTitle";
      if (draft.members.length === 0) problems.members = "editor.emptyMembers";
      else if (draft.members.some((member) => member.name.trim() === "")) problems.memberName = "editor.emptyMemberName";
      else if (draft.members.some((member) => member.systemPrompt.trim() === "")) problems.memberPrompt = "editor.emptyMemberPrompt";
      return problems;
    }

    /* ------------------------------------------------------------------ */
    /* 导入 / 删除                                                          */
    /* ------------------------------------------------------------------ */

    function ImportDialog({ targets, initialRoot, onClose, onDone }) {
      useTranslation();
      const [text, setText] = useState("");
      const [rootDir, setRootDir] = useState(initialRoot);
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);

      async function submit() {
        setBusy(true);
        setFailure(null);
        const trimmed = text.trim();
        const format = trimmed.startsWith("{") ? "json" : "yaml";
        const result = await mutate({ action: "import", rootDir, text, format, overwrite: false });
        setBusy(false);
        if (result.ok) {
          onDone(result.body?.file ?? "");
          return;
        }
        setFailure({ code: result.body?.error?.code ?? "import-failed", diagnostics: result.body?.diagnostics ?? [] });
      }

      return h(
        Modal,
        {
          title: t("importDialog.title"),
          onClose,
          width: "760px",
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("editor.cancel")),
            h("button", { type: "button", className: "rstr-btn rstr-btn-primary", disabled: busy || text.trim() === "", onClick: submit }, busy ? t("editor.saving") : t("importDialog.submit")),
          ),
        },
        h("p", { className: "rstr-hint" }, t("importDialog.hint")),
        h(Field, { label: t("importDialog.target") }, h(Select, { value: rootDir, onChange: setRootDir, options: targets.map((target) => ({ value: target.rootDir, label: target.label })) })),
        h(TextArea, { value: text, onChange: setText, rows: 16, mono: true, placeholder: t("importDialog.placeholder") }),
        failure !== null
          ? h("div", { className: "rstr-error" }, h("code", { className: "rstr-code" }, failure.code), h(DiagnosticList, { items: failure.diagnostics }))
          : null,
      );
    }

    function DeleteDialog({ roster, onClose, onDone }) {
      useTranslation();
      const [busy, setBusy] = useState(false);
      const [failure, setFailure] = useState(null);

      async function submit() {
        setBusy(true);
        const result = await mutate({ action: "delete", rootDir: roster.rootDir, id: roster.id });
        setBusy(false);
        if (result.ok) onDone();
        else setFailure(result.body?.error?.code ?? "delete-failed");
      }

      return h(
        Modal,
        {
          title: t("delete.title", { id: roster.id }),
          onClose,
          footer: h(
            "div",
            { className: "rstr-modal-foot-actions" },
            h("button", { type: "button", className: "rstr-btn", onClick: onClose }, t("delete.cancel")),
            h("button", { type: "button", className: "rstr-btn rstr-btn-danger", disabled: busy, onClick: submit }, t("delete.confirm")),
          ),
        },
        h("p", null, t("delete.body", { file: roster.file })),
        failure !== null ? h("code", { className: "rstr-code" }, failure) : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* 主面板                                                              */
    /* ------------------------------------------------------------------ */

    function Panel() {
      useTranslation();
      const library = useLibrary();
      const [tab, setTab] = useState("rosters");
      const [query, setQuery] = useState("");
      const [editor, setEditor] = useState(null);
      const [importing, setImporting] = useState(false);
      const [removing, setRemoving] = useState(null);
      const [toast, setToast] = useState(null);

      useEffect(() => {
        if (toast === null) return;
        const timer = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(timer);
      }, [toast]);

      const snapshot = library.data;
      const rosters = useMemo(() => {
        const all = snapshot?.workspaces?.flatMap((workspace) =>
          (workspace.rosters ?? []).map((roster) => ({ ...roster, rootDir: workspace.rootDir })),
        ) ?? [];
        const needle = query.trim().toLowerCase();
        if (needle === "") return all;
        return all.filter((roster) =>
          [roster.id, roster.title, roster.description, ...(roster.tags ?? []), ...(roster.members ?? []).map((member) => member.name)]
            .filter((value) => typeof value === "string")
            .some((value) => value.toLowerCase().includes(needle)),
        );
      }, [snapshot, query]);

      const teams = snapshot?.teams?.teams ?? [];
      const hints = snapshot?.hints ?? [];
      const attention = hints.filter((hint) => hint.severity !== "info").length;
      const targets = useMemo(
        () =>
          (snapshot?.workspaces ?? []).map((workspace) => ({
            rootDir: workspace.rootDir,
            label:
              workspace.scope === "global"
                ? `${t("settings.globalLibrary")} — ${workspace.rootDir}`
                : `${workspace.rootDir}${workspace.title ? ` — ${workspace.title}` : ""}`,
          })),
        [snapshot],
      );
      const defaultRoot =
        snapshot?.workspaces?.find((workspace) => workspace.missing !== true)?.rootDir ?? targets[0]?.rootDir ?? "";

      async function copyPayload(roster) {
        const payload = {
          plan: {
            members: roster.members.map((member) => {
              const entry = { name: member.name, role: member.role || member.name };
              if (member.provider) entry.provider = member.provider;
              if (member.model) entry.model = member.model;
              if (member.reasoningEffort && member.reasoningEffort !== "default") entry.reasoningEffort = member.reasoningEffort;
              if (member.toolPolicy) entry.tool_policy = member.toolPolicy;
              return entry;
            }),
            tasks: [],
          },
        };
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          setToast(t("roster.copied"));
        } catch {
          setToast(t("roster.copyFailed"));
        }
      }

      const header = h(
        "header",
        { className: "rstr-head" },
        h(
          "div",
          null,
          h("h1", { className: "rstr-h1" }, t("panel.title")),
          h(
            "p",
            { className: "rstr-muted" },
            t("panel.subtitle", {
              rosters: snapshot?.summary?.rosters ?? 0,
              members: snapshot?.summary?.members ?? 0,
              teams: snapshot?.summary?.teams ?? 0,
            }),
          ),
        ),
        h(
          "div",
          { className: "rstr-head-actions" },
          h("button", { type: "button", className: "rstr-btn", onClick: library.reload, disabled: library.status === "refreshing" }, library.status === "refreshing" ? t("panel.refreshing") : t("panel.refresh")),
          h("button", { type: "button", className: "rstr-btn", onClick: () => setImporting(true), disabled: targets.length === 0 }, t("panel.import")),
          h("button", { type: "button", className: "rstr-btn rstr-btn-primary", onClick: () => setEditor({ roster: null, rootDir: defaultRoot }), disabled: targets.length === 0 }, t("panel.create")),
        ),
      );

      if (library.status === "loading") {
        return h("div", { className: "rstr-page" }, header, h("p", { className: "rstr-muted" }, t("panel.loading")));
      }

      if (library.status === "error" && snapshot === null) {
        return h(
          "div",
          { className: "rstr-page" },
          header,
          h(
            "div",
            { className: "rstr-error" },
            h("p", { className: "rstr-error-title" }, t("panel.errorTitle")),
            h("button", { type: "button", className: "rstr-btn", onClick: library.reload }, t("panel.retry")),
          ),
        );
      }

      const tabs = h(
        "div",
        { className: "rstr-tabs", role: "tablist" },
        [
          ["rosters", t("panel.tabsRosters"), rosters.length],
          ["teams", t("panel.tabsTeams"), teams.length],
          ["sources", t("panel.tabsSources"), snapshot?.remote?.collections?.length ?? 0],
          // 只有真正要用户处理的问题才计数：info 只是说明，不该在页签上挂数字。
          ["health", t("panel.tabsDiagnostics"), attention],
        ].map(([value, label, count]) =>
          h(
            "button",
            {
              key: value,
              type: "button",
              role: "tab",
              "aria-selected": tab === value,
              className: `rstr-tab${tab === value ? " rstr-tab-on" : ""}`,
              onClick: () => setTab(value),
            },
            label,
            h("span", { className: "rstr-tab-count" }, String(count)),
          ),
        ),
      );

      let content = null;

      if (tab === "rosters") {
        if (rosters.length === 0) {
          content = h(EmptyState, {
            title: t("panel.emptyTitle"),
            body: t("panel.emptyBody"),
            cta: targets.length === 0 ? undefined : t("panel.emptyCta"),
            onCta: () => setEditor({ roster: null, rootDir: defaultRoot }),
          });
        } else {
          content = h(
            "div",
            null,
            h("input", {
              className: "rstr-input rstr-search",
              value: query,
              placeholder: t("panel.searchPlaceholder"),
              "aria-label": t("panel.search"),
              onChange: (event) => setQuery(event.target.value),
            }),
            rosters.length === 0
              ? h("p", { className: "rstr-muted" }, t("panel.noMatch"))
              : h(
                  "div",
                  { className: "rstr-cards" },
                  rosters.map((roster) =>
                    h(RosterCard, {
                      key: `${roster.rootDir}::${roster.id}`,
                      roster,
                      deployment: snapshot?.deployments?.[roster.id],
                      onEdit: () => setEditor({ roster, rootDir: roster.rootDir }),
                      onDuplicate: () => setEditor({ roster, rootDir: roster.rootDir, duplicate: true }),
                      onDelete: () => setRemoving(roster),
                      onCopy: copyPayload,
                    }),
                  ),
                ),
          );
        }
      }

      if (tab === "teams") {
        content =
          teams.length === 0
            ? h(EmptyState, { title: t("team.emptyTitle"), body: t("team.emptyBody") })
            : h("div", { className: "rstr-cards" }, teams.map((team) => h(TeamCard, { key: team.id, team })));
      }

      if (tab === "sources") {
        content = h(SourcesTab, {
          remote: snapshot?.remote ?? null,
          onToast: setToast,
          onPulled: () => library.reload(),
        });
      }

      if (tab === "health") {
        content = h(HealthTab, { snapshot });
      }

      const banner =
        attention > 0
          ? h(
              "div",
              { className: "rstr-banner" },
              h("span", null, attention === 1 ? t("panel.bannerOne") : t("panel.bannerMany", { count: attention })),
              h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: () => setTab("health") }, t("panel.bannerCta")),
            )
          : null;

      return h(
        "div",
        { className: "rstr-page" },
        header,
        banner,
        tabs,
        content,
        h(
          "footer",
          { className: "rstr-foot" },
          h("span", { className: "rstr-muted rstr-small" }, `${snapshot?.plugin ?? "agent-roster"} ${snapshot?.version ?? ""}`),
          snapshot?.workspaces?.some((workspace) => workspace.fallbackWorkspace)
            ? h("span", { className: "rstr-muted rstr-small" }, t("panel.workspaceFallback"))
            : null,
        ),
        toast !== null ? h("div", { className: "rstr-toast", role: "status" }, toast) : null,
        editor !== null
          ? h(Editor, {
              target: { roster: editor.roster, rootDir: editor.rootDir, duplicate: editor.duplicate === true },
              onClose: () => setEditor(null),
              onSaved: (file) => {
                setEditor(null);
                setToast(file);
                library.reload();
              },
            })
          : null,
        importing
          ? h(ImportDialog, {
              targets,
              initialRoot: defaultRoot,
              onClose: () => setImporting(false),
              onDone: (file) => {
                setImporting(false);
                setToast(t("import.done", { file }));
                library.reload();
              },
            })
          : null,
        removing !== null
          ? h(DeleteDialog, {
              roster: removing,
              onClose: () => setRemoving(null),
              onDone: () => {
                setRemoving(null);
                library.reload();
              },
            })
          : null,
      );
    }

    /**
     * 公共档案源：列出订阅的 registry 目录，逐个提供「拉取到本机」。
     *
     * 拉取是**显式动作**：后端按内容比对，相同的跳过、不同的默认不覆盖（会把冲突数报回来）。
     * 前端不做这份判断——它只把结果说清楚，避免"点一下按钮，本地改动就没了"。
     */
    function SourcesTab({ remote, onToast, onPulled }) {
      useTranslation();
      const [pulling, setPulling] = useState("");
      const [openId, setOpenId] = useState("");
      const [detail, setDetail] = useState(null);

      const collections = remote?.collections ?? [];
      const indexes = remote?.indexes ?? [];
      const problems = (remote?.diagnostics ?? []).filter((item) => item.severity !== "info");

      async function pull(collection) {
        setPulling(collection.id);
        try {
          const result = await readJson(INSTALL_ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ collection: collection.id }),
          });
          if (!result.ok || result.body === null) {
            onToast(`${t("misc.failed")} (${String(result.status)})`);
            return;
          }
          const body = result.body;
          const summary = t("source.pulled", {
            written: body.written ?? 0,
            unchanged: body.unchanged ?? 0,
            conflicts: body.conflicts ?? 0,
          });
          onToast(body.conflicts > 0 ? `${summary} · ${t("source.conflictHint")}` : summary);
          onPulled();
        } catch {
          onToast(t("misc.failed"));
        } finally {
          setPulling("");
        }
      }

      async function toggle(collection) {
        if (openId === collection.id) {
          setOpenId("");
          setDetail(null);
          return;
        }
        setOpenId(collection.id);
        setDetail({ id: collection.id, status: "loading", body: null });
        const query = new URLSearchParams({ id: collection.id });
        if (collection.origin?.source !== undefined) query.set("source", collection.origin.source);
        const result = await readJson(`${COLLECTION_ROUTE}?${query.toString()}`);
        if (result.ok && result.body !== null) {
          setDetail({ id: collection.id, status: "ready", body: result.body });
        } else {
          setDetail({ id: collection.id, status: "error", body: null });
        }
      }

      if (collections.length === 0) {
        return h(
          "div",
          null,
          h(EmptyState, { title: t("source.empty"), body: t("source.emptyHint") }),
          problems.length > 0 ? h(DiagnosticList, { items: problems }) : null,
        );
      }

      return h(
        "div",
        { className: "rstr-sources" },
        indexes.length > 0
          ? h(
              "p",
              { className: "rstr-muted rstr-small" },
              indexes
                .map((index) =>
                  `${index.label} · ${index.stale ? t("source.stale") : t("source.fetchedAt", { when: index.fetchedAt ?? "-" })}`,
                )
                .join("   "),
            )
          : null,
        h(
          "div",
          { className: "rstr-cards" },
          collections.map((collection) =>
            h(
              "article",
              { key: `${collection.origin?.source ?? ""}::${collection.id}`, className: "rstr-card" },
              h(
                "header",
                { className: "rstr-card-head" },
                h("h3", { className: "rstr-card-title" }, collection.title || collection.id),
                h(Badge, { tone: "neutral" }, t("source.registered", { count: collection.rosters?.length ?? 0 })),
              ),
              collection.description ? h("p", { className: "rstr-card-desc" }, collection.description) : null,
              h(
                "p",
                { className: "rstr-muted rstr-small" },
                `${t("source.repo")} ${collection.repo ?? ""}@${collection.ref ?? "main"}${collection.path ? `/${collection.path}` : ""}`,
              ),
              h(
                "div",
                { className: "rstr-card-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "rstr-btn rstr-btn-primary",
                    disabled: pulling !== "",
                    onClick: () => pull(collection),
                  },
                  pulling === collection.id ? t("source.pulling") : t("source.pull"),
                ),
                h(
                  "button",
                  { type: "button", className: "rstr-btn", onClick: () => toggle(collection) },
                  openId === collection.id ? t("source.hide") : t("source.open"),
                ),
              ),
              openId === collection.id
                ? detail === null || detail.status === "loading"
                  ? h("p", { className: "rstr-muted" }, t("source.loading"))
                  : detail.status === "error"
                    ? h("p", { className: "rstr-muted" }, t("misc.failed"))
                    : h(
                        "div",
                        { className: "rstr-source-detail" },
                        (detail.body?.rosters ?? []).map((roster) =>
                          h(
                            "div",
                            { key: roster.id, className: "rstr-source-roster" },
                            h("span", { className: "rstr-mono" }, roster.id),
                            h("span", { className: "rstr-muted" }, roster.title ?? ""),
                            h(Badge, { tone: "neutral" }, `${(roster.members ?? []).length}`),
                          ),
                        ),
                        (detail.body?.diagnostics ?? []).length > 0
                          ? h(DiagnosticList, { items: detail.body.diagnostics })
                          : null,
                      )
                : null,
            ),
          ),
        ),
        problems.length > 0 ? h(DiagnosticList, { items: problems }) : null,
      );
    }

    /** 体检页：配置摘要 + 提示 + 诊断，全部来自快照，不在前端算任何东西。 */
    function HealthTab({ snapshot }) {
      const hints = snapshot?.hints ?? [];
      const diagnostics = (snapshot?.workspaces ?? []).flatMap((workspace) => workspace.diagnostics ?? []);
      const teamDiagnostics = snapshot?.teams?.diagnostics ?? [];

      return h(
        "div",
        { className: "rstr-health" },
        h(
          "div",
          { className: "rstr-config" },
          configRow(
            t("settings.rosterDirs"),
            (snapshot?.config?.rosterDirs ?? []).length > 0
              ? snapshot.config.rosterDirs.join(", ")
              : `${t("settings.globalLibrary")} ${snapshot?.config?.defaultRoot ?? ""}`,
          ),
          configRow(t("settings.dataDir"), snapshot?.config?.dshHome ?? ""),
          configRow(t("settings.stateDir"), snapshot?.teams?.stateDir ?? ""),
          configRow(t("settings.policies"), snapshot?.config?.knownToolPolicies?.length ? t("settings.policiesCount", { count: snapshot.config.knownToolPolicies.length }) : t("settings.policiesNone")),
          configRow(t("settings.version"), snapshot?.version ?? ""),
        ),
        hints.length === 0
          ? h("p", { className: "rstr-muted" }, t("diagnostics.empty"))
          : h(
              "div",
              { className: "rstr-hint-cards" },
              hints.map((hint, index) =>
                h(
                  "article",
                  { key: `${hint.code}-${index}`, className: "rstr-hint-card" },
                  h(
                    "div",
                    { className: "rstr-hint-card-head" },
                    h(Badge, { tone: hint.severity }, severityLabel(hint.severity)),
                    h("strong", null, t(`hint.${hint.code}.title`)),
                  ),
                  h("p", { className: "rstr-muted" }, t(`hint.${hint.code}.body`, hint.params ?? {})),
                ),
              ),
            ),
        h(DiagnosticList, { items: [...diagnostics, ...teamDiagnostics] }),
      );
    }

    function configRow(label, value) {
      return h(
        "div",
        { className: "rstr-config-row" },
        h("span", { className: "rstr-label" }, label),
        h("code", { className: "rstr-code rstr-truncate", title: value }, value === "" ? "—" : value),
      );
    }

    /**
     * 严重度的可读标签。`settings` 里没有 severity 词条，复用诊断里的三个词，
     * 拼不出词条时退回原始值——宁可露出 `warn` 也不显示空标签。
     */
    function severityLabel(severity) {
      const key = `diagnostics.severity${capitalize(severity ?? "info")}`;
      const value = readPath(i18n.dict(), key) ?? readPath(i18n.dicts.en ?? {}, key);
      return value ?? String(severity ?? "info");
    }

    /* ------------------------------------------------------------------ */
    /* 设置页：语言 + 只读配置摘要                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 设置页的一节。
     *
     * 语言的写入走配置表单（`configForms.get(NS)`），因此保存后立即生效、无需重启；
     * 语言之外的配置项只读展示——档案目录与状态目录属于"部署事实"，
     * 让它们出现在两个地方反而会让人分不清哪个生效。
     */
    function SettingsSection({ form, library, onOpenPanel }) {
      useTranslation();
      const [language, setLanguage] = useState(() => readFormLanguage(form));
      const [version, setVersion] = useState("");

      useEffect(() => {
        if (form?.subscribe === undefined) return undefined;
        const off = form.subscribe(() => setLanguage(readFormLanguage(form)));
        return () => {
          if (typeof off === "function") off();
        };
      }, [form]);

      useEffect(() => {
        setVersion(String(library?.data?.version ?? ""));
      }, [library?.data?.version]);

      function change(next) {
        setLanguage(next);
        // auto 用空串表示"跟随"：配置项的默认值就是 auto，写回字符串即可。
        form?.set?.("language", next);
      }

      return h(
        "section",
        { className: "rstr-settings" },
        h("h3", { className: "rstr-settings-title" }, t("settings.nav")),
        h("p", { className: "rstr-muted rstr-small" }, t("settings.languageHint")),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.language")),
          h(
            "div",
            { className: "rstr-segmented" },
            LANGUAGES.map((value) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  className: `rstr-seg${language === value ? " rstr-seg-on" : ""}`,
                  "aria-pressed": language === value,
                  onClick: () => change(value),
                },
                value === "auto" ? t("settings.languageAuto") : value === "zh" ? t("settings.languageZh") : t("settings.languageEn"),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.rosterDirs")),
          h(
            "code",
            { className: "rstr-code rstr-truncate", title: (library?.data?.config?.rosterDirs ?? []).join(", ") },
            (library?.data?.config?.rosterDirs ?? []).length > 0
              ? library.data.config.rosterDirs.join(", ")
              : `${t("settings.globalLibrary")} ${library?.data?.config?.defaultRoot ?? ""}`,
          ),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.dataDir")),
          h(
            "code",
            { className: "rstr-code rstr-truncate", title: library?.data?.config?.defaultRoot ?? "" },
            library?.data?.config?.dshHome ?? "—",
          ),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.stateDir")),
          h("code", { className: "rstr-code rstr-truncate", title: library?.data?.teams?.stateDir ?? "" }, library?.data?.teams?.stateDir ?? "—"),
        ),
        h(
          "div",
          { className: "rstr-settings-row" },
          h("span", { className: "rstr-label" }, t("settings.version")),
          h("code", { className: "rstr-code" }, version),
          h("button", { type: "button", className: "rstr-btn rstr-btn-sm", onClick: onOpenPanel }, t("settings.openPanel")),
        ),
      );
    }

    function readFormLanguage(form) {
      let value = "auto";
      try {
        const snapshotValue = form?.getSnapshot?.()?.value;
        if (snapshotValue !== null && typeof snapshotValue === "object" && LANGUAGES.includes(snapshotValue.language)) {
          value = snapshotValue.language;
        }
      } catch {
        /* 表单不可用时按"跟随 DSH"处理。 */
      }
      return value;
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 一次性注入样式表。
     *
     * 颜色**只用**宿主真实存在的 alias token（见 dsh-client-ui-theme 的 body
     * 变量表），**不写浅色兜底值**：宿主的 token 会随 `body[data-ds-dark-theme]`
     * 整体切换，写死 `#fff`/`#111` 的兜底在暗色下就是白底白字。
     * 需要"淡色底"的地方用 `color-mix(... , transparent)` 自己算，深浅主题都成立。
     * 文本色一律显式给出（不用 inherit），避免继承到与背景同色的文本。
     */
    const CSS = `
.rstr-page { display: flex; flex-direction: column; gap: 16px; padding: 20px 24px 32px; max-width: 1120px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.55; }
.rstr-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.rstr-h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
.rstr-muted { color: var(--dsw-alias-label-secondary); margin: 0; }
.rstr-small { font-size: 12px; }
.rstr-mono, .rstr-code, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.rstr-code { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.rstr-code-strong { font-size: 13px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.rstr-truncate { display: inline-block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.rstr-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.rstr-btn { border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 13px; font-family: inherit; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.rstr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.rstr-btn:disabled { opacity: .5; cursor: not-allowed; }
.rstr-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); }
.rstr-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }
.rstr-btn-danger { color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 72%, var(--dsw-alias-label-primary)); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.rstr-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.rstr-btn-ghost { border-style: dashed; }
.rstr-btn-sm { padding: 3px 9px; font-size: 12px; }
.rstr-btn-dashed { width: 100%; border-style: dashed; margin-top: 8px; }
.rstr-icon-btn { border: none; background: transparent; font-size: 20px; line-height: 1; cursor: pointer; color: var(--dsw-alias-label-secondary); padding: 4px 8px; border-radius: 6px; }
.rstr-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }

.rstr-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
.rstr-input::placeholder { color: var(--dsw-alias-label-secondary); }
.rstr-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.rstr-textarea { resize: vertical; line-height: 1.5; }
.rstr-textarea.rstr-mono { font-size: 12px; }
.rstr-search { max-width: 320px; }

.rstr-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: 10px; background: var(--dsw-alias-state-warn-tertiary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); color: var(--dsw-alias-label-primary); }

.rstr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rstr-tab { border: none; background: transparent; padding: 8px 12px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; border-bottom: 2px solid transparent; display: inline-flex; align-items: center; gap: 6px; }
.rstr-tab:hover { color: var(--dsw-alias-label-primary); }
.rstr-tab-on { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.rstr-tab-count { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-secondary); }

.rstr-cards { display: grid; gap: 12px; }
.rstr-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 10px; }
.rstr-card-bad { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent); }
.rstr-card-id { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rstr-card-title { margin: 4px 0 2px; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rstr-card-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.rstr-card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.rstr-sources { display: flex; flex-direction: column; gap: 10px; }
.rstr-source-detail { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 8px; }
.rstr-source-roster { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.rstr-source-roster > .rstr-muted { flex: 1 1 auto; }
.rstr-ok { color: var(--dsw-alias-label-secondary); font-weight: 600; }

.rstr-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-secondary); }
.rstr-chip-policy { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-label-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent); }
.rstr-badge { font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid transparent; color: var(--dsw-alias-label-primary); }
.rstr-badge-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.rstr-badge-warn { background: var(--dsw-alias-state-warn-tertiary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.rstr-badge-ok { background: var(--dsw-alias-state-success-tertiary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); }
.rstr-badge-info, .rstr-badge-muted { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-secondary); }

.rstr-members { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 10px; }
.rstr-member { padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-primary); }
.rstr-member-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rstr-member-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
.rstr-drift { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 72%, var(--dsw-alias-label-primary)); }

.rstr-empty { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 12px; padding: 32px 24px; text-align: center; display: flex; flex-direction: column; gap: 8px; align-items: center; color: var(--dsw-alias-label-primary); }
.rstr-empty-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }

.rstr-health { display: flex; flex-direction: column; gap: 14px; }
.rstr-config { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 10px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-primary); }
.rstr-config-row { display: flex; gap: 12px; align-items: baseline; }
.rstr-config-row .rstr-label { min-width: 160px; }
.rstr-hint-cards { display: grid; gap: 10px; }
.rstr-hint-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; color: var(--dsw-alias-label-primary); }
.rstr-hint-card-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }

.rstr-diagnostics { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rstr-diag { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-primary); }
.rstr-diag-reason { color: var(--dsw-alias-label-primary); }

.rstr-overlay { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-3); display: flex; align-items: flex-start; justify-content: center; padding: 5vh 16px; z-index: 1000; overflow: auto; }
.rstr-modal { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; width: 640px; max-width: 100%; box-shadow: 0 24px 64px rgba(0,0,0,.32); display: flex; flex-direction: column; max-height: 90vh; }
.rstr-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rstr-modal-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rstr-modal-body { padding: 16px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.rstr-modal-foot { padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; justify-content: flex-end; gap: 8px; }
.rstr-modal-foot-actions { display: flex; gap: 8px; }

.rstr-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rstr-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.rstr-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }
.rstr-hint-warn { color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 70%, var(--dsw-alias-label-primary)); }
.rstr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.rstr-section-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.rstr-mt { margin-top: 6px; }

.rstr-editor-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rstr-editor-toolbar .rstr-input { width: 110px; }
.rstr-segmented { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; overflow: hidden; }
.rstr-seg { border: none; background: transparent; padding: 5px 12px; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.rstr-seg:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rstr-seg-on { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }

.rstr-member-editor { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; color: var(--dsw-alias-label-primary); }
.rstr-member-editor-head { display: flex; align-items: center; gap: 8px; }
.rstr-member-editor-head .rstr-input { width: 180px; }
.rstr-step { width: 20px; height: 20px; border-radius: 50%; background: var(--dsw-alias-button-ghost-active-fill); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); }

.rstr-error { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; color: var(--dsw-alias-label-primary); }
.rstr-error-title { margin: 0; font-weight: 600; color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 72%, var(--dsw-alias-label-primary)); }
.rstr-confirm { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); background: var(--dsw-alias-state-warn-tertiary); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; color: var(--dsw-alias-label-primary); }

.rstr-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label); padding: 8px 16px; border-radius: 999px; font-size: 13px; z-index: 1100; box-shadow: 0 8px 24px rgba(0,0,0,.24); }

.rstr-foot { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; margin-top: 4px; color: var(--dsw-alias-label-secondary); }

.rstr-settings { display: flex; flex-direction: column; gap: 10px; }
.rstr-settings-title { margin: 0; font-size: 14px; font-weight: 600; }
.rstr-settings-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rstr-settings-row .rstr-label { min-width: 120px; }
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ */
    /* 挂载                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 注册面板、语言节，并把插件配置与 DSH 语言同步进词典运行时。
     *
     * @param {object} ctx 客户端上下文
     * @param {{ settings?: object }} [_config] 客户端拿不到插件配置，语言走配置表单
     * @returns {{ apply: Function }}
     */
    function defineClient() {
      return { inject: ["slots"], apply };
    }

    /**
     * 客户端挂载点。
     *
     * 三个订阅源（配置表单 / DSH 语言 / 词典加载）都汇进同一个 i18n 对象：
     * 任意一处变化都触发面板与设置节重渲染，不需要手动刷新页面。
     *
     * @param {object} ctx
     * @returns {void}
     */
    function apply(ctx) {
      ensureStyle();
      if (typeof document !== "undefined") void i18n.load();

      const locale = ctx.get?.("locale") ?? ctx.locale;
      const configForms = ctx.get?.("configForms") ?? ctx.configForms;
      const form = configForms?.get?.(NS) ?? null;
      const layout = ctx.get?.("layout") ?? ctx.layout;

      const readActive = () => {
        try {
          const value = locale?.getLocale?.();
          if (typeof value === "string") return value;
          if (value !== null && typeof value === "object") {
            // LocaleSnapshot：{ active, locales, revision }。先取 active，再退到旧形状。
            return String(value.active ?? value.id ?? value.language ?? value.lang ?? "");
          }
        } catch {
          /* 拿不到就当英文。 */
        }
        return "";
      };

      const sync = () => {
        i18n.preference = readFormLanguage(form);
        i18n.activeLocale = readActive();
        i18n.emit();
      };
      sync();

      // 词典是异步取的：取到之后注册进宿主 locale 服务，槽位里的 `locale` 字段
      // 与 label() 才会走宿主的查找链；注册失败（已存在/语言包不接受）不影响自绘词典。
      let registered = false;
      const registerDictionaries = () => {
        if (registered) return;
        if (typeof locale?.register !== "function") return;
        if (i18n.dicts.en === undefined || i18n.dicts.zh === undefined) return;
        registered = true;
        try {
          locale.register(NS, "en", i18n.dicts.en);
          locale.register(NS, "zh", i18n.dicts.zh);
        } catch {
          /* 词典所有权冲突时保持静默：界面仍用 i18n.dict()。 */
        }
      };
      i18n.subscribe(registerDictionaries);
      registerDictionaries();

      ctx.effect(
        () => {
          const offs = [];
          for (const source of [form, locale]) {
            if (source !== null && source !== undefined && typeof source.subscribe === "function") {
              const off = source.subscribe(sync);
              if (typeof off === "function") offs.push(off);
            }
          }
          return () => {
            for (const off of offs) off();
          };
        },
        "agent-roster: language sync",
      );

      const openPanel = () => {
        try {
          layout?.selectPanel?.(PANEL_ID);
        } catch {
          /* 面板注册晚于点击时 selectPanel 会抛错，忽略即可。 */
        }
      };

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 20,
            locale: NS,
            label: () => t("settings.nav"),
          },
          function RosterSidebarIcon(props) {
            const size = props?.size ?? 16;
            const active = props?.active === true;
            return h(
              "svg",
              {
                width: size,
                height: size,
                viewBox: "0 0 20 20",
                fill: "none",
                "aria-hidden": "true",
                style: { opacity: active ? 1 : 0.85 },
              },
              // 两个头型：左边实心大圆，右边描边小圆，读起来像"一队人"。
              h("circle", { cx: 7.5, cy: 7, r: 3.2, fill: "currentColor", opacity: active ? 1 : 0.75 }),
              h("path", { d: "M2.6 16.4c0-2.9 2.2-4.6 4.9-4.6s4.9 1.7 4.9 4.6", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", fill: "none" }),
              h("circle", { cx: 14.4, cy: 8.2, r: 2.3, stroke: "currentColor", strokeWidth: 1.4, fill: "none" }),
              h("path", { d: "M12.4 16.2c.2-2.2 1.5-3.5 3.4-3.5 1.5 0 2.6.9 3 2.4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", fill: "none" }),
            );
          },
        ),
      );

      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, Panel),
      );

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: PANEL_ID, order: 55, locale: NS, label: () => t("settings.nav") },
          function AgentRosterSettings() {
            const library = useLibrary();
            return h(SettingsSection, { form, library, onOpenPanel: openPanel });
          },
        ),
      );
    }

    return defineClient();
  },
});

