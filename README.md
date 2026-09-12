# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)

**简体中文** · [English](README_EN.md)

**DeepSeek Harness 的 MCP 服务与技能管理插件。** 一个设置面板管好四件事：

- **MCP**：连接了哪些服务、每个服务有哪些工具、哪些工具该让模型用——增删改查、启停、重启，全部即改即生效；
- **Skills**：本机各处的技能（DSH / Agents / Codex / Claude / 项目级 / 你自己指定的任意目录）一目了然，逐个或整组启停、创建、导入、回收；
- **AGENTS.md**：管理多套全局指令基线预设，一键「应用」写入 `~/.dsh/AGENTS.md`，新会话生效、当前会话不变；
- **History**：已归档会话统一管理，按项目分组、批量恢复/删除，对话导入/导出，保留期自动清理。

不手改 `cordis.patch.yml`，不碰任何技能源文件，重启与升级后配置依旧。

---

<!-- 图片占位 1：MCP 管理页截图 → docs/images/mcp.png -->

![MCP 管理](https://raw.githubusercontent.com/ouli-1242/dsh-plugin-tool-management/main/docs/images/mcp.png)

<!-- 图片占位 2：Skills 管理页截图 → docs/images/skills.png -->

![Skills 管理](https://raw.githubusercontent.com/ouli-1242/dsh-plugin-tool-management/main/docs/images/skills.png)

<!-- 图片占位 3：AGENTS.md 预设页截图 → docs/images/agents-md.png -->

![AGENTS.md 预设](https://raw.githubusercontent.com/ouli-1242/dsh-plugin-tool-management/main/docs/images/agents-md.png)

<!-- 图片占位 4：History 归档会话页截图 → docs/images/history.png -->

![History 归档会话](https://raw.githubusercontent.com/ouli-1242/dsh-plugin-tool-management/main/docs/images/history.png)

## 核心亮点

| 能力 | 说明 |
|---|---|
| 工具级开关 | MCP 服务器内的**单个工具可独立启停**：模型看不见也调不到，随时恢复；整台服务器还支持批量启停 |
| 重启语义 | 重启只重连、**不改变启停状态**（对已停用的服务执行重启不会意外启用它） |
| 密钥安全 | `env` / `headers` 中的密钥**默认打码**、URL 查询串遮蔽；查看明文与所有写操作一样受 token 保护 |
| 写入保护 | 每次改写补丁前自动留 `.bak` 时间戳备份（保留 5 份）；重复 loader id 写前拦截、跨级迁移失败自动回滚 |
| 备份恢复 | JSON 导入支持 `overwrite` 覆盖同 id 条目，不再只能跳过 |
| 技能来源 | 接入 `~/.agents` / `~/.codex` / `~/.claude` 三个官方不加载的技能目录，并支持**自定义任意技能目录**（只读接入、重叠拒绝） |
| 技能操作 | 创建技能、ZIP/文件夹导入、插件回收站（恢复 / 永久删除 / 系统回收站兜底）、系统编辑器打开源文件 |
| 即时刷新 | 技能目录由后台线程监听，编辑器里改完技能页面自动刷新 |
| AGENTS.md 预设 | 多套全局指令基线预设库：新建 / 导入 / 编辑 / 应用 / 删除；「应用」写入 `~/.dsh/AGENTS.md`（新会话生效，当前会话不变） |
| 会话归档管理 | History 页按项目分组展示已归档会话：搜索、全选、批量恢复 / 永久删除、保留期自动清理（改保留期后倒计时以修改时间为基准重置） |
| 对话导入 / 导出 | 从 Claude Code / Cursor（JSONL）、Codex（Markdown）、任意文本无痛接管对话；导出可选会话范围，目录默认桌面，支持 Markdown / JSONL |
| 斜杠命令 | 聊天框直接输入 `/mcp`、`/skills`、`/agents-md` 查看状态 |
| 模型工具 | **7 个**：`skill_mcp_manager_*` 管 MCP，`skill_manager_*` 管技能（创建前需用户确认） |
| 界面 | 独立的 `dsm-*` 设计系统，四页风格统一 |

## 快速开始

前置：已装好 DSH（`dsh web` 可运行），Node.js ≥ 18。

```sh
# 安装（装包 + 自动挂载）
dsh plugin --profile web add dsh-plugin-tool-management@latest

# 更新：重复执行同一命令
# 卸载：
dsh plugin --profile web remove dsh-plugin-tool-management
```

装完硬刷新浏览器（Cmd/Ctrl+Shift-R），设置里出现 **MCP**、**Skills**、**AGENTS.md** 与 **History** 四页即安装成功（客户端改动由 DSH 热加载，无需重启）。

也可以直接对任意 DSH 会话说：

```text
安装 dsh-plugin-tool-management 插件：
dsh plugin --profile web add dsh-plugin-tool-management@latest
装完提醒我硬刷新浏览器。
```

## 功能指南

### 管 MCP 服务

- **接入一个服务**：「新增服务」填 `serverName`（1–32 位 `[A-Za-z0-9_-]`，全局唯一）、传输方式与对应字段，选项目级或全局。写入的是 `cordis.patch.yml` 的 loader 行，HMR 自动生效。
- **看清现状**：每张卡片实时显示启停状态、loader 加载阶段与已注册工具数；页面顶部是统计卡，重复 loader id 这类会导致 DSH 起不来的问题会直接告警。
- **只关掉某个工具**：「详情」弹窗里逐个停用工具——比如模型总是乱调的搜索工具，停掉后它的 schema 从模型视野消失、调用也会被拦截，随时可恢复。
- **换密钥不泄露**：默认所有形似密钥的值显示为 `••••••`，排查问题时再点「显示密钥」。
- **迁移与备份**：编辑可改 serverName 甚至跨项目级/全局迁移（失败自动回滚）；JSON 导出/导入用于整份备份与换机。

### 管技能

- **看全貌**：按来源分组列出所有技能——项目级、运行时、内置、插件自带，以及四个用户目录（`~/.dsh` / `~/.agents` / `~/.codex` / `~/.claude`，后三个由本插件接入）和你自己添加的自定义目录。
- **启停**：单个技能、整个来源、整个项目，随时切换；实现是 override provider 的遮蔽策略，源文件一个字节都不动，换机或重装只要复制状态文件。
- **自定义目录**：点「添加目录」输入绝对路径，该目录即成为只读技能来源——适合管理散落在仓库、网盘同步目录里的技能合集；与已有来源重叠的路径会被拒绝，避免遮蔽失效。
- **创建与导入**：表单直接创建；ZIP、`.md`、技能文件夹拖进来就能装；删除先进回收站，可恢复，永久删除前还会尝试移入系统回收站兜底。

### 管 AGENTS.md 预设

- **预设库**：新建、导入、编辑多套全局指令基线（如不同团队的 coding standard 或不同角色的行为规范）。
- **应用即写入**：「应用」把选中预设写入 `~/.dsh/AGENTS.md`，**新会话生效、当前会话不变**；编辑后点「重新应用」即可同步最新内容，删除前请先切换到其他预设。

### 管历史会话

- **按项目分组**：归档会话按工作区自动分组展示，搜索标题 / 会话 ID / 项目路径快速定位；工作区目录已不存在的会话会打上 ⚠ 标记。
- **批量操作**：「全选」后批量恢复或永久删除；恢复的会话回到工作区列表，删除会连同其子代理子会话一并清理。
- **保留期**：顶部下拉选择自动清理周期（0 = 永久保留），到期自动清除；修改保留期后，所有会话的倒计时以修改时间为基准重新计算。
- **导入对话**：无痛接管其他工具的会话——Claude Code / Cursor 的 JSONL、Codex 的 Markdown、以及任意文本格式，导入后即可继续对话。
- **导出对话**：按会话范围（全部 / 仅归档 / 按工作区）导出，每个会话一个 Markdown 或 JSONL 文件；导出目录默认桌面，旁边带「选择文件夹」按钮弹出目录树，逐级浏览选中后自动回填绝对路径。

### 让模型和脚本参与管理

| 入口 | 能做什么 |
|---|---|
| `/mcp`、`/skills`、`/agents-md` | 聊天框查看当前状态 |
| `skill_mcp_manager_list / set_enabled / restart / add` | 模型查询与操作 MCP 服务 |
| `skill_manager_list / set_enabled / create` | 模型查询与操作技能（创建前会征求你同意） |
| `POST /dsh-plugin-tool-management/api` | 脚本调用的 HTTP API（`{op, args}` 协议） |

## 配置与安全

插件 loader 行支持以下可选字段（`dsh plugin add` 会自动插入，一般无需手写）：

| 字段 | 说明 |
|---|---|
| `token` | 可选访问令牌。设置后**所有写操作与「显示密钥」**都要求 `x-dsh-token` 请求头。客户端从 localStorage 读取（键 `dsh-plugin-tool-management-token`，DevTools Console 设置后刷新即可），也可用环境变量 `DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN`。 |
| `maxBodyBytes` | 请求体上限，默认 88 MiB（技能 ZIP 上传需要）。 |

关于为什么需要 token：插件的跨站防护（POST-only + 自定义头 + 同源校验）默认「DSH 只监听本机」。如果你把端口转发到局域网/公网，token 就是防止陌生人注入 MCP 命令（等同远程执行）与窃取明文密钥的最后防线——本地单机使用可不配置。

## 数据落点

| 内容 | 位置 |
|---|---|
| MCP 服务器定义 | `profiles/<profile>/cordis.patch.yml`（项目级）或 `~/.dsh/cordis.patch.yml`（全局），改写前自动 `.bak` |
| 服务器备注 / 页面设置 / 工具停用列表 / 导出 | DSH 主目录下的旁路 JSON（`skill-mcp-manager-*.json`） |
| 技能启停策略 / 自定义目录 | `~/.dsh/tool-management/state.json` |
| 技能回收站 / 导入暂存 | `~/.dsh/tool-management/trash`、`uploads` |
| AGENTS.md 预设库 / 应用结果 | 插件目录 `data/agents-md-presets/`；「应用」写入 `~/.dsh/AGENTS.md` |
| 归档会话账本 / 保留期 | 插件目录 `data/history-archived-at.json`、`data/history-retention.json` |
| 运行日志 | `~/.dsh/dsh-plugin-tool-management.log`（滚动） |

## 常见问题

| 现象 | 解决 |
|---|---|
| 装完设置里没有页面 | 硬刷新；不行就重启 DSH。 |
| 出现重复的 MCP 页签 / 工具 | 与旧 loader 行双挂载，删掉 `cordis.patch.yml` 里的旧条目后重启。 |
| 改坏了配置 DSH 起不来 | 同目录取最近的 `cordis.patch.yml.bak-<时间戳>` 恢复。 |
| 页面数据不刷新 | 等待页面自动轮询（默认 5 秒）；或手动点「刷新」。 |
| 镜像源装不到最新版 | 加 `--registry=https://registry.npmjs.org` 稍后再试。 |

## 开发

```bash
npm install
npm test             # 构建 + 全量测试（node:test，约 1 秒）
npm run test:fast    # 跳过构建直接跑测试
npm run build        # 仅构建（tsc + 同步客户端 bundle）
```

结构：宿主端 `src/index.ts`（Cordis 对象插件，`lib/index.js` 为发布产物）；技能核心 `src/skills/core.js`（纯 Node，可独立单测）；AGENTS.md 预设库 `src/agents-md/service.ts`；归档会话管理 `lib/history/`（`workspace.js` / `projcache.js` / `tombstone.js`）；对话导入解析 `src/imports/parsers.js`；浏览器端 `src/client.js`（ModuleLoader CJS bundle，`dsm-*` 设计系统，经同源 API 与宿主通信）。运行时依赖仅 `fflate`（ZIP 解压）。

发布：`npm version patch && npm publish`（`prepublishOnly` 自动构建）。

## 许可证

MIT
