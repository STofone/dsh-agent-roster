/**
 * 工具输出的「无损 JSON」清洗。
 *
 * DSH 运行时会把工具返回值再序列化一遍，并且要求**往返无损**：`undefined` 属性的键
 * 在 `JSON.stringify` 时会被丢掉，回来就对不上号，于是整次调用被判为
 * `value is not lossless JSON` 而失败。这个坑在一次真机验证里踩到过——工具本身没错，
 * 错在返回值里带着 `undefined`。
 *
 * 所以约定：**工具返回值里不允许出现 `undefined`**。缺失一律用 `null` 表达
 * （`null` 能被 JSON 如实往返），或者干脆不带这个键。
 *
 * @module dsh-agent-roster/json
 */

/**
 * 递归清洗：对象丢掉值为 `undefined` 的键，数组里的 `undefined` 变成 `null`。
 *
 * 只处理 JSON 能表达的结构（对象、数组、原始值）；遇到 `Date`/`Map` 之类不常见的值
 * 原样放行，它们的序列化责任不在本函数。
 *
 * @template T
 * @param {T} value
 * @returns {T} 结构相同、但可无损往返 JSON 的值
 */
export function lossless(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : lossless(item)));
  }
  if (value !== null && typeof value === "object") {
    // 保留原型会给 JSON 往返制造意外（比如 Date 会变成字符串），只按普通对象处理纯数据结构。
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return value;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = lossless(item);
    }
    return out;
  }
  return value;
}

/**
 * 校验一个值能否无损往返 JSON——测试与调试用。
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isLossless(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    return { ok: false, reason: `无法序列化：${error.message}` };
  }
  if (text === undefined) return { ok: false, reason: "顶层值不可序列化（undefined/function/symbol）" };
  const back = JSON.parse(text);
  try {
    assertDeepEqual(value, back);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/** 找第一处结构差异，报出路径，比整段 diff 更容易定位。 */
function assertDeepEqual(left, right, at = "$") {
  if (left === right) return;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") {
    throw new Error(`${at}: ${describe(left)} ≠ ${describe(right)}`);
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    const missing = leftKeys.filter((key) => !rightKeys.includes(key));
    throw new Error(`${at}: 键集合不同${missing.length > 0 ? `，丢掉了 ${missing.join(", ")}` : ""}`);
  }
  for (const key of leftKeys) {
    assertDeepEqual(left[key], right[key], Array.isArray(left) ? `${at}[${key}]` : `${at}.${key}`);
  }
}

function describe(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") return Array.isArray(value) ? "array" : "object";
  return JSON.stringify(value);
}
