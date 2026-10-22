# keyword-router · 给 OpenClaw 的「关键词本地旁路」

> 命中关键词 → 本地跑脚本 → 直接把结果回给你，**不调用大模型（0 token）**；
> 没命中 → 照旧交给大模型。专治 clawbot 聊天太费 token。
>
> A zero-token keyword router plugin for OpenClaw. Matched keywords run local
> scripts and reply directly; everything else still goes to the LLM.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.6.11-orange)
![Node](https://img.shields.io/badge/Node-%3E%3D22.19-green)

---

## 为什么

OpenClaw 的每条消息默认都会走一遍「组 prompt + 历史上下文 + 模型调用」。哪怕你只是问一句「我的 IP 是多少」，也是全量 token。

| 消息 | 默认行为 | 装了本插件 |
| --- | --- | --- |
| 「我的ip地址」 | 组 prompt → 调模型 → 回复 | **本地取 IP，直接回复，0 token** |
| 「帮我把这段话润色一下」 | 调模型 | 照旧调模型（没命中关键词） |

关键在于 openclaw 2026.6.11 的 `before_agent_reply` 钩子：它在**模型调用之前**执行，返回 `{handled:true, reply:{text}}` 就直接短路整轮，模型那一次调用根本不会发生。

```js
// openclaw/dist/get-reply-*.js 里的真实逻辑
const hookResult = await hookRunner.runBeforeAgentReply({ cleanedBody }, {...});
if (hookResult?.handled) {
  return hookResult.reply ?? { text: "NO_REPLY" };  // 下面的模型调用被跳过
}
```

## 特性

- **0 token**：命中的消息不进模型，不产生任何费用
- **零依赖**：只用 Node 内置模块，不需要 `npm install`
- **改规则不用重启**：`routes.json` 按文件 mtime 热加载
- **6 种动作**：内置功能 / PowerShell / Node / Python / cmd / exe
- **8 个内置功能**：IP、磁盘、内存、系统信息、主机名、开机时长、时间、帮助
- **中文不乱码**：自动识别 GBK / UTF-8 输出
- **不抢话、不卡死**：没命中放行；插件出错也放行，不会把你的 bot 弄挂
- **失败可观测**：每次命中都写 `keyword-router.log`

## 前置要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（插件本身跨平台，部署脚本是 Windows 的） |
| OpenClaw | **>= 2026.6.11**（需要 `before_agent_reply` 钩子） |
| Node | >= 22.19（用 openclaw 同一个 node 即可） |

## 快速部署

### 方式 A：双击（最省事）

1. 把压缩包**完整解压**
2. 双击 **`一键部署.cmd`**（或 `deploy.cmd`）
3. 按提示重启网关，见下一节
4. 微信里发「我的ip地址」验证

### 方式 B：命令行

```powershell
cd <解压目录>
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 只看会做什么，不写文件
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun

# 装完顺手重启网关
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Restart
```

### 方式 C：直接从 GitHub 装

```powershell
irm https://raw.githubusercontent.com/demonnicelzb/openclaw-keyword-router/main/install-from-github.ps1 -OutFile $env:TEMP\okr.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\okr.ps1 -Repo demonnicelzb/openclaw-keyword-router
```

> 先下载到本地再执行，不要 `irm ... | iex`——管道执行的脚本被中途修改时不好排查。

### 安装器做了什么

| # | 动作 |
| --- | --- |
| 1 | 复制 `index.js`、`openclaw.plugin.json`、`package.json` 到 `%USERPROFILE%\.openclaw\keyword-router\` |
| 2 | `routes.json` 仅在不存在时复制（**升级不会覆盖你改过的规则**） |
| 3 | 改 `openclaw.json`：加 `plugins.load.paths` + `plugins.entries.keyword-router`（`enabled` + `hooks.allowConversationAccess`），**写入前自动备份** |
| 4 | 打印验证命令 |

目标路径固定为 `%USERPROFILE%\.openclaw\keyword-router`；想装到别处用 `--target-dir <目录>`。

## 重启网关（必须，否则不生效）

配置改动需要网关重启才加载。

```powershell
openclaw gateway restart
# 有对话在进行时：openclaw gateway restart --safe
```

如果报 `pairing required` / `scope upgrade pending approval`（本机 CLI 只有只读权限），二选一：

```powershell
# 办法 1：重启 Windows 计划任务（约 6 秒）
Stop-Process -Id (Get-NetTCPConnection -LocalPort 18789 -State Listen).OwningProcess -Force
Start-ScheduledTask -TaskName 'OpenClaw Gateway'
```

```text
# 办法 2：打开 Control UI http://127.0.0.1:18789/
#        批准待处理的设备请求，之后 openclaw 命令就正常了
```

## 验证部署成功

```powershell
$kw = "$env:USERPROFILE\.openclaw\keyword-router"

# 1) 插件自身自测
node "$kw\index.js" --self-test

# 2) 模拟一条微信消息，看会回什么（不经过微信）
node "$kw\index.js" "我的ip地址"

# 3) 配置合法
openclaw config validate

# 4) 网关真的加载了它（关键证据）
Get-Content "$kw\keyword-router.log" -Tail 5 -Encoding UTF8
#    期望： [xxxx-xx-xx xx:xx:xx] 已加载 12 条规则（enabled=true）
```

第 4 步有那行日志，才代表**运行中的网关**加载了插件。之后每次命中还会追加：

```
[2026-10-19 06:10:22] route=ip match="ip" ok=true 12ms
```

## 配置说明

安装器写进 `openclaw.json` 的内容：

```json
{
  "plugins": {
    "load": {
      "paths": ["C:\\Users\\<你>\\.openclaw\\keyword-router"]
    },
    "entries": {
      "keyword-router": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

> ⚠️ `allowConversationAccess` **不能漏**。漏了不会报错，但钩子会被静默拦截，表现就是「发关键词没反应、还是走了大模型」。

## 加关键词（3 分钟）

改 `%USERPROFILE%\.openclaw\keyword-router\routes.json`，保存即生效，**不用重启网关**。

```json
{
  "id": "磁盘报告",
  "priority": 60,
  "match": { "keywords": ["磁盘报告", "还有多少空间"] },
  "action": { "type": "ps1", "path": "C:\\scripts\\示例-磁盘报告.ps1" },
  "template": "【磁盘报告】\n{{output}}"
}
```

完整教程（4 个从零例子、字段速查、10 个常见坑）见 **[教程-添加关键词与命令.md](教程-添加关键词与命令.md)**。
现成脚本在 `示例脚本\`，可直接复制到 `C:\scripts\` 使用。

## 内置功能

`action: { "type": "builtin", "name": "..." }`

| name | 输出 |
| --- | --- |
| `ip` | 局域网 + 公网 IP（含归属地） |
| `sysinfo` | CPU / 内存 / 系统 / 运行时长 |
| `hostname` | 主机名、系统版本 |
| `disk` | 各盘容量与剩余 |
| `mem` | 内存占用 |
| `uptime` | 开机时长 |
| `time` | 当前时间 |
| `help` | 列出当前启用的关键词 |

## 动作类型

| type | 跑什么 | 关键字段 |
| --- | --- | --- |
| `builtin` | 插件内置功能（不起进程，最快） | `name` |
| `ps1` | 你的 `.ps1`（Windows PowerShell 5.1） | `path`、`args` |
| `node` | 你的 `.js` / `.mjs`（用网关同一个 node） | `path`、`args` |
| `python` | 你的 `.py` | `path`、`args` |
| `cmd` | 一条 cmd 命令 | `command` |
| `exe` | 任意可执行文件 | `path`、`args` |

通用可选字段：`cwd`、`encoding`（默认 `auto`）、`template`、`enabled`、`priority`。
占位符：`{{text}}` 原文、`{{match}}` 命中的词（可用于 `args` / `command` / `template`）。

## 目录结构

```
keyword-router/
├── 一键部署.cmd / deploy.cmd     双击部署入口（内容相同，前者中文名）
├── install.ps1                   PowerShell 入口（故意纯 ASCII）
├── install.mjs                   安装逻辑：复制文件 + 改配置 + 可选重启
├── apply-config.mjs              只负责安全地改 openclaw.json（自动备份）
├── install-from-github.ps1       从 GitHub 直接安装
├── index.js                      ★ 插件本体（钩子 + 匹配 + 执行 + 内置功能）
├── routes.json                   ★ 关键词规则（你平时只改这个）
├── openclaw.plugin.json          插件清单（activation.onStartup）
├── package.json                  包声明（type: module）
├── 教程-添加关键词与命令.md      手把手教程
├── 示例脚本/
│   ├── 示例-磁盘报告.ps1         已带 UTF-8 BOM，可直接用
│   └── 示例-大文件扫描.mjs
├── README.md
├── LICENSE
└── .gitignore
```

部署后真正生效的是复制到 `%USERPROFILE%\.openclaw\keyword-router\` 的那一份，**不是这个解压目录**。

## 更新 / 卸载

| 场景 | 做法 |
| --- | --- |
| 只改关键词 | 直接改线上 `routes.json`，保存即生效 |
| 更新插件代码 | 解压新版 → 跑 `install.ps1` → 重启网关（`routes.json` 不会被覆盖） |
| 卸载 | `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Remove` → 重启网关 → 删目录 |

## 常见问题

| 现象 | 原因 |
| --- | --- |
| 发关键词还是走大模型 | 网关没重启 / 漏了 `allowConversationAccess` / `plugins.load.paths` 路径不对 |
| `openclaw config validate` 报 `plugin manifest not found` | `~/.openclaw/extensions/` 下有残缺插件目录（缺 `openclaw.plugin.json`），会让整份配置 invalid，把它挪出去 |
| 插件没加载 | `plugins.allow` 一旦非空就是白名单，必须把 `keyword-router` 加进去；`plugins.deny` 优先于一切 |
| ps1 报 `字符串缺少结束符` | 脚本是 UTF-8 **无 BOM**，PowerShell 5.1 按 GBK 读了。另存为「UTF-8 带 BOM」 |
| 中文乱码 | 默认 `"encoding": "auto"` 会自动识别 GBK/UTF-8；个别工具手动写 `"encoding": "gbk"` |
| 回复被截断 | `settings.maxReplyChars` 默认 4000 |
| 命令太慢 | `settings.timeoutMs` 默认 20s，超时会连进程树一起杀掉 |

## 安全提醒

- 关键词规则 = **能在这台电脑上执行命令**。能给这个微信号发消息的人，就能操作你的电脑。
- 强烈建议在 `routes.json` 里配 `settings.onlySenders`（只认你自己的 senderId）。
- 不要把 `{{text}}` 拼进 `cmd /c {{text}}` 这种直接把用户输入当命令的位置。
- **不要把 `%USERPROFILE%\.openclaw\openclaw.json` 提交到仓库**——里面有网关 auth token。

## License

[MIT](LICENSE)
