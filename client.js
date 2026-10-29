/**
 * 浏览器半边：在 Web 设置的 Plugins 区挂一个只读的「Agent Roster」面板。
 *
 * 面板只做三件事：列出工作区里的档案库、展开看成员与字段归宿、把校验诊断原样摆出来。
 * 它不写文件、不创建团队——写操作仍然走 Host 侧的工具，面板是"看得见"的那一半。
 *
 * 数据来自 Host 注册的只读 JSON 路由（GET /plugins/dsh-agent-roster/library），
 * 因此不依赖任何 Remote 协议，也不需要额外的构建步骤。
 */
window.__ModuleLoader__.load({
  id: "@stofone/dsh-agent-roster",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** 本插件自有的词典命名空间。 */
    const NS = "agentRoster";

    /** Host 侧只读路由：返回当前工作区的档案库快照。 */
    const LIBRARY_ROUTE = "/plugins/dsh-agent-roster/library";

    const zh = {
      nav: "Agent Roster",
      title: "Agent Roster",
      subtitle: "静态成员档案：定义、校验，并桥接给 dsh-agent-teams。",
      refresh: "刷新",
      refreshing: "读取中…",
      failed: "读取档案库失败",
      retry: "重试",
      fallbackWorkspace: "拿不到工作区注册表，退回进程工作目录",
      empty: "这个目录里还没有档案",
      emptyHint: "新建 <rootDir>/<roster-id>/roster.json 即可，格式见插件 README。",
      members: "{count} 名成员",
      problems: "{count} 处问题",
      noProblems: "校验通过",
      defaults: "默认值",
      inherit: "继承",
      diagnostics: "诊断",
      name: "成员",
      role: "职责",
      model: "模型",
      effort: "推理强度",
      toolPolicy: "工具策略",
      fallback: "备用路由",
      tags: "标签",
      notes: "备注",
      promptChars: "人设 {count} 字",
      version: "版本",
      file: "文件",
      maintainers: "维护者",
      license: "许可证",
      description: "描述",
    };

    const en = {
      nav: "Agent Roster",
      title: "Agent Roster",
      subtitle: "Static member rosters: defined, validated, and bridged into dsh-agent-teams.",
      refresh: "Refresh",
      refreshing: "Reading…",
      failed: "Could not read the roster library",
      retry: "Retry",
      fallbackWorkspace: "No workspace registry; fell back to the process working directory",
      empty: "This directory has no rosters yet",
      emptyHint: "Create <rootDir>/<roster-id>/roster.json — see the plugin README for the format.",
      members: "{count} members",
      problems: "{count} problems",
      noProblems: "No problems",
      defaults: "Defaults",
      inherit: "inherit",
      diagnostics: "Diagnostics",
      name: "Member",
      role: "Role",
      model: "Model",
      effort: "Effort",
      toolPolicy: "Tool policy",
      fallback: "Fallback",
      tags: "Tags",
      notes: "Notes",
      promptChars: "Persona {count} chars",
      version: "Version",
      file: "File",
      maintainers: "Maintainers",
      license: "License",
      description: "Description",
    };

    const css = {
      section: {
        width: "100%",
        maxWidth: 760,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        color: "var(--dsw-alias-label-primary)",
        fontSize: 13,
        lineHeight: "20px",
      },
      header: {
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      },
      headerText: { flex: "1", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 },
      title: { fontSize: 15, fontWeight: 500, lineHeight: "22px" },
      subtitle: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" },
      button: {
        flex: "none",
        font: "inherit",
        cursor: "pointer",
        borderRadius: "var(--dsw-radius-sm)",
        border: ".5px solid var(--dsw-alias-border-l3)",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        padding: "4px 10px",
      },
      notice: {
        borderRadius: "var(--dsw-radius-lg)",
        background: "var(--dsw-alias-bg-module-platform)",
        color: "var(--dsw-alias-label-tertiary)",
        padding: "8px 10px",
        fontSize: 12,
        lineHeight: "18px",
      },
      failure: { color: "var(--dsw-alias-state-error-primary)", display: "flex", gap: 10, alignItems: "center" },
      card: {
        border: ".5px solid var(--dsw-alias-settings-card-stroke)",
        borderRadius: "var(--dsw-radius-xl)",
        background: "var(--dsw-alias-settings-card-fill)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      },
      cardHead: { display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer" },
      cardTitle: { fontSize: 14, fontWeight: 500, lineHeight: "20px", flex: "1", minWidth: 0 },
      identity: {
        fontFamily: "var(--ds-font-family-code)",
        fontSize: 12,
        color: "var(--dsw-alias-label-secondary)",
        background: "var(--dsw-alias-bg-module-platform)",
        borderRadius: "var(--dsw-radius-xs)",
        padding: "1px 6px",
      },
      meta: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" },
      ok: { color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-tertiary))" },
      grid: {
        display: "grid",
        gridTemplateColumns: "72px minmax(0, 1fr)",
        columnGap: 10,
        rowGap: 4,
        margin: 0,
      },
      term: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "17px" },
      value: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "17px", overflowWrap: "anywhere" },
      members: { display: "flex", flexDirection: "column", gap: 6, borderTop: ".5px solid var(--dsw-alias-border-l2)", paddingTop: 8 },
      member: {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        background: "var(--dsw-alias-bg-module-platform)",
        borderRadius: "var(--dsw-radius-md)",
        padding: "8px 10px",
      },
      memberHead: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
      memberName: { fontWeight: 500, fontSize: 13 },
      chip: {
        fontSize: 11,
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary)",
        borderRadius: "var(--dsw-radius-xs)",
        border: ".5px solid var(--dsw-alias-border-l3)",
        padding: "0 5px",
      },
      diag: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px", overflowWrap: "anywhere" },
    };

    /** 极简占位插值，避免为一条 UI 文案引入格式化依赖。 */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ""));
    }

    /** 把默认值与成员字段按"省缺即继承"展开，供面板标注来源。 */
    function effectiveDefaults(defaults) {
      const rows = [];
      if (defaults?.provider) rows.push([t_("model"), defaults.provider]);
      if (defaults?.model) rows.push([t_("model"), defaults.model]);
      if (defaults?.reasoningEffort) rows.push([t_("effort"), defaults.reasoningEffort]);
      if (defaults?.toolPolicy) rows.push([t_("toolPolicy"), defaults.toolPolicy]);
      if (defaults?.fallback) rows.push([t_("fallback"), defaults.fallback]);
      return rows;
    }

    let translate = (key) => en[key] ?? key;
    function t_(key) {
      return translate(key);
    }

    /** 按路由读一次快照；hook 化的最小实现，不引入状态库。 */
    function useLibrary() {
      const [state, setState] = React.useState({ status: "loading", payload: null, error: null });
      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, status: "loading" }));
        try {
          const response = await fetch(LIBRARY_ROUTE, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          setState({ status: "ready", payload, error: null });
        } catch (error) {
          setState({ status: "failed", payload: null, error: error instanceof Error ? error.message : String(error) });
        }
      }, []);
      React.useEffect(() => {
        load();
      }, [load]);
      return { state, load };
    }

    /** 字段归宿：运行时接收 / 仅声明 / 需落部署配置——面板上只用图标区分，不展开术语。 */
    function MemberBlock({ member }) {
      const chips = [];
      if (member.model) chips.push(member.model);
      else chips.push(t_("inherit"));
      if (member.reasoningEffort) chips.push(`effort:${member.reasoningEffort}`);
      if (member.toolPolicy) chips.push(`toolPolicy:${member.toolPolicy}`);
      if (member.fallback) chips.push(`fallback:${member.fallback}`);
      if (member.inherited?.length) chips.push(`${t_("inherit")}: ${member.inherited.join(", ")}`);
      return h(
        "div",
        { style: css.member },
        h(
          "div",
          { style: css.memberHead },
          h("span", { style: css.memberName }, member.name),
          h("span", { style: css.meta }, member.role),
          member.title ? h("span", { style: css.meta }, member.title) : null,
        ),
        h(
          "div",
          { style: css.memberHead },
          ...chips.map((chip, index) => h("span", { key: `${chip}-${index}`, style: css.chip }, chip)),
        ),
        member.notes ? h("div", { style: css.meta }, member.notes) : null,
      );
    }

    /** 单份档案卡片：默认折叠，展开后才渲染成员与诊断。 */
    function RosterCard({ roster }) {
      const [open, setOpen] = React.useState(false);
      const problems = roster.diagnostics?.length ?? 0;
      return h(
        "div",
        { style: css.card },
        h(
          "div",
          {
            style: css.cardHead,
            onClick: () => setOpen((value) => !value),
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen((value) => !value);
              }
            },
          },
          h("span", { style: css.cardTitle }, roster.title ?? roster.id),
          h("span", { style: css.identity }, roster.id),
          h("span", { style: css.meta }, format(t_("members"), { count: roster.members.length })),
          problems > 0
            ? h("span", { style: css.diag }, format(t_("problems"), { count: problems }))
            : h("span", { style: css.ok }, t_("noProblems")),
        ),
        open
          ? h(
              React.Fragment,
              null,
              roster.description ? h("div", { style: css.meta }, roster.description) : null,
              h(
                "dl",
                { style: css.grid },
                ...[
                  [t_("version"), roster.version],
                  [t_("file"), roster.file],
                  roster.license ? [t_("license"), roster.license] : null,
                  roster.maintainers?.length ? [t_("maintainers"), roster.maintainers.join(", ")] : null,
                  roster.tags?.length ? [t_("tags"), roster.tags.join(", ")] : null,
                ]
                  .filter(Boolean)
                  .flatMap(([term, value]) => [
                    h("dt", { key: `t:${term}`, style: css.term }, term),
                    h("dd", { key: `d:${term}`, style: css.value }, String(value)),
                  ]),
              ),
              effectiveDefaults(roster.defaults).length
                ? h(
                    "div",
                    null,
                    h("div", { style: css.meta }, t_("defaults")),
                    h(
                      "dl",
                      { style: css.grid },
                      ...effectiveDefaults(roster.defaults).flatMap(([term, value]) => [
                        h("dt", { key: `t:${term}:${value}`, style: css.term }, term),
                        h("dd", { key: `d:${term}:${value}`, style: css.value }, String(value)),
                      ]),
                    ),
                  )
                : null,
              h("div", { style: css.members }, ...roster.members.map((member) => h(MemberBlock, { key: member.name, member }))),
            )
          : null,
      );
    }

    /** 设置页里的整个面板。 */
    function AgentRosterSection() {
      const { state, load } = useLibrary();
      const busy = state.status === "loading";

      if (state.status === "failed") {
        return h(
          "div",
          { style: css.section },
          h(
            "div",
            { style: css.failure },
            h("span", null, `${t_("failed")}: ${state.error}`),
            h("button", { type: "button", style: css.button, onClick: load }, t_("retry")),
          ),
        );
      }

      if (busy && state.payload === null) {
        return h("div", { style: css.section }, h("div", { style: css.meta }, t_("refreshing")));
      }

      const payload = state.payload;
      if (payload === null) return null;

      return h(
        "div",
        { style: css.section },
        h(
          "div",
          { style: css.header },
          h(
            "div",
            { style: css.headerText },
            h("div", { style: css.title }, t_("title")),
            h("div", { style: css.subtitle }, t_("subtitle")),
          ),
          h("button", { type: "button", style: css.button, onClick: load, disabled: busy }, busy ? t_("refreshing") : t_("refresh")),
        ),
        ...(payload.workspaces ?? []).map((workspace, index) =>
          h(
            "div",
            { key: `${workspace.rootDir}-${index}`, style: { display: "flex", flexDirection: "column", gap: 10 } },
            workspace.fallbackWorkspace ? h("div", { style: css.notice }, t_("fallbackWorkspace")) : null,
            h("div", { style: css.meta }, `${workspace.workspace || workspace.workspacePath} · ${workspace.rootDir}`),
            workspace.rosters.length === 0
              ? h(
                  "div",
                  { style: css.notice },
                  h("div", null, t_("empty")),
                  h("div", null, t_("emptyHint")),
                )
              : null,
            ...workspace.rosters.map((roster) => h(RosterCard, { key: roster.file, roster })),
            workspace.diagnostics.length === 0
              ? null
              : h(
                  "div",
                  { style: css.members },
                  workspace.diagnostics.map((diagnostic, diagnosticIndex) =>
                    h(
                      "div",
                      { key: `${diagnostic.code}-${diagnosticIndex}`, style: css.diag },
                      `${diagnostic.severity}: ${diagnostic.code}${diagnostic.path ? ` @ ${diagnostic.path}` : ""} — ${diagnostic.reason}`,
                    ),
                  ),
                ),
          ),
        ),
      );
    }

    return {
      /** 依赖：槽位账本与词典服务。 */
      inject: ["slots", "locale"],
      /**
       * 注册词典并把面板挂进设置页。
       * @param {object} ctx - 浏览器插件上下文。
       */
      apply(ctx) {
        const dict = { zh, en };
        ctx.effect(() => ctx.locale.register(NS, dict), "dsh-agent-roster: dictionaries");
        const t = ctx.locale.bind(NS);
        translate = t;
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "agent-roster",
              order: 40,
              label: () => t("nav"),
              locale: NS,
            },
            AgentRosterSection,
          ),
        );
      },
    };
  },
});
