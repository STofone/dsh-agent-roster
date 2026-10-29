/**
 * 档案文档解析：YAML 为主、JSON 兼容，纯函数、不碰文件系统。
 *
 * 解析阶段只回答「这段文本能否变成一棵对象树」，语义校验交给 `validate.js`。
 * 所有失败都转成诊断对象，不做抛异常式的静默降级。
 *
 * @module dsh-agent-roster/parse
 */
import { parseAllDocuments } from "yaml";
import { MAX_DOCUMENT_BYTES } from "./format.js";

/** 造一条诊断。path 用点号 + 下标表达，例如 `members[2].model`。 */
export function diagnostic(severity, code, path, reason, file = "") {
  return { severity, code, path, reason, file };
}

/** 文本的字节数（按 UTF-8 计，而不是字符数）。 */
export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/** 由文件名猜格式；认不出的按 YAML 处理（YAML 是 JSON 的超集）。 */
export function formatOf(file) {
  return /\.json$/i.test(String(file ?? "")) ? "json" : "yaml";
}

/**
 * 解析一份档案 / 索引文档。
 *
 * @param {string} text 文档全文
 * @param {{ file?: string, format?: "yaml" | "json" }} [options]
 * @returns {{ ok: boolean, value: unknown, format: string, diagnostics: object[] }}
 */
export function parseDocumentText(text, options = {}) {
  const file = String(options.file ?? "");
  const format = options.format ?? formatOf(file);
  const diagnostics = [];

  const source = String(text ?? "");
  const bytes = byteLength(source);
  if (bytes > MAX_DOCUMENT_BYTES) {
    diagnostics.push(
      diagnostic(
        "error",
        "document-too-large",
        "",
        `文档 ${bytes} 字节，超过上限 ${MAX_DOCUMENT_BYTES} 字节`,
        file,
      ),
    );
    return { ok: false, value: undefined, format, diagnostics };
  }
  if (source.trim() === "") {
    diagnostics.push(diagnostic("error", "empty-document", "", "文档为空", file));
    return { ok: false, value: undefined, format, diagnostics };
  }

  if (format === "json") return parseJson(source, file);

  let documents;
  try {
    documents = parseAllDocuments(source, { uniqueKeys: true, prettyErrors: false });
  } catch (error) {
    diagnostics.push(diagnostic("error", "yaml-syntax", "", messageOf(error), file));
    return { ok: false, value: undefined, format, diagnostics };
  }

  const failed = documents.filter((doc) => doc.errors.length > 0);
  if (failed.length > 0) {
    for (const doc of failed) {
      for (const error of doc.errors) {
        diagnostics.push(
          diagnostic(
            "error",
            "yaml-syntax",
            linePath(error),
            String(error.message ?? "").split("\n")[0],
            file,
          ),
        );
      }
    }
    return { ok: false, value: undefined, format, diagnostics };
  }
  if (documents.length !== 1) {
    diagnostics.push(
      diagnostic(
        "error",
        "multi-document",
        "",
        `一份档案文件只允许一个 YAML 文档，实际 ${documents.length} 个`,
        file,
      ),
    );
    return { ok: false, value: undefined, format, diagnostics };
  }

  let value;
  try {
    value = documents[0].toJS({ maxAliasCount: 100 });
  } catch (error) {
    diagnostics.push(diagnostic("error", "yaml-value", "", messageOf(error), file));
    return { ok: false, value: undefined, format, diagnostics };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(
      diagnostic("error", "document-not-mapping", "", "文档顶层必须是映射（对象）", file),
    );
    return { ok: false, value: undefined, format, diagnostics };
  }
  return { ok: true, value, format, diagnostics };
}

function parseJson(source, file) {
  try {
    const value = JSON.parse(source);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        value: undefined,
        format: "json",
        diagnostics: [
          diagnostic("error", "document-not-mapping", "", "文档顶层必须是对象", file),
        ],
      };
    }
    return { ok: true, value, format: "json", diagnostics: [] };
  } catch (error) {
    return {
      ok: false,
      value: undefined,
      format: "json",
      diagnostics: [diagnostic("error", "json-syntax", "", messageOf(error), file)],
    };
  }
}

function messageOf(error) {
  return String(error?.message ?? error ?? "解析失败").split("\n")[0];
}

/** 把 yaml 的语法错误位置折成 `line:col` 形式的 path，便于定位。 */
function linePath(error) {
  const line = error?.linePos?.[0]?.line;
  const col = error?.linePos?.[0]?.col;
  return Number.isFinite(line) ? `line:${line}${Number.isFinite(col) ? `:${col}` : ""}` : "";
}
