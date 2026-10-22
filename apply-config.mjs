#!/usr/bin/env node
/**
 * apply-config.mjs —— 把 keyword-router 写进 openclaw.json（会自动备份）
 *
 * 做三件事：
 *   1. plugins.load.paths 里加入插件目录
 *   2. plugins.entries["keyword-router"].enabled = true
 *   3. plugins.entries["keyword-router"].hooks.allowConversationAccess = true
 *      （外部插件要读对话内容，必须显式打开这个开关，否则钩子会被静默拦截）
 *
 * 用法：
 *   node apply-config.mjs                     安装/更新到默认位置
 *   node apply-config.mjs --dry-run           只看会改什么，不写文件
 *   node apply-config.mjs --remove            卸载这些配置
 *   node apply-config.mjs --config <路径>      指定 openclaw.json
 *   node apply-config.mjs --plugin-dir <路径>  指定插件目录
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ID = "keyword-router";

function parseArgs(argv) {
  const args = { dryRun: false, remove: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run" || token === "-n") args.dryRun = true;
    else if (token === "--remove" || token === "--uninstall") args.remove = true;
    else if (token === "--config") args.config = argv[++i];
    else if (token === "--plugin-dir") args.pluginDir = argv[++i];
    else if (token === "--id") args.id = argv[++i];
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) {
      console.error(`未知参数：${token}`);
      process.exit(2);
    }
  }
  return args;
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    [
      "apply-config.mjs —— 把 keyword-router 注册进 openclaw.json",
      "",
      "  node apply-config.mjs                安装/更新",
      "  node apply-config.mjs --dry-run      只预览",
      "  node apply-config.mjs --remove       卸载配置",
      "",
      "可选：--config <openclaw.json 路径>  --plugin-dir <插件目录>  --id <插件 id>",
    ].join("\n"),
  );
  process.exit(0);
}

const home = os.homedir();
const openclawHome = path.join(home, ".openclaw");
const configPath = path.resolve(args.config ?? path.join(openclawHome, "openclaw.json"));
const pluginDir = path.resolve(args.pluginDir ?? path.join(openclawHome, PLUGIN_ID));
const pluginId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : PLUGIN_ID;

if (!fs.existsSync(configPath)) {
  console.error(`❌ 找不到 openclaw 配置：${configPath}`);
  console.error("   请确认 openclaw 已经初始化过（openclaw doctor），或用 --config 指定路径。");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
  console.error(`❌ 配置不是合法 JSON，已中止，未做任何修改：${err?.message || err}`);
  process.exit(1);
}

const changes = [];
const warnings = [];

if (!isPlainObject(config.plugins)) config.plugins = {};
const plugins = config.plugins;

if (args.remove) {
  // ---- 卸载 ----
  if (isPlainObject(plugins.load) && Array.isArray(plugins.load.paths)) {
    const before = plugins.load.paths.length;
    plugins.load.paths = plugins.load.paths.filter((entry) => {
      if (typeof entry !== "string") return true;
      return path.resolve(entry).toLowerCase() !== pluginDir.toLowerCase();
    });
    if (plugins.load.paths.length !== before) {
      changes.push(`plugins.load.paths 移除 ${pluginDir}`);
    }
    if (plugins.load.paths.length === 0) delete plugins.load.paths;
    if (Object.keys(plugins.load).length === 0) delete plugins.load;
  }
  if (isPlainObject(plugins.entries) && pluginId in plugins.entries) {
    delete plugins.entries[pluginId];
    changes.push(`plugins.entries 移除 ${pluginId}`);
    if (Object.keys(plugins.entries).length === 0) delete plugins.entries;
  }
  if (Array.isArray(plugins.allow)) {
    const before = plugins.allow.length;
    plugins.allow = plugins.allow.filter((entry) => entry !== pluginId);
    if (plugins.allow.length !== before) changes.push(`plugins.allow 移除 ${pluginId}`);
  }
} else {
  // ---- 安装 ----
  plugins.load = isPlainObject(plugins.load) ? plugins.load : {};
  const paths = Array.isArray(plugins.load.paths)
    ? plugins.load.paths.filter((entry) => typeof entry === "string")
    : [];
  const exists = paths.some((entry) => path.resolve(entry).toLowerCase() === pluginDir.toLowerCase());
  if (!exists) {
    paths.push(pluginDir);
    changes.push(`plugins.load.paths 增加 ${pluginDir}`);
  } else {
    changes.push(`plugins.load.paths 已包含 ${pluginDir}（不重复添加）`);
  }
  plugins.load.paths = paths;

  plugins.entries = isPlainObject(plugins.entries) ? plugins.entries : {};
  const entry = isPlainObject(plugins.entries[pluginId]) ? plugins.entries[pluginId] : {};
  entry.enabled = true;
  entry.hooks = isPlainObject(entry.hooks) ? entry.hooks : {};
  entry.hooks.allowConversationAccess = true;
  plugins.entries[pluginId] = entry;
  changes.push(`plugins.entries.${pluginId} 已启用，并打开 hooks.allowConversationAccess`);

  // plugins.allow 一旦是非空白名单，没列进去的插件不会加载
  if (Array.isArray(plugins.allow) && plugins.allow.length > 0 && !plugins.allow.includes(pluginId)) {
    plugins.allow.push(pluginId);
    changes.push(`plugins.allow 增加 ${pluginId}（否则会被白名单挡住）`);
  } else if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
    changes.push(`plugins.allow 已包含 ${pluginId}`);
  }

  // 提醒容易踩的坑
  if (Array.isArray(plugins.deny) && plugins.deny.includes(pluginId)) {
    warnings.push(`⚠️ plugins.deny 里有 ${pluginId}，deny 优先级最高，插件不会加载。请手动移除。`);
  }
  if (!fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"))) {
    warnings.push(`⚠️ ${pluginDir} 下没有 openclaw.plugin.json，确认插件文件已经复制过去。`);
  }
  if (!fs.existsSync(path.join(pluginDir, "index.js"))) {
    warnings.push(`⚠️ ${pluginDir} 下没有 index.js，确认插件文件已经复制过去。`);
  }
}

const output = `${JSON.stringify(config, null, 2)}\n`;

console.log(`配置：${configPath}`);
console.log(`插件：${pluginId} @ ${pluginDir}`);
console.log("");
for (const change of changes) console.log(`  • ${change}`);
if (changes.length === 0) console.log("  • 无需改动");
for (const warning of warnings) console.log(`\n${warning}`);

if (args.dryRun) {
  console.log("\n（--dry-run：没有写入任何文件）");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${configPath}.bak.keyword-router.${stamp}`;
try {
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, output, "utf8");
} catch (err) {
  console.error(`\n❌ 写入失败：${err?.message || err}`);
  process.exit(1);
}

console.log(`\n✅ 已写入。备份：${backupPath}`);
console.log("");
console.log("下一步：");
if (args.remove) {
  console.log("  1) 重启网关，让卸载生效：openclaw gateway restart");
  console.log("  2) 需要的话再手动删除插件目录（规则和日志都在里面）");
} else {
  console.log("  1) 重启网关，让插件加载：openclaw gateway restart");
  console.log("     （也可以重启 Windows 计划任务 “OpenClaw Gateway”）");
  console.log("  2) 确认插件真的加载了：openclaw plugins inspect keyword-router --runtime");
  console.log('  3) 在微信里发一句：我需要知道我的ip地址');
  console.log("     → 应该秒回本机 IP，并且不消耗 token（日志见插件目录 keyword-router.log）");
}
