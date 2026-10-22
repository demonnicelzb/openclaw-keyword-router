// 示例：列出某个目录里最大的 N 个文件（只读脚本，安全）
//
// 用法：
//   node 示例-大文件扫描.mjs "D:\下载" 10
//
// 对应 routes.json（把用户发的目录传进来）：
// {
//   "id": "大文件",
//   "match": { "regex": ["^大文件\\s+(.+)$"] },
//   "action": { "type": "node", "path": "C:\\scripts\\示例-大文件扫描.mjs", "args": ["{{match}}", "10"] },
//   "template": "{{output}}"
// }

import fs from "node:fs";
import path from "node:path";

const target = process.argv[2] || process.cwd();
const topN = Math.max(1, Math.min(50, Number(process.argv[3] || 10)));
const MAX_DEPTH = 3;
const MAX_FILES = 20000;

const found = [];
let scanned = 0;

function walk(dir, depth) {
  if (depth > MAX_DEPTH || scanned >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (scanned >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, depth + 1);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      scanned += 1;
      found.push({ full, size: stat.size, mtime: stat.mtime });
    } catch {
      // 跳过没有权限的文件
    }
  }
}

if (!fs.existsSync(target)) {
  console.log(`目录不存在：${target}`);
  process.exit(0);
}

walk(target, 0);

if (found.length === 0) {
  console.log(`${target} 下没有找到文件（已扫描 ${scanned} 个）`);
  process.exit(0);
}

found.sort((a, b) => b.size - a.size);

const lines = [`${target} 下最大的 ${Math.min(topN, found.length)} 个文件（共扫描 ${scanned} 个）：`];
for (const item of found.slice(0, topN)) {
  const mb = (item.size / 1024 / 1024).toFixed(1);
  const when = item.mtime.toISOString().slice(0, 10);
  lines.push(`- ${mb} MB  ${when}  ${path.basename(item.full)}`);
}
console.log(lines.join("\n"));
