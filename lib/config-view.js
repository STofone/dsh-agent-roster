/**
 * 配置读取视图：把插件配置读成"每次访问都取当前值"的形态。
 *
 * 声明为 `volatile` 的字段在运行时拿到的**不是快照值**，而是一个引用对象（`.get()`）：
 * 宿主用它承载"改设置立即生效"。所以这里不能读一次就存下来——否则用户改了档案库
 * 目录却要重启宿主，那正是 volatile 想避免的事。
 *
 * 三种输入都要能接：引用对象（volatile）、普通值（非 volatile）、缺省（未配置）。
 *
 * @module dsh-agent-roster/config-view
 */

/**
 * 读一个配置单元：引用对象取值、普通值原样、缺省用兜底。
 *
 * @template T
 * @param {unknown} cell 配置字段
 * @param {T} fallback 缺省值
 * @returns {T}
 */
function read(cell, fallback) {
  if (cell === undefined || cell === null) return fallback;
  if (typeof cell === "object" && typeof cell.get === "function") {
    const value = cell.get();
    return value === undefined || value === null ? fallback : value;
  }
  if (Array.isArray(cell) && cell.length === 0) return fallback;
  return cell;
}

/**
 * 把 Config 解析结果包成带 getter 的视图。
 *
 * 只转发插件真正使用的字段；其余一律不透传，避免下游误把引用对象当数据用。
 *
 * @param {object} config `apply(ctx, config)` 收到的配置
 * @returns {{
 *   rosterDirs: string[],
 *   knownToolPolicies: string[],
 *   agentTeamsStateDir: string,
 *   indexes: unknown,
 *   region: string,
 * }}
 */
export function configView(config) {
  const source = config ?? {};
  return {
    get rosterDirs() {
      // 缺省 = 空串 = 机器级全局库（$DSH_HOME/agent-roster），与 0.3.0 起的默认一致。
      const dirs = read(source.rosterDirs, [""]);
      return Array.isArray(dirs) ? dirs : [""];
    },
    get knownToolPolicies() {
      const policies = read(source.knownToolPolicies, []);
      return Array.isArray(policies) ? policies : [];
    },
    get agentTeamsStateDir() {
      const dir = read(source.agentTeamsStateDir, ".agent-teams");
      return typeof dir === "string" && dir !== "" ? dir : ".agent-teams";
    },
    /**
     * 索引源。三种取值都必须原样保留：
     * `undefined`/空数组 = 官方源；显式 `false` = 完全关掉远端；数组 = 自定义源。
     */
    get indexes() {
      if (typeof source.indexes === "object" && source.indexes !== null && typeof source.indexes.get === "function") {
        return source.indexes.get();
      }
      return source.indexes;
    },
    get region() {
      const region = read(source.region, "auto");
      return typeof region === "string" && region !== "" ? region : "auto";
    },
  };
}
