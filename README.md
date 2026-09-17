# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)
[![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-%E5%B7%B2%E6%94%B6%E5%BD%95-3fb950)](https://awesome-dsh-plugin.com)
[![dshfind](https://dshfind.com/api/badge/ouli-1242/dsh-plugin-tool-management?lang=zh)](https://dshfind.com/zh/plugins/ouli-1242/dsh-plugin-tool-management)

**简体中文** · [English](README_EN.md) · [Changelog](CHANGELOG.md) · [版本更新概要](docs/update.md)

- DeepSeek Harness 的 **MCP、技能、场景、记忆、子智能体、提示词与归档会话**管理插件。
- 八个页签：**场景**、**MCP**、**技能**、**子智能体**、**提示词**、**记忆**、**会话**、**兼容**。

```sh
dsh plugin --profile web add dsh-plugin-tool-management@latest
```

装完硬刷新浏览器（Cmd/Ctrl+Shift-R），设置 → **工具** 即安装成功。不手改 `cordis.patch.yml`，不碰技能源文件，重启与升级后配置依旧。

---

## 截图

|                              |                                |
|:----------------------------:|:------------------------------:|
| ![场景](docs/images/1.png)   | ![MCP](docs/images/2.png)      |
| **场景**                     | **MCP**                        |
| ![技能](docs/images/3.png)   | ![子智能体](docs/images/4.png) |
| **技能**                     | **子智能体**                   |
| ![提示词](docs/images/5.png) | ![记忆](docs/images/6.png)     |
| **提示词**                   | **记忆**                       |
| ![会话](docs/images/7.png)   | ![兼容](docs/images/8.png)     |
| **会话**                     | **兼容**                       |

## 核心亮点

一句话：**把「工作 / 写作 / 编程」各配成一套场景，点一下整套切换；插件管的东西，模型都看得见。**

| 亮点                        | 说明                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一键换场景                  | 每个场景各配一套：用哪些 MCP 服务器、哪些技能、哪些人设、哪些记忆；点一下整套切换，关掉自动还原                                                               |
| 记忆自动送到模型眼前        | 每个场景下写几段 `.md` 就是它的资料库，正文自动进上下文，不用每次复制粘贴                                                                                     |
| 给 MCP 服务器写备注         | 像「A 不可用时改用 B 兜底」这种话写进备注，模型看得到，会照做                                                                                                 |
| 单个工具也能关              | 一台服务器里只停掉某个工具，模型看不见也调不到；「重启」只重连，不会偷偷改变开关                                                                              |
| 技能状况一眼看穿            | 哪些在生效、哪些被同名技能覆盖、哪一份是首选，都标得清清楚楚                                                                                                  |
| 子智能体 = 一个文件一个角色 | 写一份角色说明就能派活；跑完只回结果、不占你的会话记录；哪些角色能用还能按场景定                                                                              |
| 提示词备好几套              | AGENTS.md 可以存多份（简洁模式 / 教学口吻……），一键切换；场景可以各自绑一份                                                                                   |
| 会话不再丢                  | 归档按项目分组、能搜、能批量恢复；Claude Code / Cursor / Codex 的聊天记录都能导进来                                                                           |
| 模型一定看得见              | 插件管的内容（记忆 / MCP / 技能 / 子智能体 / 提示词）会主动告诉模型，每个域各发一条、内容没变不重复；极简模式下默认不注入（跟随预设），可在「兼容」页逐项打开 |
| 锁住就不怕手滑              | 场景可以上锁：五个域整体只读，先解锁才能改                                                                                                                    |
| 删了能找回，配好能带走      | 删除都进回收站，随时恢复；技能 / 记忆 / 人设 / 提示词都能勾选打包成 zip，也能再导回来                                                                         |
| 安全、不添乱                | 密钥默认打码、看明文要令牌；只写自己的文件，技能源文件一个不动，升级重启配置都在                                                                              |

## 快速开始

前置：DSH 已安装（`dsh web` 可运行），Node.js ≥ 18。

```sh
dsh plugin --profile web add dsh-plugin-tool-management@latest   # 安装 / 更新
dsh plugin --profile web remove dsh-plugin-tool-management        # 卸载
```

装完硬刷新浏览器，设置 → **工具** 出现八栏即成功。客户端改动热加载，宿主侧改动需重启 `dsh web`。

也可以让模型代劳：

```text
安装 dsh-plugin-tool-management 插件：
dsh plugin --profile web add dsh-plugin-tool-management@latest
装完提醒我硬刷新浏览器。
```

模型可用 14 个工具管理上述功能（`mcp_manager_*` / `skill_manager_*` / `prompt_manager_*` / `memory_manager_*` / `subagent_manager_*`）；脚本走 `POST /dsh-plugin-tool-management/api`（`{op, args}` 协议）。

---

## 功能

### 场景与记忆

- **场景 = 分组，记忆 = `.md` 文件**。`memories/<场景>/<名>.md`，整篇正文自动注入上下文，文件名支持中文。
- **单选启用**：同时只启用一个场景（其余置灰），关掉全部 = 只注入「全局」与 `_shared`。新场景默认不启动。
- **场景绑提示词**：切换场景直接改写 `~/.dsh/AGENTS.md`（覆盖前 5 代备份，关掉自动恢复基线）；预设挂不到官方 AGENTS.md 通道时（极简），改为把这份正文直接注入上下文。
- **场景档案**：每个场景搭配 MCP 工具集 / 技能集 / 子智能体 / 记忆（任意组合）；打开场景即应用并收窄注入，关闭按快照原文恢复（开关是唯一入口）。勾选集语义：**勾的启用、没勾的停用，整段没建 = 一个都没勾 = 该域全部停用**（所以「没配 MCP 工具集」的场景进去就是全部 MCP 停用，退出再开回来）。**场景内这四个域（含提示词）的开关照常可用**——这里的改动会同步写进该场景的档案（当下生效、下次进这个场景照旧生效），只有**锁定**才冻结；记忆域的开关本来就是单一真相源，不经过档案。
- **导入**：`.md` / `.zip`（目录名 = 场景，bundle 带附件），同名跳过绝不覆盖，超限逐条回报。
- **导出**：勾选记忆打包成 zip，保留「场景/名称」层级；bundle 型连目录里的附件一起打进去。只读源文件。
- **注入预算**：默认 64 KiB，放不下的跳过并列出清单。删除进回收站。
- **场景锁定**：锁定后 MCP / 技能 / 子智能体 / 记忆 / 提示词整体只读，界面禁用 + 服务端守卫双侧拦截；未启动不能上锁，锁定中不能关闭，先解锁再改。
- **删除场景 = 连记忆一起删**：场景记录、档案与全部记忆进同一条回收站条目，恢复按原路径整条放回；使用中的场景拒绝删除。场景名可改（连带目录与档案，记忆正文不动）。

### 子智能体

- **一个文件一个人设**：`agents/<人设>.md`，frontmatter 全可选。
- **工具限制按 Agent 预设**：每个预设一份白/黑名单（互相排斥），运行期按当前预设生效——堵掉旧「全体并集」名单换预设后子代理起不来的坑。
- **即用即弃**：`subagent_manager_run` 带人设运行、只回传结果、不进 History，自动继承场景记忆。场景可绑定可用人设。
- **启停开关**：停用的人设不注入上下文、模型不可见（文件不动）；新建 / 导入 / 恢复自动启用。**进场景按档案勾选集全量对齐**（勾了的开、没勾的关，整段没建 = 全关），退出按进场景前的开关精确还原；场景内这个开关照常可用，改动会同步写进该场景的档案（只有**锁定**才冻结）；退出场景时回到进场景前的状态。
- **人设目录自动注入**：只列名字 + 描述，模型知道有哪些人设可委派；人设名可改，场景绑定自动跟着改。

### MCP 服务

- **增删改查 + 即改即生效**：写入 `cordis.patch.yml`，HMR 自动生效。
- **工具级开关**：单个工具可独立停用（模型看不见也调不到），整台支持批量。
- **停着也能看清单**：服务器没在跑时仍显示上次见过的工具名与描述（标「上次运行时」）；从没跑过的可以一键「启动服务器读取工具」。
- **密钥打码**：默认 `••••••`，「显示密钥」要令牌。
- **迁移与备份**：跨项目级/全局迁移失败自动回滚；JSON 导出导入。
- **状态与备注自动注入**：只列当前真正可用的 server，你的备注作为决策提示带给模型；级别分「全局 / 应用级」，新增默认全局。注：极简这类压制型预设默认不注入（模型可用 `mcp_manager_list` 读取服务器名、启停、工具数与备注）——想让它也注入，到「兼容」页的「注入」块打开开关。

### 技能

- **来源一览**：项目级 / DSH / Agents / Codex / Claude / 自定义目录，按来源分组。
- **两组权限相反**：默认来源（DSH / 导入技能）必须读取但技能可删；外部目录可停用/移除但技能只读。
- **移除 ≠ 停用**：移除 = 连目录都不扫（文件零改动，可恢复）；停用 = 仍列出但不可调用。
- **同名技能一眼看出谁在生效**：真实生效的那份标「首选」，被同名覆盖的标出来源；启用被覆盖的副本会明说「这样不会生效」。
- **自定义目录 / ZIP 导入导出 / 回收站**。
- **目录可注入**：预设没挂官方技能目录行（如极简）时，由本插件的注入域按「兼容」页的开关兜底送达（名字 + 简介；正文照旧读文件）。

### 提示词预设

- 多套 `~/.dsh/AGENTS.md` 基线，一键应用（宿主每轮重读该文件，下一轮对话生效），保留 5 代备份。
- **记得「最近一次应用的是哪份」**：就算你手改过 `AGENTS.md`，模型问「现在用的哪份预设」也答得出来源（会注明「此后文件有变」）。
- **描述**：每条预设可写一句「这份是干什么的」，只显示在插件界面里；它存在同目录的 `meta.json`，不进 AGENTS.md，也就不会被注入上下文。
- 新建即可写正文，编辑可改 id（= 目录改名，场景绑定自动跟着改）。**被引用的不能删**（场景绑定 / `AGENTS.md` 当前内容 / 退出场景要恢复的那一份），删除进回收站。
- **正文可注入**：预设没挂官方 AGENTS.md 行（如极简）时，`~/.dsh/AGENTS.md` 的正文由本插件的注入域兜底（64 KiB 上限；可在「兼容」页关掉）。
- **场景接管期间「应用」只对场景绑定的那一份可用**（应用别的预设会绕过场景绑定，正是「显示 A、实际注入 B」的来源）；要换提示词请到场景页改绑定，或先退出场景。

### 历史会话

- 按项目分组、搜索、批量恢复 / 永久删除、保留期自动清理。
- 工作区登记被删后按会话目录重建分组，可一键重新登记。
- 导入 Claude Code / Cursor / Codex / 任意文本；导出 Markdown / JSONL。

### 宿主兼容

插件运行期用宿主同一批 `@deepseek-ai/*` 库——必须是同一份物理模块，否则判断退化成猜。

- **「兼容」页**：宿主版本、能力可用数、每个动作走原生/适配/不可用、降级项与原因。只读。
- **命令行**：`node scripts/doctor.mjs`（体检）、`node scripts/host-deps.mjs --fix`（依赖对齐）、`npm run sync:profile`（把构建产物镜像到 profile 里那份本地安装 —— `file:` 装的是硬链接拷贝，构建新增的文件不会自动过去）。
- `minimal` 这类**压制型预设**（persona `complete` / 关闭运行时上下文）下，本插件的注入**默认停用**（跟随预设的设计意图），提示词与技能也因官方那两行没挂而缺席 —— 兼容页逐列标出，同一页的「注入」块可以按域强制打开。

---

## 数据落点

| 内容                                        | 位置                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| MCP 定义                                    | `~/.dsh/cordis.patch.yml`（插件只写它；改前自动备份到 hub 的 `backups/`） |
| 技能策略 / 自定义目录                       | `~/.dsh/tool-management/skills-state.json`                                |
| 技能 / 记忆 / 人设 / 预设                   | `~/.dsh/tool-management/{skills,memories,subagents,prompts}/`             |
| 子智能体启停                                | `~/.dsh/tool-management/subagents-index.json`                             |
| 回收站                                      | `~/.dsh/tool-management/trash/{skills,subagents,prompts,scenes}-trash/`   |
| 归档账本 / 保留期                           | `~/.dsh/tool-management/history-*.json`                                   |
| 记忆索引 / 场景 / 档案                      | `~/.dsh/tool-management/memories-index.json`                              |
| MCP 侧车（停用表 / 已知工具 / 备注 / 设置） | `~/.dsh/tool-management/mcp-*.json`                                       |
| 注入设置（五个域开关 / 压制型预设口径）     | `~/.dsh/tool-management/inject-settings.json`                             |
| 运行日志 / patch 备份                       | `~/.dsh/tool-management/tool-management.log` · `backups/`                 |

**插件安装目录里不存用户数据**（`dsh plugin update` 会整体替换该目录）。

## 配置与安全

| 字段           | 说明                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `token`        | 访问令牌。设了之后**所有写操作 + 明文密钥**都要求 `x-dsh-token`；**不设时明文接口一律关闭**。也是 curl / 局域网的逃生门。 |
| `maxBodyBytes` | 请求体上限，默认 88 MiB。                                                                                                 |

- **浏览器**：读写走 cookie，不需要 token；但**明文密钥**（显示密钥 / 导出）要令牌。
- **curl / 脚本**：带 `x-dsh-token`，或带浏览器 cookie。
- **端口转发到公网**：建议配 token——防陌生人注入 MCP 命令（等同远程执行）与窃取密钥。

## 常见问题

| 现象                                      | 解决                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 装完没有页面                              | 硬刷新；不行重启 DSH。                                                                              |
| 重复 MCP 页签                             | 删 `cordis.patch.yml` 里的旧 loader 行后重启。                                                      |
| 改坏配置 DSH 起不来                       | 取最近的 `.bak-<时间戳>` 恢复。                                                                     |
| 升级 DSH 后动作不可用                     | 设置 → 工具 → **兼容** 看原因；`doctor.mjs` → `host-deps.mjs --fix`。                               |
| `approval=never` 还要确认吗               | 不弹卡，直接放行并记日志；想问回来切回「工作区内修改」。                                            |
| `subagent_manager_run` 报 spawn 不可用    | 宿主没注册 spawn provider；挂载 `@deepseek-ai/dsh-subagent-spawn-in-process` 后重启。               |
| 场景绑了 A 人设，官方 `subagent` 还跑别的 | 两条通道：本插件只管 `subagent_manager_run`；官方 `subagent` / `subagent_fork` 无确认门、不认人设。 |

---

## 开发

```bash
npm install
npm run build        # tsc + 同步客户端
npm test             # 构建 + i18n + 冒烟测试（装配与渲染不抛错）
npm run check:i18n   # 词典自检
npm run doctor       # 宿主兼容体检
```

`lib/` 不入版本库，克隆后先 `npm run build`。改完重启 `dsh web` 才生效。运行时依赖仅 `fflate`；`@deepseek-ai/*` 一律用宿主那份。

## 许可证

MIT
