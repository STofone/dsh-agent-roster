/**
 * 队长（captain）侧：把部署里真实写着的队长配置读出来，和档案里的声明逐字段核对。
 *
 * 为什么需要单独一层：队长**不是一个成员**。agent-teams 的 state 里只有
 * `captainSessionId` 与 `captainInbox`，没有 captain 成员行，也没有任何工具参数能改写
 * 队长的路由——队长就是"创建团队的那个会话"，它的模型来自部署配置
 * （profile 的 `agent-default-model`），它的人格来自 agent preset 的 persona。
 *
 * 所以档案里的 `captain` 段只能声明，落地要动部署配置。这一层负责两件事：
 * 1. 从 profile 的 `cordis.patch.yml` 里读出**实际值**（provider / model / persona 前缀）；
 * 2. 把实际值和声明逐字段比对，给出 `match / differ / undeclared / unknown` 四态。
 *
 * 解析只用行扫描、不引 YAML 解析器：这些 patch 文件里含 `!!js` 标签，
 * 通用 YAML 解析会直接抛错；而我们要的字段全是顶格的行结构。
 *
 * @module dsh-agent-roster/captain
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { displayDshHome, resolveDshHome } from "./home.js";

/** 部署配置里承载队长模型的插件行 id。 */
export const MODEL_ROW_ID = "agent-default-model";

/** agent preset 行的 id 前缀。 */
export const PRESET_ID_PREFIX = "preset-";

const PATCH_FILE_NAME = "cordis.patch.yml";

/**
 * 去掉包裹用的引号（只处理配对的首尾引号，不碰内部字符）。
 *
 * @param {string} text
 * @returns {string}
 */
function unquote(text) {
  const value = text.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 解析 patch 文本，返回**所有** preset 的 persona 前缀（上面的单行扫描已按 preset 分组，
 * 这里补一份完整列表，便于核对任意 preset）。
 *
 * @param {string} text
 * @param {string} profile
 * @returns {{ profile: string, provider: string, model: string, reasoningEffort: string, personas: object[] }}
 */
export function parseDeployedProfile(text, profile) {
  const lines = String(text ?? "").split(/\r?\n/);
  const result = { profile, provider: "", model: "", reasoningEffort: "", personas: [] };

  let row = null;
  let inPersona = false;
  let blockIndent = -1;
  let blockLines = [];

  const flushBlock = () => {
    if (blockLines.length > 0 && row?.kind === "preset") {
      row.personaPrefixes.push(blockLines.join("\n").trim());
    }
    blockLines = [];
    blockIndent = -1;
  };

  const closePreset = () => {
    if (row?.kind === "preset") {
      for (const prefix of row.personaPrefixes) {
        result.personas.push({ preset: row.id, prefix });
      }
    }
  };

  for (const line of lines) {
    if (blockIndent >= 0) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() !== "" && indent >= blockIndent) {
        blockLines.push(line.trim());
        continue;
      }
      flushBlock();
    }

    const top = /^-\s+id:\s*(\S+)\s*$/.exec(line);
    if (top !== null) {
      closePreset();
      const id = top[1];
      if (id === MODEL_ROW_ID) row = { kind: "model" };
      else if (id.startsWith(PRESET_ID_PREFIX)) row = { kind: "preset", id, personaPrefixes: [] };
      else row = { kind: "other" };
      inPersona = false;
      continue;
    }
    if (row === null) continue;

    if (row.kind === "model") {
      const field = /^\s+(provider|model|reasoningEffort):\s*(.+?)\s*$/.exec(line);
      if (field !== null) {
        const value = unquote(field[2]);
        if (field[1] === "provider") result.provider = value;
        else if (field[1] === "model") result.model = value;
        else result.reasoningEffort = value;
      }
      continue;
    }

    if (row.kind === "preset") {
      const sub = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line);
      if (sub !== null) {
        inPersona = sub[1] === "persona";
        continue;
      }
      if (!inPersona) continue;
      const prefix = /^(\s+)prefix:\s*(.*)$/.exec(line);
      if (prefix === null) continue;
      const value = prefix[2].trim();
      if (value === "|" || value === ">" || value === "|-" || value === ">-") {
        blockIndent = prefix[1].length + 1;
        blockLines = [];
        continue;
      }
      if (value !== "") row.personaPrefixes.push(unquote(value));
    }
  }
  flushBlock();
  closePreset();

  return result;
}

/**
 * 读本机所有 profile 的队长配置。
 *
 * @param {{ dshHome?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ home: string, displayed: string, profiles: object[], diagnostics: object[] }}
 */
export function readDeployedCaptains(options = {}) {
  const env = options.env ?? process.env;
  const home = resolveDshHome(options.dshHome, env);
  const profilesDir = nodePath.join(home, "profiles");
  const diagnostics = [];
  const profiles = [];

  if (!existsSync(profilesDir)) {
    return { home, displayed: displayDshHome(home, env), profiles, diagnostics };
  }

  let names = [];
  try {
    names = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    diagnostics.push({
      severity: "warn",
      code: "profiles-unreadable",
      reason: String(error?.message ?? error),
    });
    return { home, displayed: displayDshHome(home, env), profiles, diagnostics };
  }

  for (const name of names) {
    const file = nodePath.join(profilesDir, name, PATCH_FILE_NAME);
    if (!existsSync(file)) continue;
    try {
      profiles.push(parseDeployedProfile(readFileSync(file, "utf8"), name));
    } catch (error) {
      diagnostics.push({
        severity: "warn",
        code: "profile-unreadable",
        params: { profile: name },
        reason: String(error?.message ?? error),
      });
    }
  }

  return { home, displayed: displayDshHome(home, env), profiles, diagnostics };
}

/**
 * 逐个字段比对"档案声明"与"部署实际值"。
 *
 * 四态含义：
 * - `match`：声明了且部署一致；
 * - `differ`：声明了但部署不一致（要改部署配置，改档案没用）；
 * - `undeclared`：档案没声明，运行时用部署默认（不是错误，只是没有约束）；
 * - `unknown`：读不到部署配置，无法判断（也不能假装通过）。
 *
 * @param {object | null | undefined} captain 档案的 captain 段
 * @param {{ profiles?: object[], displayed?: string }} deployed `readDeployedCaptains` 的结果
 * @returns {{ checks: object[], ok: boolean, target: object | null, profiles: object[] }}
 */
export function verifyCaptain(captain, deployed = {}) {
  const declared = captain !== null && typeof captain === "object" ? captain : {};
  const profiles = Array.isArray(deployed.profiles) ? deployed.profiles : [];
  // 多 profile 时无法确定"这个会话到底跑哪一个"，所以只给出每个字段的"任一匹配"结论，
  // 并把候选 profile 名单一起返回，让界面说清楚"这是哪个 profile 的值"。
  const target = profiles.length === 1 ? profiles[0] : null;
  const compare = (field, declaredValue, actualValues) => {
    const values = actualValues.filter((value) => typeof value === "string" && value !== "");
    if (typeof declaredValue !== "string" || declaredValue === "") {
      const fallback = values.length > 0 ? values[0] : "";
      return {
        field,
        status: fallback === "" ? "undeclared" : "undeclared",
        declared: "",
        actual: fallback,
      };
    }
    if (values.length === 0) {
      return { field, status: "unknown", declared: declaredValue, actual: "" };
    }
    const hit = values.includes(declaredValue);
    return {
      field,
      status: hit ? "match" : "differ",
      declared: declaredValue,
      actual: values.join(", "),
    };
  };

  const checks = [
    compare("provider", declared.provider, profiles.map((profile) => profile.provider)),
    compare("model", declared.model, profiles.map((profile) => profile.model)),
    compare(
      "reasoningEffort",
      declared.reasoningEffort === "default" ? "" : declared.reasoningEffort,
      profiles.map((profile) => profile.reasoningEffort),
    ),
  ];

  const personaPrefix = typeof declared.personaPrefix === "string" ? declared.personaPrefix.trim() : "";
  const prefixes = profiles.flatMap((profile) => profile.personas.map((persona) => persona.prefix));
  if (personaPrefix === "") {
    checks.push({ field: "personaPrefix", status: prefixes.length > 0 ? "undeclared" : "unknown", declared: "", actual: prefixes[0] ?? "" });
  } else if (prefixes.length === 0) {
    checks.push({ field: "personaPrefix", status: "unknown", declared: personaPrefix, actual: "" });
  } else {
    const hit = prefixes.some((prefix) => prefix.trim() === personaPrefix);
    checks.push({
      field: "personaPrefix",
      status: hit ? "match" : "differ",
      declared: personaPrefix,
      actual: prefixes[0],
    });
  }

  const ok = checks.every((check) => check.status === "match" || check.status === "undeclared");
  return { checks, ok, target, profiles };
}
