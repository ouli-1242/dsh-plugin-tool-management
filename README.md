# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

**简体中文** · [English](README_EN.md) · [Changelog](docs/Changelog.md) · [版本更新概要](docs/update.md)

**DeepSeek Harness 的 MCP、技能与记忆管理插件。** 一个「工具」面板，八个页签管好五件事：

- **MCP** —— 连了哪些服务、各有哪些工具、哪些该让模型用：增删改查、启停、重启，即改即生效；
- **Skills** —— 本机各处的技能（DSH / Agents / Codex / Claude / 项目级 / 任意自定义目录）一览，逐个或整组启停、创建、导入、回收；
- **AGENTS.md** —— 多套全局指令基线预设，一键应用写入 `~/.dsh/AGENTS.md`；
- **History** —— 归档会话按项目分组管理，批量恢复 / 删除，对话导入导出，保留期自动清理；
- **场景记忆** —— `memories/<场景>/<名>.md` 一个文件夹一个场景，启用场景里的记忆正文**整篇进系统提示词**，不用每次重复解释。

不手改 `cordis.patch.yml`，不碰任何技能源文件，重启与升级后配置依旧。

```sh
dsh plugin --profile web add dsh-plugin-tool-management@latest
```

装完硬刷新浏览器（Cmd/Ctrl+Shift-R），设置里出现 **工具** 面板即安装成功。

## 截图

![场景](docs/images/1场景.png)

![MCP 管理](docs/images/2MCP.png)

![技能](docs/images/3技能.png)

![子智能体](docs/images/4子智能体.png)

![AGENTS.md 预设](docs/images/5提示词.png)

![记忆](docs/images/6记忆.png)

![会话](docs/images/7会话.png)

![宿主兼容](docs/images/8兼容.png)

## 核心亮点

| 能力 | 一句话 |
|---|---|
| 宿主兼容 | 「兼容」页做只读体检：模块实体是否与宿主同一份、每个动作走原生入口还是插件适配层、哪些能力已降级及原因 |
| 预设注入边界 | 每个 Agent 预设下「记忆 / AGENTS.md / 技能目录」到不到得了模型，兼容页逐列标出；被压制时模型工具自己声明边界，不让模型误以为已读正文 |
| MCP 工具级开关 | 单台服务器里的**单个工具**可独立启停：模型看不见也调不到，随时恢复；整台服务器支持批量启停 |
| 重启语义 | 重启只重连，**不改变启停状态**（对已停用的服务执行重启不会意外启用它） |
| 密钥安全 | `env` / `headers` 里的密钥默认打码、URL 查询串遮蔽；「显示密钥」只接受同源请求或持有效 token 的本地调用 |
| 写入保护 | 改写补丁前自动留时间戳 `.bak`（保留 5 份）；重复 loader id 写前拦截；跨级迁移失败回滚；AGENTS.md「应用」同样保留 5 代 |
| 技能来源 | 接入 `~/.agents` / `~/.codex` / `~/.claude` 与任意自定义目录（只读接入、重叠拒绝）；插件自有落点 **「导入技能」** |
| 技能权限 | 两组来源权限正好相反：默认来源**必须读取**（不可移除 / 停用）但**里面的技能可删**；外部与自定义目录**可停用 / 移除**但**里面的技能只读** |
| 技能操作 | 创建、ZIP / 文件夹导入、回收站（恢复 / 永久删除）、系统编辑器打开源文件；目录后台监听，改完自动刷新 |
| AGENTS.md 预设 | 多套全局指令基线：新建 / 导入 / 编辑 / 应用 / 删除；「应用」写入 `~/.dsh/AGENTS.md`（新会话生效，当前会话不变） |
| 归档会话 | 按项目分组、搜索、全选、批量恢复 / 永久删除、保留期自动清理；工作区登记被删后可按目录重建分组并一键重新登记 |
| 对话导入 / 导出 | 接管 Claude Code / Cursor（JSONL）、Codex（Markdown）、任意文本；导出 Markdown / JSONL，目录默认桌面 |
| 场景记忆自动注入 | 启用场景里的 `.md` 正文自动进系统提示词（per-agent `systemPrompt` 段），模型无需工具调用，**下一个请求即生效**；保留场景「全局」恒定注入 |
| 记忆管理 | 导入 `.md` / `.zip`（目录名即场景、bundle 带附件）、逐条启停、回收站；注入预算可见，放不下的只跳过并列出清单 |
| 场景档案 | 每个场景自由搭配 **MCP 工具集 / 技能集 / 子智能体绑定 / 记忆**；勾了工具或技能的场景可「切入此模式」，退出按快照**原文**恢复 |
| 轻量子智能体 | `agents/<人设>.md` 一个文件一个人设；`subagent_list` / `subagent_run` 即用即弃、不进 History，自动继承当前启用场景的记忆 |
| 前缀缓存友好 | 注入段文本只由「启用场景 + 文件内容」决定，逐字节稳定；切换场景或编辑记忆只变化一次 |
| 模型工具 | **14 个**，五组前缀：`skill_mcp_manager_*`（4）、`skill_manager_*`（3）、`agentsmd_*`（2）、`rule_manager_*`（3）、`subagent_*`（2）；三个确认门都识别会话审批策略 |
| 界面 | 自有 `dsm-*` 设计系统，**八栏**（场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话 / 兼容），中英双语、跟随宿主语言 |

## 安装与更新

前置：已装好 DSH（`dsh web` 可运行），Node.js ≥ 18。

```sh
# 安装 / 更新（同一条命令；装包 + 自动挂载）
dsh plugin --profile web add dsh-plugin-tool-management@latest

# 卸载
dsh plugin --profile web remove dsh-plugin-tool-management
```

装完硬刷新浏览器（Cmd/Ctrl+Shift-R），设置里出现 **工具** 面板（八栏）即安装成功。客户端改动由 DSH 热加载，无需重启 `dsh web`；**宿主侧改动需要重启** `dsh web` 才生效。

也可以直接对任意 DSH 会话说：

```text
安装 dsh-plugin-tool-management 插件：
dsh plugin --profile web add dsh-plugin-tool-management@latest
装完提醒我硬刷新浏览器。
```

## 功能指南

### 场景与记忆

> 场景 = 分组维度，记忆（`.md`）= 内容。场景可挂「档案」：MCP 工具集 / 技能集 / 子智能体绑定 / 记忆，四段自由搭配。
> 数据统一在 `~/.dsh/tool-management/`（见 [数据落点](#数据落点)）。

- **场景是显式记录**：`memories/<场景>/` 是它的记忆目录，场景本身带**描述**与顺序（存在 `rules-index.json` 的 `scenes` 切片）。场景名支持任意 Unicode（≤64 字符，不含 `/ \ < > : " | ? *`，不以 `.` 开头，**单个路径段**）。`global` 是保留场景（界面「全局」），`_shared/` 是历史保留的公共场景。
- **新建场景**：点「新建场景」填名字与一句描述；也可以自己在 `memories/` 下 `mkdir`，效果一样（下次读取补上记录）。**空场景合法**——可以先建好场景再往里放记忆。**新场景默认不启动**。
- **每个 `.md` 就是一条记忆**：不用写 frontmatter，整篇正文都会注入。往场景文件夹里丢文件就生效，也可以在页面上「新建记忆」——**文件名支持中文**（如 `站会流程.md`）。归属不存在的场景会被明确拒绝（`场景不存在`），不静默造场景。
- **开关场景（单选）**：除保留场景「全局」外**同时只能启用一个场景**——启用一个之后，其它场景的开关会置灰，直到你把它关掉；关掉全部 = 只注入「全局」与 `_shared`。**新场景默认不启动**。启用场景目录树内所有 `.md` 的正文自动进系统提示词，**下一个请求即生效**，无需重开会话或重载插件。
- **场景可绑定一份提示词预设**：在场景表单里选一个（一个场景只能绑一个，**默认选中当前生效的那份**）。**切换场景会直接改写 `~/.dsh/AGENTS.md`**——把它绑定的那份预设写进去（覆盖前多代备份到 `agents-md/__last-applied__/`）；**关掉场景时恢复进场景之前的基线**（手写内容也原样回来）。改绑、或编辑正在生效的那份预设的正文，同样会同步写文件；「提示词」页把生效中的那份标成「生效中」，并且**它不能被删除**。绑定的预设被删掉时卡片会标「预设不存在」，不会静默改文件。「进入某个场景」（切入模式）会同时启用它，于是档案、记忆、提示词一起生效。
- **场景页只列可切换的预设场景**：保留场景 `global`（「全局」）与 `_shared/` 恒常生效、不在这页出现（历史保留名 `_shared/` 若存在则显示为「常开」卡片、没有开关）。
- **全局记忆**：保留场景 `global` 的记忆**任何对话都注入**（不吃场景开关；「记忆」页的全局分组上标**「常驻」**），适合放之四海皆准的偏好与约定。新建记忆时场景留空即落到这里。
- **导入记忆**：页头「导入记忆」支持 `.md` 与 `.zip`（可多选、可拖入）。zip 内带目录时**目录名即场景**（`工作/standup.md` → 场景 `工作`），**直接拖入文件夹同理**（多级目录保留为 `A/B`）；裸 `.md` 落到弹窗里选的场景——**留空 = 保留场景「全局」**。zip 内 `<场景>/<名>/SKILL.md` 按 **bundle** 导入（同层文件作附件；附件名非法 / 空 / 单个 >8 MB / 合计 >16 MB 逐条跳过并回报）。文件按原文落盘，**同名自动跳过并列出名单**（绝不覆盖）；被丢弃的内容一律**回报原因**，不做静默丢弃；导入引用到的场景若不存在会**自动补记录并在结果里列出**。
- **记忆 = 一个 Markdown 文件**：`<场景>/<名>.md`（flat）或 `<场景>/<名>/SKILL.md`（bundle）。新建时选场景、填名称（= 文件名）、描述与正文，frontmatter 全部可选，缺失时自动派生。
- **bundle 附件**：形态选 bundle 时可直接添加附件（多选，单个 ≤8 MB、单次 ≤16 MB / 32 个）；附件存在记忆目录里，**不会进入提示词**（只有 `SKILL.md` 正文注入），编辑时可逐个移除。flat 是单文件，没有目录可放附件。
- **启停与回收**：逐条启停（停用的记忆仍留在磁盘上，只是不进提示词）、编辑、移入回收站；页头「回收站」可**恢复**或**永久删除**（有二次确认）。`enabled` 等状态存在侧车索引里，绝不回写记忆文件。
- **注入预算可见**：页头下方常驻一条预算条（已用 / 上限字节），超限变红。默认上限 64 KiB；**某条记忆放不下时只跳过它**，继续装后面放得下的，段尾附「未注入（超出预算）」清单——模型与用户都能看到哪些记忆这次没进提示词。
- **场景页排版**：场景排成**卡片网格**（窄于 640px 单列）。每张卡片只有四样：名字（+ 磁盘目录名 + 状态标签 + 开关）、**一行描述**、动作按钮（「切入此模式」只在有档案时出现；右侧是「档案 / 改描述 / 删除场景」）。描述上限 **60 字**（输入框就限住，卡片上超长省略、全文在悬浮提示里）——卡片里**不堆任何数量**，「现在生效的是什么」只由页首「当前模式」条讲（**只有真进入模式后才出现**，没有条 = 没进任何模式）。
- **场景档案（四段自由搭配）**：卡片上「档案」打开编辑器，四段各自独立「添加 / 移除」——**MCP 工具集**（两级勾选：先勾服务器，不勾 = 整台停用，勾了但一个工具都不勾 = 该服务器全停）、**技能集**（只列实时发现的条目，勾 = 启用）、**子智能体绑定**（勾人设名单，全不选 = 不限制）、**记忆**（**只列被编辑场景自己的记忆**，可筛选；**只影响注入**，文件与内容一律不动——全局记忆恒定注入、别的场景的勾了也不生效，所以都不在这里出现）。**新添加的段默认一项都不勾**：记忆段只预勾**本场景里已启用**的那几条，其余三段是空集（MCP / 技能 / 记忆段空集 = 该域全部停用，子智能体段空集 = 不限制，段脚注写明这句话）；「全选」= 本场景全部。编辑器顶部有筛选框，记忆描述按 80 字截断（全文在悬浮提示里），弹窗固定高度、加减段不跳动。
- **场景模式**：勾了工具或技能段的场景出现「切入此模式」——**进入 = 快照当前启停 → 先落盘快照 → 应用勾选集 → 记忆收窄到该场景**；「退出」按快照**原文**恢复（模式期间写进去的整台停用键随之消失）。运行中手动改动不会偷偷回写，点「保存到场景」才落盘。任一步失败自动回滚并如实上报（回滚未完成会写进错误文本，不谎报「已回滚」）。

### 子智能体（人设）

- **一个文件一个人设**：`~/.dsh/tool-management/agents/<人设>.md`，frontmatter 全部可选——`description`（何时调用，一句话即可）/ `provider` + `model`（模型路由，**两者是一对**：跨来源换模型必须都填；只填 `model` 会落在主会话的来源上）/ `tools` 白名单 / `toolsDeny` 黑名单，正文就是人设提示词。
- **高级选项**：模型与工具限制收在「高级选项」折叠区（已在用的人设自动展开）。模型是**下拉选择**（宿主 LLM 目录里的 `provider · model` 对，目录里没有的可切「自定义」手填）；工具白 / 黑名单是**勾选器**，候选是**全部 Agent 预设工具名的并集**并按预设分组展示——人设可能在任何预设下被复用，只列当前会话的工具会让换预设后的子代理启动失败（官方 `toolFilter` 对未知名直接拒绝启动）。
- **导入**：页头「导入」支持 `.md` 与 `.zip`（zip 内任意层级的 `.md` 都按文件名导入，**同名自动跳过并列出名单**）。
- **运行**：模型用 `subagent_list` 看清单、`subagent_run{agent, task}` 调用：子代理**带人设独立运行**、自动继承当前启用场景的记忆段、只把最终输出回传主模型（≤16 KiB），跑完即弃、不进 History。场景档案可绑定「本场景可用哪些人设」（绑定外调用报「人设不可用」）；运行默认弹确认（花的是真 token），设置 `requireConfirmForModelSubagentRun: false` 可关。
- **治理边界**：以上约束只覆盖 `subagent_run` 这一条通道——DSH 官方的 `subagent` / `subagent_fork` 是宿主能力，无确认门、也不认这套人设，任何模式下都不受本插件约束（见 [FAQ](#常见问题)）。人设不入回收站（删了就是删了），v1 也没有给人设写文件的模型工具。

### MCP 服务

- **接入一个服务**：「新增服务」填 `serverName`（1–32 位 `[A-Za-z0-9_-]`，全局唯一）、传输方式与对应字段（`streamable-http` → URL / headers；`stdio` → command / args / env），选项目级或全局。写入的是 `cordis.patch.yml` 的 loader 行，HMR 自动生效。
- **看清现状**：每张卡片实时显示启停状态、loader 加载阶段与已注册工具数；页面顶部是统计卡，重复 loader id 这类会导致 DSH 起不来的问题会直接告警。
- **只关掉某个工具**：「详情」弹窗里逐个停用工具——比如模型总是乱调的搜索工具，停掉后它的 schema 从模型视野消失、调用也会被拦截，随时可恢复。
- **换密钥不泄露**：默认所有形似密钥的值显示为 `••••••`，排查问题时再点「显示密钥」。
- **迁移与备份**：编辑可改 serverName 甚至跨项目级 / 全局迁移（失败自动回滚）；JSON 导出 / 导入用于整份备份与换机。

### 技能

- **看全貌**：按来源分组列出所有技能——项目级、运行时、内置、插件自带，以及四个用户目录（`~/.dsh` / `~/.agents` / `~/.codex` / `~/.claude`，后三个由本插件接入）和你自己添加的自定义目录。
- **启停**：单个技能、整个来源、整个项目随时切换；实现是 override provider 的遮蔽策略，源文件一个字节都不动，换机或重装只要复制状态文件。
- **默认来源必须读取**：`DSH 技能`（`~/.dsh/skills/`）与 `导入技能`（`~/.dsh/tool-management/skills/`）连「停用」也不允许——停用等于「读出来但不可调用」，与「路径不能不读取」冲突，服务端会拒绝且界面不渲染来源开关（这两行只显示「可管理」标记）。注意被锁的只有**来源层**：这两个来源**里面的技能照常可以删除**，两者互不影响。
- **移除来源**：与「停用来源」不同——停用仍会扫描并列出该来源的技能（只是不可调用），**移除则连目录都不再扫描**：技能从列表消失，也不参与同名优先级，模型侧（provider 候选）同样看不到。文件与目录**一个字节都不动**，随时可恢复；默认来源与项目级来源不可移除，界面上不显示该按钮。
- **同名技能自选**：多处出现同名技能时，默认按来源优先级自动取一个生效（其余显示「被覆盖」，无开关）；想改用某来源的版本，点该行「启用这个」即设为**同名首选**并启用——首选只写进状态文件（`preferredSkills`），不动任何源文件；赢家行可「取消首选」回到自动。来源整体停用时「启用这个」会被拦截并提示先启用该来源。
- **自定义目录**：点「添加目录」输入绝对路径，该目录即成为只读技能来源——适合管理散落在仓库、网盘同步目录里的技能合集；与已有来源重叠的路径会被拒绝，避免遮蔽失效。
- **创建与导入**：表单直接创建；ZIP、`.md`、技能文件夹拖进来就能装，导入弹窗里也可以「选择文件夹」；删除先进回收站，可恢复，永久删除前还会尝试移入系统回收站兜底。可删的是**插件自己管理的来源**（DSH 技能 / 导入技能 / 项目级 `.dsh/skills`）；外部 Agent 目录与自定义目录只读，上面的技能删不掉。

### AGENTS.md 预设

- **预设库**：新建、导入、编辑多套全局指令基线（如不同团队的 coding standard 或不同角色的行为规范）。
- **应用即写入**：「应用」把选中预设写入 `~/.dsh/AGENTS.md`，**新会话生效、当前会话不变**；编辑后点「重新应用」同步最新内容。每次应用都会把被覆盖的内容存成带时间戳的备份，**保留最近 5 代**（连点几次也不会丢掉原始内容）；删除预设前请先切换到其他预设。

### 历史会话

- **按项目分组**：归档会话按工作区分组展示，搜索标题 / 会话 ID / 项目路径快速定位；工作区目录已不存在的会话会打上 ⚠ 标记。**工作区登记被删除后**（DSH 侧删工作区不会删目录与会话）分组会按会话目录自动重建，标为「工作区已移除」/「未登记的工作区」，目录仍在时可一键「重新登记为工作区」补回登记（只新增登记，不动文件与会话），恢复会话时也会自动把它挂回对应工作区（此前恢复出来会掉进「未分组」）。
- **批量操作**：「全选」后批量恢复或永久删除；恢复的会话回到工作区列表，删除会连同其子代理子会话一并清理。
- **保留期**：顶部下拉选择自动清理周期（0 = 永久保留），到期自动清除；到期基线取「归档时刻」与「最后一次修改保留期的时刻」里**较晚**的那个，所以改一次保留期就会重新计时。
- **导入对话**：无痛接管其他工具的会话——Claude Code / Cursor 的 JSONL、Codex 的 Markdown、以及任意文本格式，导入后即可继续对话。
- **导出对话**：按会话范围（全部 / 仅归档 / 按工作区）导出，每个会话一个 Markdown 或 JSONL 文件；导出目录默认桌面，旁边带「选择文件夹」按钮弹出目录树，逐级浏览选中后自动回填绝对路径。

#### 归档服务兼容边界

- 本插件**不禁用也不替换**官方 `workspace` / `session-projection-cache`，不注册第二个同名服务，也不再用包名判断是否与归档管理器冲突——`cordis.patch.yml` 只插入插件自己这一行。
- 归档走插件自己的门面：**有原生入口走原生、没有走受检适配层、都不行才拒绝**。判定依据是「插件与宿主是不是同一份物理模块 + 宿主对象上有没有这个能力」，**不再比对官方源码文本**——上游重构不会再把功能整体打死；最坏情况是该动作被禁用，并在「兼容」页与拒绝信息里说明缺什么、后果、怎么修。
- 适配层访问工作区内部状态（含官方声明为 private 的方法），并在宿主缺少自带删除屏障时可逆地包裹投影缓存的 `put` / `write`。**所以「不替换服务、不争注册」≠「零侵入」**，也不是「解耦」。
- 归档时刻通过官方持久化事件同步；旧记录缺少归档时刻时，从首次观察时开始保留期，不按很早的会话创建时间立即删除。
- 旧的独立缓存文件不迁移、不删除，改回官方缓存后可能需要按需重建摘要。若用户配置中手写了旧 `/workspace`、`/projcache` 挂载，应单独检查；本插件不会擅自改用户的补丁文件。
- 已用官方服务及隔离 JSON 存储验证归档、恢复、批量删除和缓存防回写；与 `@michengai/dsh-archive-manager` 实际双安装仍未验证，不承诺任意版本都兼容。

### 宿主兼容

插件在运行期使用宿主**同一批** `@deepseek-ai/*` 库（`dsh-tools` / `dsh-workspace` / `dsh-session-projection-cache` / `cordis` / `dsh-storage-domain` / `dsh-spill-local`）。**这些包必须是宿主正在跑的那一份物理模块**：各持一份拷贝时，`instanceof`、`===` 与 symbol 查找都不成立，任何「适配宿主实现」的判断都会退化成猜。

- **设置 → 工具 → 兼容**（第 8 栏）：界面版体检——宿主版本与要求范围、插件适配版本、能力可用数、每个宿主动作走**宿主原生入口 / 插件适配层 / 不可用**、已降级能力与原因、模块实体是否同一份、阻塞项清单。只读，不改任何数据。
- **命令行版**：

```bash
node scripts/doctor.mjs               # 只读体检：模块实体是否同一份 + 宿主能力概览
node scripts/host-deps.mjs            # 报告差异（默认 dry-run）
node scripts/host-deps.mjs --fix      # 把差异包改为 junction 指向宿主安装（原始副本备份到 .host-deps-backup/）
node scripts/host-deps.mjs --restore  # 还原
```

DSH 升级（更换安装目录）后重跑一次 `--fix`；宿主缺某个包时插件会拒绝受影响的动作并说明原因，不会「猜着写」。

> `doctor.mjs` 的能力清单是脚本内的**静态子集**（只看成员是否存在，不做运行期行为干跑，也不覆盖删除路由）；要完整的运行时结论，以**兼容页**为准。

### Agent 预设兼容性（注入类 vs 操作类）

DSH 的 **Agent 预设**（`standard` / `ptc` / `cordis` / `minimal`，来自 `@deepseek-ai/dsh-agent-presets`）是**按会话组装**的一套插件：每个会话按预设的 `agent.cordis.yml` 拿到自己的工具、提示词段与技能。本插件**不在任何预设的 composition 里**——它挂在 profile 的 `cordis.patch.yml`（宿主层），所以切换预设不改变本插件是否加载。

但「能不能用」要分成两类，两者的边界完全不同：

| 能力 | 靠什么生效 | `standard` / `ptc` / `cordis` | `minimal` |
|---|---|---|---|
| 14 个模型工具、设置面板八栏、归档 / MCP 管理 | 宿主层注册，与预设无关 | ✅ | ✅ |
| 场景记忆注入（per-agent `systemPrompt` 段） | 预设的 persona **不是** `complete` | ✅ | ❌ 被压制 |
| `~/.dsh/AGENTS.md` | 预设挂 `@deepseek-ai/dsh-agent-instructions` | ✅ | ❌ 未挂载 |
| 技能目录（`skill` 工具） | 预设挂 `@deepseek-ai/dsh-tool-skill` | ✅ | ❌ 未挂载 |

**为什么 `minimal` 下注入全部失效**：它的 persona 行写了 `complete: true`，官方语义是「提示词注册表把这确切前缀恢复为唯一段落；身份、后缀、工具引导或监听器都无法追加提示词文本」。这是**该预设的设计意图**（极简配置），不是缺陷——本插件不对抗它，只如实说明。

以下为实测结论，非推断（2026-09-14，`minimal` 空会话）：

| 探针 | 结果 |
|---|---|
| 调用 `rule_manager_list` | ✅ 可调用并返回记忆清单 → 工具层不受预设影响 |
| 调用 `skill` | ❌ 无该工具 → 技能目录确实不在该预设 |
| 复述系统提示词 | ❌ 无记忆标记、无 AGENTS.md 内容 → 注入被压制 |
| shell 读 `~/.dsh/AGENTS.md` | ✅ 标记在磁盘上 → 闭环：文件在，只是没进提示词 |

**插件怎么让你看见这件事**：

- **兼容页 → 预设注入边界**：逐预设列出「场景记忆 / AGENTS.md / 技能目录」三列的可达性，被压制的预设标红并写明原因。只读预设组合文本，**不挂载任何预设**、不改任何数据。
- **模型工具**：在会压制的预设下，`rule_manager_list` / `agentsmd_list` 的返回末尾附一行边界声明，明确告诉模型「这些记忆不在你的上下文里，需要正文请用 `rule_manager_read` 读取」——避免模型看到清单就假设自己已经读过正文。
- 探测依据是预设自己的组合文本（经名单的 `read(id)`），不是猜测；解析不出来时统一报「无法判断」，绝不报成「正常」。

> 「Agent 预设」与「AGENTS.md 预设」是两回事：后者是本插件自己的预设库（见上「AGENTS.md 预设」），它写的是 `~/.dsh/AGENTS.md` 这个文件——在 `minimal` 下同样不生效，原因就是上表那一行。

### 让模型和脚本参与管理

| 入口 | 能做什么 |
|---|---|
| `skill_mcp_manager_list / set_enabled / restart / add` | 模型查询与操作 MCP 服务 |
| `skill_manager_list / set_enabled / create` | 模型查询与操作技能（创建前会征求你同意） |
| `agentsmd_list / agentsmd_apply` | 模型查询 AGENTS.md 预设库、切换当前预设（写入 `~/.dsh/AGENTS.md`，新会话生效）；**不提供新建 / 删除**，避免模型误删你的预设 |
| `rule_manager_list / read / write` | 模型查询与读写场景记忆（写入前会征求你同意，可在设置中关闭确认） |
| `subagent_list / subagent_run` | 模型列出人设、按人设运行一次性子代理（只回传结果、跑完即弃；运行前默认需确认，可在设置中关闭） |
| `POST /dsh-plugin-tool-management/api` | 脚本调用的 HTTP API（`{op, args}` 协议） |

> v0.4 起**不再注册斜杠命令**（曾有 `/mcp`、`/skills`、`/agents-md`、`/scene-memory`）：
> 它们只能输出纯文本快照、既不能操作也容易与面板状态不一致，面板里每一项都有等价入口。

## 数据落点

| 内容 | 位置 |
|---|---|
| MCP 服务器定义 | `profiles/<profile>/cordis.patch.yml`（项目级）或 `~/.dsh/cordis.patch.yml`（全局），改写前自动 `.bak` |
| 服务器备注 / 页面设置 / 工具停用列表 / 导出 | DSH 主目录下的旁路 JSON（`dsh-plugin-tool-management-*.json`） |
| 技能启停策略 / 同名首选表 / 自定义目录 | `~/.dsh/tool-management/state.json`（`sources` / `enabledSkills` / `disabledSkills` / `preferredSkills` / `customRoots`）。**默认来源 `dsh` / `hub` 不在 `sources` 表里**：它们必须读取、没有来源开关，旧版本写过的 `sources.hub` / `removedSources` 条目会在读取时被丢弃 |
| 技能回收站 / 导入暂存 | `~/.dsh/tool-management/trash`、`uploads` |
| 插件新建 / 导入的技能 | `~/.dsh/tool-management/skills/<技能>/`（官方 `~/.dsh/skills/` 同样作为来源列出、同样可管理：里面的技能可删，来源本身不可移除 / 停用） |
| AGENTS.md 预设库 / 应用结果 | `~/.dsh/tool-management/agents-md/<预设 id>/AGENTS.md`；「应用」写入 `~/.dsh/AGENTS.md`，被覆盖内容备份在 `__last-applied__/`（保留 5 代） |
| 归档账本 / 保留期 / 工作区登记快照 | `~/.dsh/tool-management/history-archived-at.json`、`history-retention.json`、`history-workspaces.json`（旧位置是插件目录 `data/`，启动时自动搬入，只搬不删、绝不覆盖。**不能放插件目录**：npm 安装下 `dsh plugin update` 会整体替换该目录，账本丢失会让保留期基线退回会话创建时间、归档会话被提前清掉） |
| 记忆文件（真源） | `~/.dsh/tool-management/memories/<场景>/<名>.md`（flat）或 `<场景>/<名>/SKILL.md`（bundle）；场景名可含中文；**保留场景 `global`（界面「全局」）的记忆任何对话都注入**；`memories/` 根层的裸 `.md` 不属于任何场景，**不会注入**（体检会报 `noScene`） |
| 记忆索引 / 场景记录 / 启用场景 | `~/.dsh/tool-management/rules-index.json`（`enabled` / 排序 / 标签 + `scenes` 场景记录（label / 描述 / 顺序）+ `active` 启用场景集合（`null` = 全部启用）+ `archives` 场景档案勾选集 + `mode` 当前模式快照） |
| 人设文件（真源） | `~/.dsh/tool-management/agents/<人设>.md`（frontmatter 可选，正文 = 人设提示词） |
| 页面设置 / 确认开关 | `~/.dsh/dsh-plugin-tool-management-settings.json`（`requireConfirmForModelSubagentRun` 等） |
| 记忆回收站 | `~/.dsh/tool-management/rules-trash/<trashId>/`（删除记忆先进这里，可恢复） |
| 运行日志 | `~/.dsh/dsh-plugin-tool-management.log`（滚动） |

**插件安装目录里不存任何用户数据**——npm 安装下 `dsh plugin update` 会整体替换该目录。

## 配置与安全

插件 loader 行支持以下可选字段（`dsh plugin add` 会自动插入，一般无需手写）：

| 字段 | 说明 |
|---|---|
| `token` | 可选访问令牌。设置后**所有写操作与「显示密钥」**都要求 `x-dsh-token` 请求头；同时它也充当「免浏览器鉴权」的逃生门——令牌正确即视为已授权，供 curl / 脚本与局域网部署使用。客户端从 localStorage 读取（键 `dsh-plugin-tool-management-token`，DevTools Console 设置后刷新即可），也可用环境变量 `DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN`。 |
| `maxBodyBytes` | 请求体上限，默认 88 MiB（技能 ZIP 上传需要）。 |

鉴权怎么工作的：插件路由**不在**宿主的全局鉴权闸门里，所以它自己调宿主的 `connection.requestRejection(req)`——先过 Host / Origin 栅栏（Host 必须是回环或本机 LAN 的 IP 字面量，这是 DNS rebinding 唯一伪造不了的头），再过 browser-session cookie 鉴权。宿主该服务不在场时退回**本地判定**，只检查「Host 是回环 + 非跨站 Fetch + Origin 与 Host 同源」，**不含 cookie 鉴权**（比宿主栅栏弱，这种环境下更要配 token）。因此：

- **浏览器**里用 GUI：走 cookie，不需要配 token。
- **curl / 脚本**：带上正确的 `x-dsh-token`，或带上浏览器 cookie。
- 会吐明文密钥的接口（「显示密钥」、配置导出）额外要求请求带 `Origin` 头——浏览器同源请求一定带，挡掉不带 Origin 的本机脚本。
- 把端口转发到局域网 / 公网时，token 仍是防止陌生人注入 MCP 命令（等同远程执行：`command` / `args` 会被直接 spawn）与窃取明文密钥的关键防线，**建议配置**。
- 自定义头 `x-dsh-plugin` 只是防误触的门禁标识，不是凭证。

## 常见问题

| 现象 | 解决 |
|---|---|
| 装完设置里没有页面 | 硬刷新；不行就重启 DSH。 |
| 出现重复的 MCP 页签 / 工具 | 与旧 loader 行双挂载，删掉 `cordis.patch.yml` 里的旧条目后重启。 |
| 改坏了配置 DSH 起不来 | 同目录取最近的 `cordis.patch.yml.bak-<时间戳>` 恢复。 |
| 页面数据不刷新 | 等待页面自动轮询（默认 5 秒）；或手动点「刷新」。 |
| 镜像源装不到最新版 | 加 `--registry=https://registry.npmjs.org` 稍后再试。 |
| 升级 DSH 后某个动作不可用了 | 打开设置 → 工具 → **兼容**看原因；先 `node scripts/doctor.mjs`，若提示两份拷贝再 `node scripts/host-deps.mjs --fix`。 |
| 归档 / 恢复 / 删除报「能力不可用」 | 同上。插件宁可拒绝，也不用未知实现改数据；提示里会写明缺什么能力与恢复指引。 |
| 完全权限（`approval=never`）下还需要确认吗？ | **不需要，也不会弹卡**：三个确认门（`rule_manager_write` / `skill_manager_create` / `subagent_run`）在 never 会话里被视作「用户已预先批准」，直接放行，并在 `~/.dsh/dsh-plugin-tool-management.log` 记一条 `confirm-bypass` 留痕。想让它们重新问一次，就把访问模式切回「工作区内修改」；只想关掉某一项，用插件设置里的 `requireConfirmForModel*` 开关。 |
| `subagent_run` 报「spawn provider 不可用」 | **条件式**：宿主自带 `spawn` provider（最新版无需装包、无需挂载），只有宿主确实没注册、且本插件也挂载不了 `@deepseek-ai/dsh-subagent-spawn-in-process` 时才会出现（错误文本里带原始原因，多见于旧版或特定 profile）。此时在宿主 profile 里挂载该包后重启 DSH——本插件不把它写进 `cordis.patch.yml`，以免缺包的宿主整棵树起不来。 |
| 场景里只绑了 A 人设，为什么模型还是跑起了没绑定的子代理？ | **子代理有两条通道**。本插件的 `subagent_run` 走确认门 + 场景人设绑定；DSH 官方的 `subagent` / `subagent_fork` 是宿主能力，**没有确认门、也没有「用哪个人设」的概念**，因此任何模式下都不受本插件的确认与绑定约束（实测：同一条消息里官方 `subagent` 无审批卡直接返回，紧接着的 `subagent_run` 才弹卡）。本插件的治理只覆盖 `subagent_run`。 |

## 开发

```bash
npm install
npm run build        # 构建（tsc + 同步客户端 bundle）
npm run build:client # 只同步 src/client.js → lib/client.js
npm run lint         # 语法自检（node --check 两个产物）
npm run check:i18n   # 词典自检：键集合 / 重复键 / 占位符对齐 + 代码里字面量引用的键必须都在词典里
npm run check:host   # 宿主依赖体检（只读，见下「宿主兼容」）
npm run host-deps    # 把插件依赖指向宿主安装（需要时执行一次）
npm run doctor       # 打印模块实体归属 + 宿主能力探测结果
npm test             # 构建 + i18n 自检 + 语义契约测试（node --test test/*.test.mjs，13 组）
```

> `lib/` 全部由 `npm run build` 生成、**不入版本库**，克隆后先构建。
> 插件由宿主启动时加载 `lib/`，**改完要重启 `dsh web`** 才生效（patch 热重载不会重新 import 插件模块）。

### 验证方式

本项目的验证是**直接跑一遍真实行为**，而不是断言代码当前怎么实现——后者只是把实现抄一遍，必然通过。
**文案与排版不做逐条断言**（用户裁定 2026-09-14：那是刻舟求剑，改一次样式就要改一次断言，页面观感由人在真实页面上确认）。

保留的是 13 组**语义契约**测试（`npm test`，跑 `lib/` 产物）：

| 测试 | 断言的语义 |
|---|---|
| `archive.test.mjs` | 场景引擎状态机：段存在性与空集合相互独立、勾选集 → 停用补集、快照深拷贝、应用失败回滚并如实上报 |
| `import.test.mjs` | 导入展开与落点规划：路径穿越拒绝、zip 认魔数不认扩展名、超限与非法条目逐条回报原因 |
| `approval-policy.test.mjs` | `approval=never` 探测链；用真实 cordis + 真实 `ApprovalService` 复现读取链，缺服务或抛错时一律不放行 |
| `subagent-scene.test.mjs` | 场景人设绑定：绑定外调用必须在子代理运行**之前**被拒 |
| `subagent-persona.test.mjs` | 人设 frontmatter 往返：`provider` / `model` / `toolsDeny` 读写不丢；目录不存在时创建 |
| `hub-layout.test.mjs` | 统一数据目录：旧布局搬移不覆盖、保留场景 `global` 恒在且不可删、记忆必须归属已存在场景、档案记忆段只影响投影 |
| `skills-state.test.mjs` | 状态文件读取韧性：缺键自愈、类型错仍 fail-closed、默认来源的残留策略位被丢弃 |
| `skills-delete.test.mjs` | 默认来源的技能删得掉且能从回收站**原样放回**；只读来源仍只读 |
| `skills-source-remove.test.mjs` | 「移除来源」：移除后不再被读取、不参与同名优先级、模型侧候选不可见，而文件零改动、可恢复；默认来源既不可移除也不可停用 |
| `client-exports.test.mjs` | 客户端导出契约：只求值 factory 不跑 `apply` 也能拿到 `dict` / `pages`；禁止把导出写在 `apply` 方法体里 |
| `client-render.test.mjs` | 装配与渲染：假 ctx 跑完整 `apply`，注册 `settings.section` 并递归渲染整棵组件树不抛错（这一条抓到过真的白屏）、带数据再渲染不抛错；场景页与档案弹窗只断结构不断文案；兼容页只在真有阻塞 / 降级时着色，且英文词典下结论条不得出现中文字符 |
| `compat-probe.test.mjs` | 宿主能力探测：用真实官方类原型链构造宿主对象，成员改名 / 返回值形状变化 / 服务缺失都必须降级为**具名**结论而不是抛错；探测本身只读 |
| `compat-fallback.test.mjs` | 能力门禁真的挡在写之前：缺串行写事务时归档被拒且宿主写方法一次都没被调用；缓存只在宿主缺自带删除屏障时才包裹，并在卸载后还原 |

另有 `npm run check:i18n`（词典键集合、重复键、占位符对齐 + 字面量引用完整性；当前 zh/en 各 722 条、454 处引用）与 `node scripts/i18n-debt.mjs`（还剩多少硬编码中文，**当前 214 条**，其中提示词页 15 条、其余散落在未按页统计的组件与共享壳中，会话页已清零）。

契约测试断言语义契约而非实现抄写；**真实行为验收仍以浏览器 / 宿主实测为准，契约测试不能替代**。

### 结构

宿主端 `src/index.ts`（Cordis 对象插件，`lib/index.js` 为发布产物）；宿主能力探测 `src/compat/probe.ts`（唯一决定「能对宿主做什么」的地方，只读）；HTTP 门禁 `src/http-fence.ts`；数据目录常量与搬移 `src/hub.ts`；技能核心 `src/skills/core.js`（纯 Node）；AGENTS.md 预设库 `src/agents-md/service.ts`；归档会话管理 `lib/history/`（`workspace.js` 门面 / `bridge.js` 兼容层 / `projcache.js` / `tombstone.js`）；对话导入解析 `src/imports/parsers.js`；场景记忆服务 `src/rules/`（`service.ts` 发现、CRUD、索引、体检与两相扫描段渲染，`provider.ts` 注册 per-agent `systemPrompt` 段；模块路径与 `rules-*` op 名保留为内部协议，用户可见的页面与目录名是「场景记忆」/ `memories/`）；浏览器端 `src/client.js`（ModuleLoader CJS bundle，`dsm-*` 设计系统，经同源 API 与宿主通信）；开发期脚本 `scripts/host-deps.mjs`（依赖对齐）与 `scripts/doctor.mjs`（兼容体检）。

运行时依赖仅 `fflate`（ZIP 解压）；`@deepseek-ai/*` 一律用宿主那份（见上「宿主兼容」）。

发布：`npm publish`（`prepublishOnly` 自动构建；版本号用 `npm version <minor|patch>`）。

## 许可证

MIT
