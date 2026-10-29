#!/usr/bin/env node
/**
 * 命令行入口：给 CI 与本地预检用。
 *
 * 工具是给模型用的，CLI 是给人/CI 用的：同一套校验器，不需要启动宿主。
 * 退出码是契约：0 = 全部通过（警告不算失败），1 = 至少一处 error，2 = 用法错误。
 *
 * 用法：
 *   dsh-agent-roster validate [--dir rosters] [--known-policy <id>]... [--json]
 *   dsh-agent-roster list     [--dir rosters]
 */
import { readFileSync } from "node:fs";

import { resolveDirSpec } from "../lib/home.js";
import { scanRosterLibrary } from "../lib/registry.js";
import { renderRosterList } from "../lib/render.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const USAGE = `用法：
  dsh-agent-roster validate [选项]   校验一座档案库，有 error 时退出码为 1
  dsh-agent-roster list [选项]       列出档案与成员
  dsh-agent-roster --version         输出版本号

选项：
  --dir <path>              档案库目录，可重复；默认全局库 $DSH_HOME/agent-roster（~/.dsh/agent-roster）
  --known-policy <id>       部署已声明的 toolPolicy id，可重复；用于交叉校验
  --json                    以 JSON 输出（validate 与 list 都支持）
  --help                    显示本帮助
`;

/** 极简参数解析：这个 CLI 不值得引入依赖。 */
function parseArgs(argv) {
  const options = { command: null, dirs: [], knownPolicies: [], json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--version" || arg === "-v") options.command = "version";
    else if (arg === "--dir") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--dir 需要一个路径");
      options.dirs.push(value);
      index += 1;
    } else if (arg === "--known-policy") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--known-policy 需要一个 id");
      options.knownPolicies.push(value);
      index += 1;
    } else if (arg.startsWith("-")) throw new UsageError(`未知选项：${arg}`);
    else if (options.command === null) options.command = arg;
    else throw new UsageError(`多余参数：${arg}`);
  }
  return options;
}

class UsageError extends Error {}

/** 把诊断折成一行；让终端输出和工具输出口径一致。 */
function formatDiagnostic(item) {
  const where = [item.file, item.path].filter(Boolean).join(" · ");
  return `  ${item.severity.toUpperCase()} ${item.code}${where === "" ? "" : ` (${where})`}: ${item.reason}`;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help || options.command === null) {
    process.stdout.write(USAGE);
    return options.command === null && !options.help ? 2 : 0;
  }
  if (options.command === "version") {
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    return 0;
  }
  if (options.command !== "validate" && options.command !== "list") {
    process.stderr.write(`未知命令：${options.command}\n\n${USAGE}`);
    return 2;
  }

  const dirs = options.dirs.length > 0 ? options.dirs : [""];
  const knownToolPolicies = options.knownPolicies.length > 0 ? options.knownPolicies : null;
  const reports = dirs.map((dir) => {
    // 与插件同一条解析规则：留空 = 全局库，相对路径才相对当前目录。
    const rootDir = resolveDirSpec(dir, process.cwd());
    const scan = scanRosterLibrary({ rootDir, knownToolPolicies });
    return { dir, rootDir, scan };
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          plugin: pkg.name,
          version: pkg.version,
          reports: reports.map((report) => ({
            rootDir: report.rootDir,
            missing: report.scan.missing,
            stats: report.scan.stats,
            rosters: report.scan.rosters.map((roster) => ({ id: roster.id, file: roster.file })),
            diagnostics: report.scan.diagnostics,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const report of reports) {
      process.stdout.write(`${report.rootDir}\n`);
      if (options.command === "list") {
        process.stdout.write(`${renderRosterList(report.scan)}\n`);
      } else {
        const { stats } = report.scan;
        process.stdout.write(
          `  档案 ${stats.total}（通过 ${stats.ok}，失败 ${stats.failed}），成员 ${stats.members}，` +
            `诊断 ${stats.errors} error / ${stats.warnings} warn / ${stats.infos} info\n`,
        );
        for (const roster of report.scan.rosters) {
          process.stdout.write(`  OK   ${roster.id}  (${roster.file})  ${roster.members.length} 名成员\n`);
        }
        const diagnostics = report.scan.diagnostics;
        if (diagnostics.length > 0) {
          process.stdout.write("  诊断：\n");
          for (const item of diagnostics) process.stdout.write(`${formatDiagnostic(item)}\n`);
        }
      }
      process.stdout.write("\n");
    }
  }

  const hasError = reports.some((report) => report.scan.stats.errors > 0);
  return hasError ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
