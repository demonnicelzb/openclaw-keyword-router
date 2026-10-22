/**
 * keyword-router —— OpenClaw 关键词短路插件
 *
 * 作用：在模型被调用之前拦截消息。
 *   - 命中 routes.json 里的关键词 → 本地执行动作（内置功能 / 你自己的脚本），直接把结果回给你，消耗 0 token。
 *   - 没命中 → 返回 undefined，消息照常交给大模型处理。
 *
 * 依赖：只使用 Node 内置模块（openclaw 进程内直接加载，无需 npm install，无需 import openclaw 包）。
 * 适用：openclaw >= 2026.6.11（依赖 before_agent_reply 钩子）
 *
 * 自测（在普通终端里跑，不经过 openclaw）：
 *   node index.js --list                    列出已加载的规则
 *   node index.js "我需要知道我的ip地址"      按真实链路跑一遍，打印会回复什么
 *   node index.js --self-test               检查配置、规则和内置功能
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ID = "keyword-router";
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_FILE = path.join(PLUGIN_DIR, "routes.json");
const LOG_FILE = path.join(PLUGIN_DIR, "keyword-router.log");

/** 钩子最大执行时间（毫秒）。运行命令本身还有 settings.timeoutMs 兜底。 */
const HOOK_TIMEOUT_MS = 60000;

const DEFAULT_SETTINGS = Object.freeze({
  /** 总开关：false 时插件完全不拦截，一切交给大模型 */
  enabled: true,
  /** 单条命令超时（毫秒） */
  timeoutMs: 20000,
  /** 捕获 stdout/stderr 的上限（字符），超出部分丢弃 */
  maxOutputChars: 3500,
  /** 回复给微信的最大字符数（超出截断） */
  maxReplyChars: 4000,
  /** 只响应这些发送者；留空 [] = 不限制 */
  onlySenders: [],
  /** 是否写本地日志 */
  log: true,
  /** 公网 IP 查询（内置 ip 功能用） */
  publicIpLookup: true,
  publicIpTimeoutMs: 3500,
});

const DEFAULT_CONFIG = Object.freeze({ settings: DEFAULT_SETTINGS, routes: [] });

// ---------------------------------------------------------------------------
// 配置加载（带 mtime 缓存：改完 routes.json 不用重启网关）
// ---------------------------------------------------------------------------

let configCache = { file: null, mtimeMs: 0, size: -1, config: DEFAULT_CONFIG };
/** 最近一次成功加载的 settings，给日志等旁路逻辑用 */
let currentSettings = DEFAULT_SETTINGS;

function resolveRoutesFile(pluginConfig) {
  const configured = pluginConfig?.routesPath;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(PLUGIN_DIR, configured.trim());
  }
  return ROUTES_FILE;
}

function loadConfig(pluginConfig) {
  const file = resolveRoutesFile(pluginConfig);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    if (configCache.file !== file) warn(`找不到规则文件：${file}`);
    return DEFAULT_CONFIG;
  }

  if (
    configCache.file === file &&
    configCache.mtimeMs === stat.mtimeMs &&
    configCache.size === stat.size
  ) {
    currentSettings = configCache.config.settings;
    return configCache.config;
  }

  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const config = normalizeConfig(JSON.parse(raw), file);
    configCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, config };
    currentSettings = config.settings;
    return config;
  } catch (err) {
    warn(`规则文件解析失败（沿用上一次可用配置）：${file} -> ${err?.message || err}`);
    return configCache.file === file ? configCache.config : DEFAULT_CONFIG;
  }
}

function normalizeConfig(parsed, file) {
  if (!parsed || typeof parsed !== "object") {
    warn(`规则文件内容不是对象：${file}`);
    return DEFAULT_CONFIG;
  }

  const settings = { ...DEFAULT_SETTINGS };
  const rawSettings = parsed.settings;
  if (rawSettings && typeof rawSettings === "object") {
    if (typeof rawSettings.enabled === "boolean") settings.enabled = rawSettings.enabled;
    if (Number.isFinite(Number(rawSettings.timeoutMs)) && Number(rawSettings.timeoutMs) > 0) {
      settings.timeoutMs = Math.min(Number(rawSettings.timeoutMs), 600000);
    }
    if (Number.isFinite(Number(rawSettings.maxOutputChars)) && Number(rawSettings.maxOutputChars) > 0) {
      settings.maxOutputChars = Math.min(Number(rawSettings.maxOutputChars), 200000);
    }
    if (Number.isFinite(Number(rawSettings.maxReplyChars)) && Number(rawSettings.maxReplyChars) > 0) {
      settings.maxReplyChars = Math.min(Number(rawSettings.maxReplyChars), 20000);
    }
    if (Array.isArray(rawSettings.onlySenders)) {
      settings.onlySenders = rawSettings.onlySenders.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
    }
    if (typeof rawSettings.log === "boolean") settings.log = rawSettings.log;
    if (typeof rawSettings.publicIpLookup === "boolean") settings.publicIpLookup = rawSettings.publicIpLookup;
    if (Number.isFinite(Number(rawSettings.publicIpTimeoutMs)) && Number(rawSettings.publicIpTimeoutMs) > 0) {
      settings.publicIpTimeoutMs = Math.min(Number(rawSettings.publicIpTimeoutMs), 30000);
    }
  }

  const rawRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];
  const routes = [];

  rawRoutes.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `route-${index + 1}`;
    const match = raw.match && typeof raw.match === "object" ? raw.match : {};
    const action = normalizeAction(raw);
    if (!action) {
      warn(`规则 "${id}" 没有可用的 action，已忽略`);
      return;
    }

    const keywords = Array.isArray(match.keywords)
      ? match.keywords.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
      : [];
    const negativeKeywords = Array.isArray(match.negativeKeywords)
      ? match.negativeKeywords.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())
      : [];
    const regexes = compileRegexes(match.regex, match.regexFlags, id);

    if (keywords.length === 0 && regexes.length === 0) {
      warn(`规则 "${id}" 没有 keywords / regex，永远无法命中，已忽略`);
      return;
    }

    routes.push({
      id,
      enabled: raw.enabled !== false,
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
      order: index,
      caseSensitive: match.caseSensitive === true,
      keywords,
      negativeKeywords,
      regexes,
      action,
      template: typeof raw.template === "string" ? raw.template : "",
      description: typeof raw.description === "string" ? raw.description : "",
    });
  });

  // 高优先级先匹配；同优先级按文件里的书写顺序
  routes.sort((a, b) => b.priority - a.priority || a.order - b.order);

  return { settings, routes };
}

function compileRegexes(input, flagsInput, id) {
  const list = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const rawFlags = typeof flagsInput === "string" ? flagsInput : "i";
  const flags = rawFlags.replace(/[gy]/g, "");
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || !item) continue;
    try {
      out.push(new RegExp(item, flags));
    } catch (err) {
      warn(`规则 "${id}" 的正则无法编译，已忽略：${item} -> ${err?.message || err}`);
    }
  }
  return out;
}

function normalizeAction(raw) {
  let action = raw.action;
  if (!action && typeof raw.builtin === "string") action = { type: "builtin", name: raw.builtin };
  if (!action || typeof action !== "object") return null;

  const type = String(action.type ?? "cmd").trim().toLowerCase();

  if (type === "builtin") {
    const name = String(action.name ?? "").trim();
    if (!name) return null;
    return { type: "builtin", name };
  }

  const normalized = {
    type,
    path: typeof action.path === "string" && action.path.trim() ? expandPath(action.path.trim()) : null,
    args: Array.isArray(action.args) ? action.args.map((v) => String(v)) : [],
    cwd: typeof action.cwd === "string" && action.cwd.trim() ? expandPath(action.cwd.trim()) : null,
    command: typeof action.command === "string" ? action.command : null,
    encoding: typeof action.encoding === "string" ? action.encoding.trim().toLowerCase() : "auto",
  };

  if (!normalized.path && !normalized.command) return null;
  return normalized;
}

function expandPath(input) {
  let out = input;
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (full, name) => {
    const value = process.env[name];
    return typeof value === "string" ? value : full;
  });
  // 绝对路径原样返回；相对路径按插件目录解析
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(PLUGIN_DIR, out);
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

/** 命中返回命中的关键词/正则片段，未命中返回 null。 */
function matchRoute(route, text) {
  const haystack = route.caseSensitive ? text : text.toLowerCase();

  for (const word of route.negativeKeywords) {
    const needle = route.caseSensitive ? word : word.toLowerCase();
    if (haystack.includes(needle)) return null;
  }

  for (const word of route.keywords) {
    const needle = route.caseSensitive ? word : word.toLowerCase();
    if (haystack.includes(needle)) return word;
  }

  for (const regex of route.regexes) {
    try {
      const found = regex.exec(text);
      if (found) return found[0];
    } catch {
      /* 正则执行异常时视为不命中 */
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 执行动作
// ---------------------------------------------------------------------------

const BUILTINS = {
  ip: builtinIp,
  hostname: builtinHostname,
  sysinfo: builtinSysinfo,
  time: builtinTime,
  uptime: builtinUptime,
  mem: builtinMem,
  disk: builtinDisk,
  help: builtinHelp,
};

async function runAction(route, text, matched, settings) {
  const action = route.action;

  if (action.type === "builtin") {
    const fn = BUILTINS[action.name];
    if (!fn) return { ok: false, output: "", error: `未知的内置功能：${action.name}` };
    try {
      return { ok: true, output: String(await fn(settings) ?? "") };
    } catch (err) {
      return { ok: false, output: "", error: String(err?.message || err) };
    }
  }

  const argv = buildArgv(action, text, matched);
  if (!argv) {
    return { ok: false, output: "", error: `规则 "${route.id}" 的动作配置不完整（缺少 path / command）` };
  }

  const result = await runProcess(argv.file, argv.args, {
    timeoutMs: settings.timeoutMs,
    maxOutputChars: settings.maxOutputChars,
    cwd: action.cwd || PLUGIN_DIR,
    encoding: action.encoding,
  });

  const output = [result.stdout, result.stderr]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join("\n");

  if (result.timedOut) {
    return { ok: false, output, error: `命令超过 ${settings.timeoutMs}ms 被终止` };
  }
  if (result.spawnError) {
    return { ok: false, output, error: `命令启动失败：${result.spawnError}` };
  }
  if (result.code !== 0) {
    const suffix = result.signal ? `（signal=${result.signal}）` : "";
    return { ok: false, output, error: `命令退出码 ${result.code}${suffix}` };
  }
  return { ok: true, output };
}

function buildArgv(action, text, matched) {
  const fill = (value) =>
    String(value ?? "")
      .replaceAll("{{text}}", text)
      .replaceAll("{{match}}", matched ?? "");

  const args = action.args.map(fill);

  switch (action.type) {
    case "cmd":
    case "shell": {
      const command = fill(action.command ?? action.path ?? "");
      if (!command) return null;
      const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
      return { file: comspec, args: ["/d", "/s", "/c", command] };
    }
    case "ps1":
    case "powershell": {
      if (!action.path) return null;
      const shell = resolvePowerShell();
      return {
        file: shell,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", action.path, ...args],
      };
    }
    case "node":
    case "js": {
      if (!action.path) return null;
      return { file: process.execPath, args: [action.path, ...args] };
    }
    case "python":
    case "py": {
      if (!action.path) return null;
      return { file: resolvePython(), args: [action.path, ...args] };
    }
    case "exe":
    case "exec":
    case "run": {
      if (!action.path) return null;
      return { file: action.path, args };
    }
    default:
      return null;
  }
}

let powershellPath;
function resolvePowerShell() {
  if (powershellPath) return powershellPath;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ];
  for (const candidate of candidates) {
    if (!candidate.includes("\\")) {
      powershellPath = candidate;
      return powershellPath;
    }
    try {
      if (fs.existsSync(candidate)) {
        powershellPath = candidate;
        return powershellPath;
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  powershellPath = "powershell.exe";
  return powershellPath;
}

let pythonPath;
function resolvePython() {
  if (pythonPath) return pythonPath;
  const candidates = ["python.exe", "py.exe"];
  for (const candidate of candidates) {
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, candidate);
      try {
        if (fs.existsSync(full)) {
          pythonPath = full;
          return pythonPath;
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  pythonPath = "python.exe";
  return pythonPath;
}

/** 用指定编码解码；不支持该编码时返回 null。 */
function decodeWith(encoding, buffer) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * 解码子进程输出。
 * Windows 上 cmd / PowerShell 5.1 默认按 OEM 代码页（中文系统是 GBK）输出，
 * 而 node 输出 UTF-8，所以默认 "auto"：先按 UTF-8 解，出现替换字符再退回 GBK。
 */
function decodeOutput(buffer, encoding) {
  if (!buffer || buffer.length === 0) return "";
  const mode = encoding && encoding !== "auto" ? encoding : "auto";

  if (mode !== "auto") {
    if (mode === "gbk" || mode === "gb2312" || mode === "gb18030") {
      return decodeWith("gbk", buffer) ?? buffer.toString("utf8");
    }
    if (mode === "utf16le" || mode === "utf-16le") return buffer.toString("utf16le");
    if (mode === "latin1" || mode === "binary") return buffer.toString("latin1");
    return buffer.toString("utf8");
  }

  const utf8 = buffer.toString("utf8");
  if (utf8.includes("\uFFFD")) {
    const gbk = decodeWith("gbk", buffer);
    if (gbk && !gbk.includes("\uFFFD")) return gbk;
  }
  return utf8;
}

function runProcess(file, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "", timedOut: false, spawnError: String(err?.message || err) });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    // 按字节限流，解码后再按字符截断，避免把多字节字符切坏
    const byteCap = options.maxOutputChars * 4;

    const collect = () => ({
      stdout: decodeOutput(Buffer.concat(outChunks), options.encoding),
      stderr: decodeOutput(Buffer.concat(errChunks), options.encoding),
    });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // Windows 上 child.kill() 只杀直接子进程，cmd /c 拉起的孙进程会残留，用 taskkill /T 收掉整棵树
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => {});
        } catch {
          /* 忽略 */
        }
      }
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      // 兜底：上面的清理可能因为句柄被孙进程占用而拿不到 close
      setTimeout(() => finish({ code: -1, ...collect(), timedOut: true }), 1500);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (outBytes >= byteCap) return;
      outChunks.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk) => {
      if (errBytes >= byteCap) return;
      errChunks.push(chunk);
      errBytes += chunk.length;
    });

    child.on("error", (err) => {
      finish({ code: -1, ...collect(), timedOut, spawnError: String(err?.message || err) });
    });
    child.on("close", (code, signal) => {
      finish({ code: code ?? -1, ...collect(), timedOut, signal });
    });
  });
}

// ---------------------------------------------------------------------------
// 内置功能
// ---------------------------------------------------------------------------

async function builtinIp(settings) {
  const lines = [];

  const privateV4 = [];
  const otherV4 = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses ?? []) {
      const family = addr.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (addr.internal) continue;
      if (addr.address.startsWith("169.254.")) continue;
      const row = `${addr.address}（${name}）`;
      if (isPrivateV4(addr.address)) privateV4.push(row);
      else otherV4.push(row);
    }
  }

  lines.push("【局域网 IP】");
  lines.push(...(privateV4.length ? privateV4 : ["未找到"]));
  if (otherV4.length) {
    lines.push("", "【其它 IPv4】", ...otherV4);
  }

  if (settings.publicIpLookup) {
    lines.push("", "【公网 IP】");
    const info = await fetchPublicIpInfo(settings.publicIpTimeoutMs);
    if (info.ip) {
      lines.push(info.location ? `${info.ip}（${info.location}）` : info.ip);
    } else {
      lines.push("获取失败（网络受限或超时，可把 settings.publicIpLookup 设为 false 关掉）");
    }
  }

  return lines.join("\n");
}

function isPrivateV4(address) {
  const parts = address.split(".").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

const IP_LOOKUP_ENDPOINTS = [
  "https://ip.3322.net",
  "https://ipinfo.io/ip",
  "https://ifconfig.me/ip",
  "https://api.ip.sb/ip",
  "https://icanhazip.com",
];
const IP_LOCATION_ENDPOINT = "https://myip.ipip.net";

function httpGetText(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value ?? "");
    };

    let request;
    try {
      request = https.get(
        url,
        { timeout: timeoutMs, headers: { "User-Agent": "keyword-router/1.0" } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume?.();
            finish("");
            return;
          }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            if (body.length < 2000) body += chunk;
          });
          response.on("end", () => finish(body));
          response.on("error", () => finish(""));
        },
      );
    } catch {
      finish("");
      return;
    }

    const timer = setTimeout(() => {
      try {
        request.destroy();
      } catch {
        /* 忽略 */
      }
      finish("");
    }, timeoutMs);

    request.on("timeout", () => {
      try {
        request.destroy();
      } catch {
        /* 忽略 */
      }
      finish("");
    });
    request.on("error", () => finish(""));
    request.on("close", () => clearTimeout(timer));
  });
}

/** 并行查多个接口，谁先给出合法 IP 就用谁；归属地接口只作补充。 */
async function fetchPublicIpInfo(timeoutMs) {
  const bareTasks = IP_LOOKUP_ENDPOINTS.map((url) =>
    httpGetText(url, timeoutMs).then((body) => {
      const text = String(body).trim();
      if (!/^[0-9a-fA-F:.]{3,45}$/.test(text)) return "";
      return text.includes(".") || text.includes(":") ? text : "";
    }),
  );

  const locationTask = httpGetText(IP_LOCATION_ENDPOINT, timeoutMs)
    .then((body) => parseIpipBody(body))
    .catch(() => null);

  const bareResults = await Promise.all(bareTasks);
  const ip = bareResults.find((value) => value) ?? "";
  if (!ip) return { ip: "", location: "" };

  // 归属地最多再等半个预算，拿不到就不影响主结果
  const location = await Promise.race([
    locationTask,
    new Promise((resolve) => setTimeout(() => resolve(null), Math.max(500, Math.floor(timeoutMs / 2)))),
  ]);

  // 只有归属地接口报的 IP 与实际 IP 一致时才采信
  const matched = location && location.ip === ip ? location.location : "";
  return { ip, location: matched };
}

function parseIpipBody(body) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  const ipMatch = text.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (!ipMatch) return null;
  const location = text
    .replace(/^.*?来自于[:：]?/, "")
    .replace(ipMatch[1], "")
    .replace(/\s+/g, " ")
    .trim();
  return { ip: ipMatch[1], location };
}

function builtinHostname() {
  return [
    `主机名：${os.hostname()}`,
    `平台：${os.platform()} ${os.arch()}`,
    `系统版本：${os.release()}`,
  ].join("\n");
}

function builtinSysinfo() {
  const cpus = os.cpus() ?? [];
  return [
    `主机名：${os.hostname()}`,
    `用户：${os.userInfo().username}`,
    `系统：${os.type()} ${os.release()} (${os.arch()})`,
    `CPU：${cpus[0]?.model?.trim() || "未知"} × ${cpus.length}`,
    `内存：${formatGiB(os.totalmem())} GB 总量 / ${formatGiB(os.freemem())} GB 可用`,
    `运行时长：${formatDuration(os.uptime())}`,
  ].join("\n");
}

function builtinTime() {
  return `现在时间：${formatNow()}`;
}

function builtinUptime() {
  return `已开机运行：${formatDuration(os.uptime())}`;
}

function builtinMem() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = total > 0 ? ((used / total) * 100).toFixed(1) : "0";
  return [
    `内存总量：${formatGiB(total)} GB`,
    `已使用：${formatGiB(used)} GB（${percent}%）`,
    `可用：${formatGiB(free)} GB`,
  ].join("\n");
}

function builtinDisk() {
  const lines = [];
  const targets = process.platform === "win32"
    ? ["C:\\", "D:\\", "E:\\", "F:\\"]
    : ["/"];
  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) continue;
      const stat = fs.statfsSync(target);
      const total = stat.blocks * stat.bsize;
      const free = stat.bfree * stat.bsize;
      const usedPercent = total > 0 ? (((total - free) / total) * 100).toFixed(1) : "0";
      lines.push(`${target} 共 ${formatGiB(total)} GB，可用 ${formatGiB(free)} GB（已用 ${usedPercent}%）`);
    } catch {
      /* 跳过不可用的盘符 */
    }
  }
  return lines.length ? lines.join("\n") : "磁盘信息获取失败";
}

async function builtinHelp() {
  const config = loadConfig(currentPluginConfig);
  const rows = config.routes
    .filter((route) => route.enabled)
    .map((route) => {
      const words = [...route.keywords, ...route.regexes.map((rx) => rx.source)]
        .slice(0, 4)
        .join(" / ");
      return `- ${words}${route.description ? `：${route.description}` : ""}`;
    });
  return rows.length
    ? ["当前走本地脚本的关键词：", ...rows].join("\n")
    : "当前没有启用任何关键词规则。";
}

// ---------------------------------------------------------------------------
// 回复渲染 + 日志
// ---------------------------------------------------------------------------

function renderReply(route, result, text, matched, settings) {
  const output = result.output || (result.ok ? "（已执行，无输出）" : "");
  const template = route.template || "{{output}}";
  const values = {
    output,
    error: result.error || "",
    match: matched ?? "",
    id: route.id,
    time: formatNow(),
    text,
  };

  let body = template.replace(/\{\{(\w+)\}\}/g, (full, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : full,
  );

  if (!body.includes(output) && output && !template.includes("{{output}}")) {
    body = `${body}\n${output}`;
  }
  if (!result.ok && result.error && !template.includes("{{error}}")) {
    body = `${body}\n\n⚠️ ${result.error}`;
  }

  body = String(body).replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!body) body = "（无内容）";
  if (body.length > settings.maxReplyChars) {
    body = `${body.slice(0, settings.maxReplyChars)}\n……（输出过长已截断）`;
  }
  return body;
}

function formatNow() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function formatGiB(bytes) {
  return (Number(bytes) / 1024 / 1024 / 1024).toFixed(1);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  parts.push(`${minutes} 分钟`);
  return parts.join(" ");
}

let loggerRef = null;
let currentPluginConfig;

function warn(message) {
  try {
    if (loggerRef?.warn) loggerRef.warn(`[${PLUGIN_ID}] ${message}`);
  } catch {
    /* 忽略 */
  }
}

function log(message) {
  try {
    loggerRef?.info?.(`[${PLUGIN_ID}] ${message}`);
  } catch {
    /* 忽略 */
  }
  try {
    if (!message) return;
    const settings = currentSettings ?? DEFAULT_SETTINGS;
    if (settings.log === false) return;
    fs.appendFileSync(LOG_FILE, `[${formatNow()}] ${message}\n`, "utf8");
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 1024 * 1024) {
      fs.writeFileSync(LOG_FILE, `[${formatNow()}] 日志超过 1MB，已重置\n`, "utf8");
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function isSenderAllowed(settings, ctx) {
  const allow = settings.onlySenders;
  if (!Array.isArray(allow) || allow.length === 0) return true;

  const candidates = [ctx?.senderId, ctx?.chatId, ctx?.channelId, ctx?.sessionKey]
    .filter((v) => typeof v === "string" && v)
    .map((v) => v.toLowerCase());

  return allow.some((entry) => candidates.includes(entry.toLowerCase()));
}

// ---------------------------------------------------------------------------
// 主体：处理一条消息
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{handled: false} | {handled: true, reply: {text: string}, reason: string}>}
 */
async function handleMessage(rawText, ctx, pluginConfig) {
  const text = String(rawText ?? "").trim();
  if (!text) return { handled: false };

  const config = loadConfig(pluginConfig);
  if (config.settings.enabled === false) return { handled: false };

  let route = null;
  let matched = null;
  for (const candidate of config.routes) {
    if (!candidate.enabled) continue;
    const hit = matchRoute(candidate, text);
    if (hit !== null) {
      route = candidate;
      matched = hit;
      break;
    }
  }
  if (!route) return { handled: false };

  if (!isSenderAllowed(config.settings, ctx)) {
    log(`命中 ${route.id} 但发送者不在 onlySenders 白名单，放行给大模型`);
    return { handled: false };
  }

  const startedAt = Date.now();
  const result = await runAction(route, text, matched, config.settings);
  const replyText = renderReply(route, result, text, matched, config.settings);
  const elapsed = Date.now() - startedAt;
  log(
    `route=${route.id} match=${JSON.stringify(matched)} ok=${result.ok} ${elapsed}ms` +
      (result.error ? ` error=${JSON.stringify(result.error)}` : ""),
  );

  return {
    handled: true,
    reply: { text: replyText },
    reason: `${PLUGIN_ID}:${route.id}`,
  };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

const plugin = {
  id: PLUGIN_ID,
  name: "Keyword Router",
  description: "关键词短路：命中关键词时本地执行脚本并直接回复，不再调用大模型。",
  register(api) {
    loggerRef = api?.logger ?? null;
    currentPluginConfig = api?.pluginConfig ?? {};

    // 启动时把规则读一遍，问题尽早暴露在网关日志里
    try {
      const config = loadConfig(currentPluginConfig);
      log(`已加载 ${config.routes.length} 条规则（enabled=${config.settings.enabled}）`);
      if (config.routes.length === 0) {
        warn("routes.json 里没有可用规则，插件不会拦截任何消息");
      }
    } catch (err) {
      warn(`启动自检失败：${err?.message || err}`);
    }

    api.on(
      "before_agent_reply",
      async (event, ctx) => {
        try {
          // 心跳 / 定时任务触发的轮次不要抢
          if (ctx?.trigger && ctx.trigger !== "user") return;
          // 斜杠命令交给 openclaw 自己的命令体系
          const text = String(event?.cleanedBody ?? "");
          if (text.trim().startsWith("/")) return;

          const outcome = await handleMessage(text, ctx, currentPluginConfig);
          return outcome.handled ? outcome : undefined;
        } catch (err) {
          // 出错就当没命中，交还给大模型，避免把用户消息卡死
          warn(`处理消息异常，已放行给大模型：${err?.stack || err}`);
          return undefined;
        }
      },
      { priority: 90, timeoutMs: HOOK_TIMEOUT_MS },
    );
  },
};

export default plugin;

// ---------------------------------------------------------------------------
// 本地自测 CLI（只有在直接运行本文件时才生效，被 openclaw 加载时不执行）
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  runCli().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}

async function runCli() {
  const args = process.argv.slice(2);

  // --routes <文件>：用指定的规则文件跑，方便改之前先试
  let routesOverride = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--routes") {
      routesOverride = args[i + 1];
      i += 1;
      continue;
    }
    rest.push(args[i]);
  }
  const pluginConfig = routesOverride ? { routesPath: routesOverride } : {};

  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    console.log(
      [
        "keyword-router 本地自测",
        "",
        "  node index.js --list                    列出规则",
        "  node index.js --self-test               检查配置和内置功能",
        '  node index.js "我的ip地址"               模拟一条微信消息，打印实际会回复的内容',
        "  node index.js --routes other.json ...   用指定规则文件跑（上面几种用法都支持）",
        "",
        `默认规则文件：${ROUTES_FILE}`,
      ].join("\n"),
    );
    return;
  }

  const config = loadConfig(pluginConfig);
  if (config.routes.length === 0) {
    console.log(`⚠️ 没有加载到规则。请检查 ${ROUTES_FILE}`);
  }

  if (rest[0] === "--list") {
    console.log(`规则文件：${config.routes.length ? ROUTES_FILE : "（未找到或为空）"}`);
    console.log(`总开关：${config.settings.enabled ? "开" : "关"}`);
    for (const route of config.routes) {
      const action =
        route.action.type === "builtin"
          ? `内置:${route.action.name}`
          : `${route.action.type}:${route.action.path ?? route.action.command}`;
      console.log(
        `- [${route.enabled ? "启用" : "停用"}] ${route.id} (优先级 ${route.priority})\n` +
          `    关键词: ${route.keywords.join(" / ") || "（无）"}\n` +
          `    正则: ${route.regexes.map((r) => r.source).join(" / ") || "（无）"}\n` +
          `    动作: ${action}`,
      );
    }
    return;
  }

  if (rest[0] === "--self-test") {
    const checks = [];
    checks.push(["规则文件可读", fs.existsSync(ROUTES_FILE)]);
    checks.push(["至少有一条规则", config.routes.length > 0]);

    const ipRoute = config.routes.find((r) => r.action.type === "builtin" && r.action.name === "ip");
    checks.push(["存在 ip 内置规则", Boolean(ipRoute)]);

    const probe = "我需要知道我的ip地址";
    const hit = ipRoute ? matchRoute(ipRoute, probe) : null;
    checks.push([`示例文本能命中 ip 规则（"${probe}"）`, hit !== null]);

    for (const [label, ok] of checks) {
      console.log(`${ok ? "✅" : "❌"} ${label}`);
    }

    if (ipRoute) {
      console.log("\n--- 内置 ip 实际输出 ---");
      const result = await runAction(ipRoute, probe, hit ?? "ip", config.settings);
      console.log(result.ok ? result.output : `❌ ${result.error}\n${result.output}`);
    }
    return;
  }

  const text = rest.join(" ").trim();
  const outcome = await handleMessage(text, { trigger: "user" }, pluginConfig);
  if (!outcome.handled) {
    console.log(`没有命中任何关键词 → 这条消息会交给大模型处理（会消耗 token）：${text}`);
    return;
  }
  console.log(`命中规则：${outcome.reason}`);
  console.log("--- 会回复给微信的内容 ---");
  console.log(outcome.reply.text);
}
