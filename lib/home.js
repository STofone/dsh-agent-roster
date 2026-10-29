/**
 * DSH 数据目录（harness home）与全局档案库的解析。
 *
 * 档案库默认**不跟着工作区走**：一座机器一份，放在 DSH 的数据目录下
 * （`$DSH_HOME/agent-roster`，默认 `~/.dsh/agent-roster`）。docker 部署时
 * `$DSH_HOME` 通常就是被挂载的那个卷，因此档案天然落在持久化位置。
 *
 * 这里的解析规则与宿主 `@deepseek-ai/dsh-home-paths` 保持一致（配置 > $DSH_HOME > `~/.dsh`），
 * 但不 import 宿主包：插件要能在没有宿主的单测和 CLI 里独立跑。
 *
 * @module dsh-agent-roster/home
 */
import os from "node:os";
import nodePath from "node:path";

/** 默认数据目录名（与宿主一致）。 */
export const DSH_HOME_DIR_NAME = ".dsh";

/** 覆盖数据目录的环境变量（与宿主一致）。 */
export const DSH_HOME_ENV = "DSH_HOME";

/** 全局档案库在数据目录下的目录名。 */
export const GLOBAL_ROSTER_DIR_NAME = "agent-roster";

/**
 * 展开 `~`、`~/`、`~\` 前缀。
 *
 * @param {string} value
 * @returns {string}
 */
export function expandHomePath(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return nodePath.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * 解析 DSH 数据目录：显式配置 > `$DSH_HOME` > `~/.dsh`。
 *
 * @param {string | undefined} configured 显式覆盖（通常是插件配置里的绝对路径）
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} 绝对路径
 */
export function resolveDshHome(configured, env = process.env) {
  const explicit = typeof configured === "string" ? configured.trim() : "";
  if (explicit !== "") return nodePath.resolve(expandHomePath(explicit));
  const fromEnv = typeof env?.[DSH_HOME_ENV] === "string" ? env[DSH_HOME_ENV].trim() : "";
  if (fromEnv !== "") return nodePath.resolve(expandHomePath(fromEnv));
  return nodePath.join(os.homedir(), DSH_HOME_DIR_NAME);
}

/**
 * 全局档案库默认根目录：`<DSH_HOME>/agent-roster`。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function globalRosterRoot(env = process.env) {
  return nodePath.join(resolveDshHome(undefined, env), GLOBAL_ROSTER_DIR_NAME);
}

/**
 * 配置项是不是"与工作区无关"的全局目录。
 *
 * 空串 = 内置全局目录；`~` 开头的路径与绝对路径也都是全局的。
 * 只有相对路径（如 `rosters`、`examples`）才按工作区解析——那是给"仓库内示例库"
 * 这类有意为之的用法留的口子，不是默认行为。
 *
 * @param {string | undefined} spec
 * @returns {boolean}
 */
export function isGlobalDirSpec(spec) {
  if (typeof spec !== "string") return true;
  const trimmed = spec.trim();
  if (trimmed === "") return true;
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\") || nodePath.isAbsolute(trimmed);
}

/**
 * 把一个目录配置解析成绝对路径。
 *
 * @param {string | undefined} spec 目录配置（空串 = 内置全局目录）
 * @param {string} [workspacePath] 相对路径的基准工作区
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDirSpec(spec, workspacePath = process.cwd(), env = process.env) {
  const trimmed = typeof spec === "string" ? spec.trim() : "";
  if (trimmed === "") return globalRosterRoot(env);
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return nodePath.resolve(expandHomePath(trimmed));
  if (nodePath.isAbsolute(trimmed)) return nodePath.resolve(trimmed);
  return nodePath.resolve(workspacePath, trimmed);
}

/**
 * 给用户展示的数据目录写法（不暴露机器绝对路径）。
 *
 * @param {string} home
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function displayDshHome(home, env = process.env) {
  const fromEnv = typeof env?.[DSH_HOME_ENV] === "string" ? env[DSH_HOME_ENV].trim() : "";
  if (fromEnv !== "") return "$DSH_HOME";
  return `~/${DSH_HOME_DIR_NAME}`;
}
