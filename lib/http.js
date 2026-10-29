/**
 * 路由层的小工具：认证闸门、方法校验、有界 JSON 体、统一响应。
 *
 * 面板的写操作（保存/删除/导入档案）走 HTTP，所以这一层是安全边界：
 * 每个写请求先过宿主的 connection.requestRejection（Host/Origin 围栏 + 浏览器登录凭据），
 * 再校验方法与媒体类型，再限制正文大小。任何一步失败都直接返回，不进入业务代码。
 *
 * @module dsh-agent-roster/http
 */

/** 写请求正文上限：一份档案含 32 个成员的人设在 256 KiB 内足够，超过视为异常。 */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * 发送 JSON 响应。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * 发送错误响应：机器可读的 code + 可选诊断数组。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {object[]} [diagnostics]
 * @returns {void}
 */
export function sendError(res, status, code, diagnostics = []) {
  sendJson(res, status, { ok: false, error: { code }, diagnostics });
}

/**
 * 405，并如实声明本路由支持的方法。
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} allow
 * @returns {void}
 */
export function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader("allow", allow);
  res.end();
}

/**
 * 造一个认证闸门：返回 true 表示请求已被拒绝并写完响应。
 *
 * connection 缺失（极简组合没有装 connection）时放行——此时 webServer 本身已经只监听
 * 本机回环地址，写操作仍有方法/路径/大小/校验四道闸。
 *
 * @param {object} ctx 宿主上下文
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => boolean}
 */
export function createAuthGate(ctx) {
  const connection = Reflect.get(ctx, "connection");
  return (req, res) => {
    if (connection === undefined || typeof connection.requestRejection !== "function") return false;
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
}

/**
 * 读取有界 JSON 正文。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, code: string }>}
 */
export async function readJsonBody(req) {
  const mediaType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false, status: 415, code: "unsupported-media-type" };

  const declared = Number(req.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    return { ok: false, status: 413, code: "body-too-large" };
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      return { ok: false, status: 413, code: "body-too-large" };
    }
    chunks.push(chunk);
  }
  if (total === 0) return { ok: false, status: 400, code: "empty-body" };

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, code: "invalid-json" };
  }
}

/**
 * 断言请求方法，否则写 405 并返回 false。
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} method
 * @returns {boolean}
 */
export function requireMethod(req, res, method) {
  if (req.method === method) return true;
  sendMethodNotAllowed(res, method);
  return false;
}
