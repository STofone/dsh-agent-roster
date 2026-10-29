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
 * 只暴露插件真正使用的三项；其余字段一律不转发，避免下游误把引用对象当数据用。
 *
 * @param {object} config `apply(ctx, config)` 收到的配置
 * @returns {{
 *   rosterDirs: string[],
 *   knownToolPolicies: string[],
 *   agentTeamsStateDir: string,
 * }}
 */
export function configView(config) {
  const source = config ?? {};
  return {
    get rosterDirs() {
      const dirs = read(source.rosterDirs, ["rosters"]);
      return Array.isArray(dirs) ? dirs : ["rosters"];
    },
    get knownToolPolicies() {
      const policies = read(source.knownToolPolicies, []);
      return Array.isArray(policies) ? policies : [];
    },
    get agentTeamsStateDir() {
      const dir = read(source.agentTeamsStateDir, ".agent-teams");
      return typeof dir === "string" && dir !== "" ? dir : ".agent-teams";
    },
  };
}
