#!/usr/bin/env node
/**
 * install.mjs —— keyword-router 安装器（真正的安装逻辑在这里）
 *
 * 1. 把插件文件复制到 %USERPROFILE%\.openclaw\keyword-router
 * 2. 调用 apply-config.mjs 注册进 openclaw.json（自动备份）
 * 3. 首次安装才复制 routes.json，升级不会覆盖你的规则
 * 4. 可选重启网关
 *
 * 用法：
 *   node install.mjs                    安装/升级
 *   node install.mjs --restart          安装后重启网关
 *   node install.mjs --remove --restart 卸载配置并重启
 *   node install.mjs --dry-run          只看会做什么
 *
 * 参数：--target-dir <目录>  --skip-config  --remove  --restart  --dry-run
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILES_TO_COPY = ["index.js", "openclaw.plugin.json", "package.json"];

function parseArgs(argv) {
  const args = { dryRun: false, remove: false, restart: false, skipConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run" || token === "-n") args.dryRun = true;
    else if (token === "--remove" || token === "--uninstall") args.remove = true;
    else if (token === "--restart") args.restart = true;
    else if (token === "--skip-config") args.skipConfig = true;
    else if (token === "--target-dir") args.targetDir = argv[++i];
    else if (token === "--help" || token === "-h") args.help = true;
    else {
      console.error(`未知参数：${token}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      "install.mjs —— 安装 keyword-router",
      "",
      "  node install.mjs                    安装/升级",
      "  node install.mjs --restart          安装后重启网关",
      "  node install.mjs --remove --restart 卸载配置并重启网关",
      "  node install.mjs --dry-run          只看会做什么",
      "",
      "参数：--target-dir <目录>  --skip-config  --remove  --restart  --dry-run",
    ].join("\n"),
  );
  process.exit(0);
}

const home = os.homedir();
const openclawHome = path.join(home, ".openclaw");
const targetDir = path.resolve(args.targetDir ?? path.join(openclawHome, "keyword-router"));
const configPath = path.join(openclawHome, "openclaw.json");

const line = (text = "") => console.log(text);
const ok = (text) => console.log(`  ✅ ${text}`);
const warn = (text) => console.log(`  ⚠️  ${text}`);

line("=== keyword-router 安装 ===");
line(`源目录  : ${SOURCE_DIR}`);
line(`目标目录: ${targetDir}`);
line(`Node    : ${process.execPath}`);
line("");

// ---------------------------------------------------------------------------
// 1. 复制文件
// ---------------------------------------------------------------------------
if (args.remove) {
  line("[1/3] 卸载模式：不复制文件");
} else if (args.dryRun) {
  line("[1/3] 将复制：" + FILES_TO_COPY.join("、") + "（routes.json 仅在不存在时复制）");
} else {
  line("[1/3] 复制插件文件");
  for (const name of FILES_TO_COPY) {
    const from = path.join(SOURCE_DIR, name);
    if (!fs.existsSync(from)) {
      console.error(`  ❌ 缺少插件文件：${from}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of FILES_TO_COPY) {
    fs.copyFileSync(path.join(SOURCE_DIR, name), path.join(targetDir, name));
    ok(`${name}`);
  }

  const routesFrom = path.join(SOURCE_DIR, "routes.json");
  const routesTo = path.join(targetDir, "routes.json");
  if (fs.existsSync(routesTo)) {
    line("  ↷ 保留已有 routes.json（不覆盖你的规则）");
  } else if (fs.existsSync(routesFrom)) {
    fs.copyFileSync(routesFrom, routesTo);
    ok("routes.json（首次安装）");
  } else {
    warn("源目录没有 routes.json，装好后需要自己建一个");
  }
}

// ---------------------------------------------------------------------------
// 2. 改 openclaw.json
// ---------------------------------------------------------------------------
line("");
if (args.skipConfig) {
  line("[2/3] 跳过 openclaw.json（--skip-config）");
} else {
  line("[2/3] 注册到 openclaw.json");
  const applyScript = path.join(SOURCE_DIR, "apply-config.mjs");
  if (!fs.existsSync(applyScript)) {
    console.error(`  ❌ 缺少 ${applyScript}`);
    process.exit(1);
  }
  const applyArgs = [applyScript, "--config", configPath, "--plugin-dir", targetDir];
  if (args.remove) applyArgs.push("--remove");
  if (args.dryRun) applyArgs.push("--dry-run");

  const result = spawnSync(process.execPath, applyArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`  ❌ apply-config.mjs 执行失败（退出码 ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// 3. 可选重启
// ---------------------------------------------------------------------------
line("");
line("[3/3] 网关");
if (!args.restart) {
  line("  未重启。配置改动需要重启网关后才生效：");
  line("    openclaw gateway restart");
  line("  （或重启 Windows 计划任务 “OpenClaw Gateway”）");
} else {
  const cli = findOpenClawCli();
  if (!cli) {
    warn("找不到 openclaw 命令，请手动重启网关：openclaw gateway restart");
  } else if (args.dryRun) {
    line(`  将执行：${cli.display} gateway restart`);
  } else {
    line(`  重启中：${cli.display} gateway restart`);
    const result = spawnSync(cli.file, [...cli.prefixArgs, "gateway", "restart"], { stdio: "inherit" });
    if (result.status !== 0) {
      warn(`重启命令退出码 ${result.status}，请手动重启网关`);
    }
  }
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
line("");
if (args.remove) {
  line("已从配置中移除。重启网关后彻底生效，插件目录可以自行删除：");
  line(`  ${targetDir}`);
} else {
  line("安装完成。接下来：");
  line("  1) 重启网关：openclaw gateway restart");
  line("  2) 确认插件加载：openclaw plugins inspect keyword-router --runtime");
  line("  3) 本机先自测（不经过微信）：");
  line(`       "${process.execPath}" "${path.join(targetDir, "index.js")}" --self-test`);
  line("  4) 微信里发：我需要知道我的ip地址");
  line("");
  line(`运行日志：${path.join(targetDir, "keyword-router.log")}`);
  line(`规则文件：${path.join(targetDir, "routes.json")}（改完保存即生效，不用重启）`);
}

// ---------------------------------------------------------------------------

function findOpenClawCli() {
  // 1) PATH 里的 openclaw.cmd / openclaw
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    for (const name of ["openclaw.cmd", "openclaw.exe", "openclaw"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { file: candidate, prefixArgs: [], display: candidate };
      }
    }
  }

  // 2) 常见全局安装位置
  const fallbackBins = [
    "D:\\node\\node_global\\openclaw.cmd",
    path.join(process.env.APPDATA || "", "npm", "openclaw.cmd"),
    path.join(process.env.LOCALAPPDATA || "", "pnpm", "openclaw.cmd"),
  ];
  for (const candidate of fallbackBins) {
    if (candidate && fs.existsSync(candidate)) {
      return { file: candidate, prefixArgs: [], display: candidate };
    }
  }

  // 3) 直接调用 openclaw 的 dist 入口
  const distEntries = [
    path.join(path.dirname(process.execPath), "node_global", "node_modules", "openclaw", "dist", "index.js"),
    "D:\\node\\node_global\\node_modules\\openclaw\\dist\\index.js",
  ];
  for (const candidate of distEntries) {
    if (fs.existsSync(candidate)) {
      return {
        file: process.execPath,
        prefixArgs: [candidate],
        display: `${process.execPath} ${candidate}`,
      };
    }
  }

  return null;
}
