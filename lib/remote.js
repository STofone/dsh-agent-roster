/**
 * 远程档案源（公共 registry）读取。
 *
 * 照 dsh-market 的做法抄了三件事，一样都不多：
 *
 * 1. **静态 JSON 优先**：registry 就是一份 JSON，由仓库的 Action 在合并 PR 后重建，
 *    客户端按 TTL 拉取（默认一小时一次，正好落在 GitHub 未认证 API 的 60 次/小时预算内）。
 * 2. **npm 包兜底**：同一份 JSON 可以发布成 npm 包（`dsh-agent-roster-catalog`），
 *    走镜像下载 tarball 再解出 `package/registry.json`——这是 dsh-market 解决
 *    “GitHub Pages 被代理拦” 的办法，我们原样保留，只是默认不启用（还没发布）。
 * 3. **失败时用缓存**：网络挂了不代表面板不能看，旧缓存照用，但必须标 `stale` 并给出原因，
 *    绝不把“没拉到”伪装成“没有档案”。
 *
 * 与 dsh-market 的差异只有一处：它每次都现拉（catalog 是它的主路径），
 * 我们把 TTL 与缓存放在前面——因为我们的 registry 不是安装依赖，晚一小时知道新档案没有代价。
 *
 * 这一层**只读**：不装插件、不写档案库，拿到的档案带 `origin` 标记后交给上层展示。
 *
 * @module dsh-agent-roster/remote
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { gunzipSync } from "node:zlib";

import {
  COLLECTION_FIELDS,
  LIMITS,
  PATTERNS,
  REGISTRY_FIELDS,
  REGISTRY_KIND,
  ROSTER_KIND,
} from "./format.js";
import { parseDocumentText } from "./parse.js";
import { validateRoster } from "./validate.js";

/** 默认 TTL：一小时。用户说“60 次/小时更新就行”，这里就是那个预算。 */
export const REGISTRY_TTL_MS = 60 * 60 * 1000;

/** 实测发现的最短刷新间隔：`--refresh` 也绕不过它，避免页面狂刷把配额烧光。 */
export const MIN_REFRESH_MS = 60 * 1000;

/** 官方 registry 地址（本仓库的 `index/registry.json`，合并 PR 即更新）。 */
export const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/STofone/dsh-agent-roster/main/index/registry.json";

/** 缓存目录名，放在档案库根下，跟着 `$DSH_HOME` 走。 */
export const CACHE_DIR_NAME = ".index-cache";

/** entry 文件所在的仓库前缀（只支持 GitHub raw，不引入 git 协议）。 */
export const GITHUB_RAW = "https://raw.githubusercontent.com";

/** 各下载区使用的 npm registry（与 dsh-market 的两个区一致，只是不做自动探测）。 */
export const NPM_REGISTRIES = {
  global: "https://registry.npmjs.org",
  china: "https://mirrors.cloud.tencent.com/npm",
};

/** 网络单次请求的预算：够了，慢就换下一个源。 */
const TIMEOUT_MS = 15_000;

/** 一次报告用的小工具：与校验器同形状的诊断。 */
function diagnostic(severity, code, reason, file = "") {
  return { severity, code, reason, file, path: "" };
}

/**
 * 把配置里的 `indexes` 归一成源描述。
 *
 * 接受三种写法：
 * - `"url"`：任意 HTTPS 的 registry JSON；
 * - `"npm:pkg[@version]"`：从 npm 包取 `registry.json`；
 * - `{kind, url|pkg, ttlMs, id}`：显式对象。
 *
 * 空数组 = 只用官方源（用户不必为了“能用”先抄一条 URL）；传 `false` 只在本机库工作。
 *
 * @param {unknown} value `config.indexes`
 * @returns {{ sources: object[], diagnostics: object[] }}
 */
export function normalizeIndexSources(value) {
  const diagnostics = [];
  // 空数组沿用官方源：设置里的默认值就是 `[]`，如果它表示“没有源”，面板一装上就是空的。
  // 真要关掉远端源，显式写 `false`。
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  const raw = empty ? [DEFAULT_REGISTRY_URL] : value === false ? [] : Array.isArray(value) ? value : [value];
  const sources = [];
  const seen = new Set();

  for (const item of raw) {
    const parsed = parseSourceSpec(item);
    if (parsed.error !== undefined) {
      diagnostics.push(diagnostic("warn", "index-source-invalid", parsed.error));
      continue;
    }
    const id = parsed.id ?? sourceId(parsed);
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({ ...parsed, id });
  }

  return { sources, diagnostics };
}

/** 单条源描述解析。 */
function parseSourceSpec(item) {
  if (item === false) return { error: "false 之外的写法才表示启用源" };
  if (typeof item === "string") {
    const text = item.trim();
    if (text === "") return { error: "空字符串不是合法的源" };
    if (text.startsWith("npm:")) return npmSpec(text.slice(4));
    if (/^https:\/\/\S+$/i.test(text)) return { kind: "url", url: text, ttlMs: REGISTRY_TTL_MS };
    return { error: `无法识别的源写法：${text}` };
  }
  if (typeof item === "object" && item !== null) {
    const ttlMs = Number.isFinite(item.ttlMs) && item.ttlMs >= MIN_REFRESH_MS ? item.ttlMs : REGISTRY_TTL_MS;
    if (item.kind === "npm" || typeof item.pkg === "string") {
      const spec = npmSpec(`${item.pkg}${item.version ? `@${item.version}` : ""}`, item);
      if (spec.error !== undefined) return spec;
      return { ...spec, ttlMs, id: typeof item.id === "string" ? item.id : undefined };
    }
    if (typeof item.url === "string" && /^https:\/\/\S+$/i.test(item.url.trim())) {
      return {
        kind: "url",
        url: item.url.trim(),
        ttlMs,
        id: typeof item.id === "string" ? item.id : undefined,
      };
    }
    return { error: "对象形式的源必须有 url 或 pkg" };
  }
  return { error: `无法识别的源写法：${String(item)}` };
}

/** `pkg[@version]` 解析（scoped 包名里的 `@` 不算版本分隔符）。 */
function npmSpec(text, extra = {}) {
  const at = text.lastIndexOf("@");
  const hasVersion = at > 0;
  const pkg = hasVersion ? text.slice(0, at) : text;
  const version = hasVersion ? text.slice(at + 1) : undefined;
  if (!PATTERNS.npmName.test(pkg)) return { error: `不是合法的 npm 包名：${pkg}` };
  return {
    kind: "npm",
    pkg,
    version,
    registry: typeof extra.registry === "string" && extra.registry !== "" ? extra.registry.replace(/\/+$/, "") : undefined,
    file: "package/registry.json",
  };
}

/** 稳定的源 id：同一 URL/包永远得到同一个缓存文件名。 */
export function sourceId(source) {
  const key = source.kind === "npm" ? `npm:${source.registry ?? ""}${source.pkg}` : `url:${source.url}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** 源的展示标签。 */
export function sourceLabel(source) {
  if (source.kind === "npm") return `npm:${source.pkg}`;
  try {
    const url = new URL(source.url);
    return `${url.host}${url.pathname}`;
  } catch {
    return String(source.url);
  }
}

/**
 * 读一个源：命中缓存就返回缓存，过期则带 ETag 条件请求，失败退回旧缓存。
 *
 * @param {object} source `normalizeIndexSources` 的产物
 * @param {object} [options]
 * @param {string} [options.cacheDir] 缓存目录（默认不缓存：便于纯函数测试）
 * @param {() => Date} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.refresh] 忽略 TTL（但仍受 {@link MIN_REFRESH_MS} 约束）
 * @param {number} [options.region] 选择 npm registry
 * @returns {Promise<object>} `{ source, ok, stale, fetchedAt, document, diagnostics, collections }`
 */
export async function loadRegistry(source, options = {}) {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cachePath = options.cacheDir === undefined ? null : cachePathFor(options.cacheDir, source.id);
  const cached = cachePath === null ? null : readCache(cachePath);
  const current = now().getTime();
  const ttlMs = Number.isFinite(source.ttlMs) ? source.ttlMs : REGISTRY_TTL_MS;
  const age = cached === null ? Number.POSITIVE_INFINITY : current - cached.fetchedAt;

  if (cached !== null && !options.refresh && age < ttlMs) {
    return buildResult(source, cached.document, {
      ok: true,
      stale: false,
      fetchedAt: cached.fetchedAt,
      diagnostics: [],
    });
  }
  if (cached !== null && options.refresh && age < MIN_REFRESH_MS) {
    return buildResult(source, cached.document, {
      ok: true,
      stale: false,
      fetchedAt: cached.fetchedAt,
      diagnostics: [diagnostic("info", "index-refresh-throttled", `距上次刷新不足 ${MIN_REFRESH_MS / 1000}s，先用缓存`)],
    });
  }

  try {
    const fetched = await fetchRegistry(source, { fetchImpl, etag: cached?.etag, version: cached?.version, region: options.region });
    if (fetched.status === "not-modified" && cached !== null) {
      writeCache(cachePath, { ...cached, fetchedAt: current });
      return buildResult(source, cached.document, { ok: true, stale: false, fetchedAt: current, diagnostics: [] });
    }
    const checked = validateRegistry(fetched.document, { file: fetched.file });
    if (!checked.ok) {
      if (cached !== null) {
        return buildResult(source, cached.document, {
          ok: true,
          stale: true,
          fetchedAt: cached.fetchedAt,
          diagnostics: [
            diagnostic("warn", "index-invalid", `${sourceLabel(source)} 的内容不合法，沿用上次缓存`, fetched.file),
            ...checked.diagnostics,
          ],
        });
      }
      return buildResult(source, null, {
        ok: false,
        stale: false,
        fetchedAt: null,
        diagnostics: [diagnostic("error", "index-invalid", `${sourceLabel(source)} 的内容不合法`, fetched.file), ...checked.diagnostics],
      });
    }
    writeCache(cachePath, {
      sourceId: source.id,
      fetchedAt: current,
      etag: fetched.etag,
      version: fetched.version,
      document: fetched.document,
    });
    return buildResult(source, fetched.document, { ok: true, stale: false, fetchedAt: current, diagnostics: [] });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cached !== null) {
      return buildResult(source, cached.document, {
        ok: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
        diagnostics: [diagnostic("warn", "index-unreachable", `${sourceLabel(source)} 拉取失败，沿用上次缓存：${reason}`)],
      });
    }
    return buildResult(source, null, {
      ok: false,
      stale: false,
      fetchedAt: null,
      diagnostics: [diagnostic("warn", "index-unreachable", `${sourceLabel(source)} 拉取失败：${reason}`)],
    });
  }
}

/** 校验通过后把文档包装成统一结果。 */
function buildResult(source, document, meta) {
  const collections = document === null ? [] : document.collections;
  return {
    source,
    label: sourceLabel(source),
    ok: meta.ok,
    stale: meta.stale,
    fetchedAt: meta.fetchedAt === null ? null : new Date(meta.fetchedAt).toISOString(),
    document,
    collections,
    diagnostics: meta.diagnostics,
  };
}

/**
 * 拉取一份 registry 文档。
 *
 * @returns {Promise<{status: "ok"|"not-modified", document?: unknown, etag?: string, version?: string, file: string}>}
 */
async function fetchRegistry(source, options) {
  if (source.kind === "npm") {
    const registry = source.registry ?? NPM_REGISTRIES[options.region === "china" ? "china" : "global"];
    return fetchFromPackage(source, { ...options, registry });
  }

  const headers = { accept: "application/json", "user-agent": userAgent() };
  if (typeof options.etag === "string" && options.etag !== "") headers["if-none-match"] = options.etag;
  const response = await options.fetchImpl(source.url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 304) return { status: "not-modified", file: source.url };
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`.trim());
  const text = await response.text();
  return {
    status: "ok",
    document: JSON.parse(text),
    etag: response.headers.get("etag") ?? undefined,
    file: source.url,
  };
}

/**
 * 从 npm 包取 registry：packument → tarball → 解出 `package/registry.json`。
 *
 * 版本号当缓存校验器：与已知版本相同就不再下载 tarball（dsh-market 同款做法，
 * 比 ETag 更好读，也更容易在日志里对上“哪一版目录”）。
 */
async function fetchFromPackage(source, options) {
  const registry = options.registry.replace(/\/+$/, "");
  const metaUrl = `${registry}/${encodeURIComponent(source.pkg).replace(/%40/g, "@").replace(/%2F/g, "/")}/latest`;
  const metaResponse = await options.fetchImpl(metaUrl, {
    headers: { accept: "application/json", "user-agent": userAgent() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!metaResponse.ok) throw new Error(`HTTP ${String(metaResponse.status)} reading ${source.pkg} metadata`);
  const meta = await metaResponse.json();
  const version = typeof meta?.version === "string" ? meta.version : "";
  const tarball = typeof meta?.dist?.tarball === "string" ? meta.dist.tarball : "";
  if (tarball === "") throw new Error(`${source.pkg} 的 packument 里没有 dist.tarball`);
  if (version !== "" && version === options.version) return { status: "not-modified", version, file: `${source.pkg}@${version}` };

  const tarballResponse = await options.fetchImpl(tarball, {
    headers: { accept: "application/octet-stream", "user-agent": userAgent() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!tarballResponse.ok) throw new Error(`HTTP ${String(tarballResponse.status)} downloading ${source.pkg}@${version}`);
  const gz = Buffer.from(await tarballResponse.arrayBuffer());
  const wanted = source.file ?? "package/registry.json";
  const bytes = fileFromTarball(gz, wanted);
  if (bytes === null) throw new Error(`${source.pkg}@${version} 里没有 ${wanted}`);
  return {
    status: "ok",
    document: JSON.parse(bytes.toString("utf8")),
    version,
    file: `${source.pkg}@${version}:${wanted}`,
  };
}

/** tar 头：512 字节一块，名字在 0，八进制大小在 124，类型在 156。 */
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPE_OFFSET = 156;
const BLOCK = 512;

/**
 * 从 gzipped tar 里取出一个文件。
 *
 * 手写而不引依赖：只认一个固定文件名，代码比“为什么又多一个 runtime 依赖”的说明还短。
 *
 * @param {Buffer} gz 压缩后的 tarball
 * @param {string} wanted 完整条目名（npm 风格：`package/registry.json`）
 * @returns {Buffer | null}
 */
export function fileFromTarball(gz, wanted) {
  const buffer = gunzipSync(gz);
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const name = buffer.toString("utf8", offset + NAME_OFFSET, offset + NAME_OFFSET + NAME_LENGTH).replace(/\0.*$/s, "");
    if (name === "") break;
    const rawSize = buffer
      .toString("ascii", offset + SIZE_OFFSET, offset + SIZE_OFFSET + SIZE_LENGTH)
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(rawSize, 8);
    if (!Number.isFinite(size) || size < 0) break;
    const type = String.fromCharCode(buffer[offset + TYPE_OFFSET] ?? 0);
    offset += BLOCK;
    if ((type === "0" || type === "\0") && name === wanted) {
      return buffer.subarray(offset, offset + size);
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return null;
}

/**
 * 校验 registry 文档：外部输入，全部字段从严，不认识就拒。
 *
 * @param {unknown} value 解析后的 JSON
 * @param {{ file?: string }} [meta]
 * @returns {{ ok: boolean, registry: object | null, diagnostics: object[] }}
 */
export function validateRegistry(value, meta = {}) {
  const file = meta.file ?? "";
  const diagnostics = [];
  const fail = (code, reason) => {
    diagnostics.push(diagnostic("error", code, reason, file));
    return { ok: false, registry: null, diagnostics };
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("registry-not-object", "registry 必须是对象");
  if (value.kind !== REGISTRY_KIND) return fail("registry-kind", `kind 必须是 "${REGISTRY_KIND}"，实际是 ${JSON.stringify(value.kind)}`);

  for (const key of Object.keys(value)) {
    if (!REGISTRY_FIELDS.includes(key)) diagnostics.push(diagnostic("warn", "registry-unknown-key", `registry 有未知字段 "${key}"`, file));
  }

  if (!Array.isArray(value.collections)) return fail("registry-collections", "collections 必须是数组");
  if (value.collections.length > LIMITS.collections) {
    return fail("registry-too-many-collections", `collections 最多 ${LIMITS.collections} 条，实际 ${value.collections.length}`);
  }

  const collections = [];
  const seen = new Set();
  value.collections.forEach((entry, index) => {
    const where = `collections[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      diagnostics.push(diagnostic("error", "collection-shape", `${where} 必须是对象`, file));
      return;
    }
    let bad = false;
    for (const key of Object.keys(entry)) {
      if (!COLLECTION_FIELDS.includes(key)) {
        diagnostics.push(diagnostic("warn", "collection-unknown-key", `${where} 有未知字段 "${key}"`, file));
      }
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!PATTERNS.id.test(id)) {
      diagnostics.push(diagnostic("error", "collection-id", `${where}.id 必须是 kebab-case`, file));
      bad = true;
    } else if (seen.has(id)) {
      diagnostics.push(diagnostic("error", "collection-id-duplicate", `${where}.id 与前面的重复：${id}`, file));
      bad = true;
    }
    const repo = typeof entry.repo === "string" ? entry.repo.trim() : "";
    if (!PATTERNS.repo.test(repo)) {
      diagnostics.push(diagnostic("error", "collection-repo", `${where}.repo 必须形如 github:owner/repo`, file));
      bad = true;
    }
    const ref = entry.ref === undefined ? "main" : String(entry.ref);
    if (!PATTERNS.ref.test(ref)) {
      diagnostics.push(diagnostic("error", "collection-ref", `${where}.ref 不是合法的 git ref`, file));
      bad = true;
    }
    const path = entry.path === undefined ? "rosters" : String(entry.path);
    if (!PATTERNS.relPath.test(path)) {
      diagnostics.push(diagnostic("error", "collection-path", `${where}.path 必须是仓库内相对目录`, file));
      bad = true;
    }

    const rosters = [];
    const rawRosters = Array.isArray(entry.rosters) ? entry.rosters : [];
    if (rawRosters.length > LIMITS.rostersPerCollection) {
      diagnostics.push(diagnostic("warn", "collection-rosters-many", `${where}.rosters 超过 ${LIMITS.rostersPerCollection} 份，只取前若干份`, file));
    }
    for (const item of rawRosters.slice(0, LIMITS.rostersPerCollection)) {
      const rosterId = typeof item === "string" ? item : typeof item?.id === "string" ? item.id : "";
      if (!PATTERNS.id.test(rosterId)) {
        diagnostics.push(diagnostic("warn", "collection-roster-id", `${where}.rosters 里有不合法的档案 id：${JSON.stringify(item)}`, file));
        continue;
      }
      if (!rosters.includes(rosterId)) rosters.push(rosterId);
    }
    if (bad) return;

    seen.add(id);
    collections.push({
      id,
      title: typeof entry.title === "string" ? entry.title.trim() : id,
      description: typeof entry.description === "string" ? entry.description.trim() : "",
      repo,
      ref,
      path: path.replace(/^\/+|\/+$/g, ""),
      rosters,
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [],
      license: typeof entry.license === "string" ? entry.license : "",
      maintainers: Array.isArray(entry.maintainers) ? entry.maintainers.filter((item) => typeof item === "string") : [],
      homepage: typeof entry.homepage === "string" ? entry.homepage : "",
    });
  });

  const ok = diagnostics.every((item) => item.severity !== "error") && collections.length > 0;
  return { ok, registry: ok ? { kind: value.kind, collections } : null, diagnostics };
}

/**
 * 把一个 collection 里的档案逐份拉下来并校验。
 *
 * 只读：不落盘到档案库，返回带 `origin` 的档案对象，上层决定怎么展示。
 *
 * @param {object} collection `validateRegistry` 产物里的一条
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(id: string) => boolean} [options.only] 只要这几份（面板按需拉取时用）
 * @returns {Promise<{ collection: object, rosters: object[], diagnostics: object[] }>}
 */
export async function fetchCollection(collection, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wanted = collection.rosters.filter((id) => options.only === undefined || options.only(id));
  const rosters = [];
  const diagnostics = [];

  for (const rosterId of wanted) {
    let loaded = null;
    let lastError = "";
    for (const fileName of ["roster.yaml", "roster.yml", "roster.json"]) {
      const url = collectionFileUrl(collection, rosterId, fileName);
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) {
          lastError = `HTTP ${String(response.status)}`;
          continue;
        }
        loaded = { url, fileName, text: await response.text() };
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (loaded === null) {
      diagnostics.push(diagnostic("warn", "collection-fetch-failed", `${collection.id}/${rosterId} 拉取失败：${lastError || "未知原因"}`));
      continue;
    }
    const parsed = parseDocumentText(loaded.text, { file: loaded.url });
    const checked = parsed.ok
      ? validateRoster(parsed.value, { file: loaded.url, expectedId: rosterId })
      : { ok: false, diagnostics: parsed.diagnostics };
    if (!checked.ok) {
      diagnostics.push(...checked.diagnostics);
      continue;
    }
    rosters.push({
      ...checked.roster,
      origin: {
        kind: "remote",
        collection: collection.id,
        title: collection.title,
        repo: collection.repo,
        ref: collection.ref,
        path: collection.path,
        url: loaded.url,
      },
    });
  }

  return { collection, rosters, diagnostics };
}

/** 拼一份档案的 raw 地址。 */
export function collectionFileUrl(collection, rosterId, fileName) {
  const repo = collection.repo.replace(/^github:/, "");
  return `${GITHUB_RAW}/${repo}/${encodeURIComponent(collection.ref)}/${collection.path}/${rosterId}/${fileName}`;
}

/** 一次读多个源（串行：GitHub 未认证配额经不起并发烧）。 */
export async function loadRegistryIndex(config, options = {}) {
  const { sources, diagnostics } = normalizeIndexSources(config?.indexes);
  const indexes = [];
  const collections = [];
  const problems = [...diagnostics];

  for (const source of sources) {
    const loaded = await loadRegistry(source, {
      ...options,
      region: options.region ?? (config?.region === "china" ? "china" : "global"),
    });
    indexes.push({
      id: source.id,
      label: loaded.label,
      kind: source.kind,
      ok: loaded.ok,
      stale: loaded.stale,
      fetchedAt: loaded.fetchedAt,
      ttlMs: source.ttlMs ?? REGISTRY_TTL_MS,
      collections: loaded.collections.length,
    });
    problems.push(...loaded.diagnostics);
    for (const collection of loaded.collections) {
      collections.push({ ...collection, origin: { kind: "registry", source: source.id, label: loaded.label, stale: loaded.stale } });
    }
  }

  return { indexes, collections, diagnostics: problems };
}

/**
 * 缓存目录里的文件名。
 *
 * 目录跟着档案库根走（`$DSH_HOME/agent-roster/.index-cache`），所以它和档案库同生命周期。
 */
export function cachePathFor(cacheDir, id) {
  return nodePath.join(cacheDir, `${id}.json`);
}

/** 读缓存；坏了就当没有（不因为一个坏文件让整个源不可用）。 */
function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed?.fetchedAt !== "number" || typeof parsed?.document !== "object" || parsed.document === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 原子写缓存：先写临时文件再改名，避免半截 JSON。 */
function writeCache(file, payload) {
  if (file === null) return;
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload));
  fs.renameSync(temp, file);
}

/** 请求头里的自我标识：GitHub 要求有 UA。 */
function userAgent() {
  return "dsh-agent-roster/registry";
}

/** 供测试与 CLI 使用：解析一份本地 registry 文件。 */
export function readRegistryFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(text);
  return validateRegistry(parsed, { file });
}

/** 一份 registry 里所有 collection 的档案总数（面板摘要用）。 */
export function countRegistryRosters(collections) {
  return collections.reduce((total, collection) => total + collection.rosters.length, 0);
}

/** 供 CLI 造索引时校验档案形态（复用同一套 pattern，不另写一份）。 */
export function isRegistryRoster(value) {
  return typeof value === "object" && value !== null && value.kind === ROSTER_KIND;
}
