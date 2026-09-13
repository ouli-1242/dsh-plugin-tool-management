# dsh-plugin-tool-management

[![npm version](https://img.shields.io/npm/v/dsh-plugin-tool-management?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-tool-management)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](package.json)
[![GitHub](https://img.shields.io/badge/GitHub-ouli--1242%2Fdsh--plugin--tool--management-181717?logo=github)](https://github.com/ouli-1242/dsh-plugin-tool-management)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

**简体中文** · [English](README_EN.md) · [Changelog](docs/Changelog.md)

**DeepSeek Harness 的 MCP 服务、技能与记忆管理插件。** 一个设置面板管好五件事：

- **MCP**：连接了哪些服务、每个服务有哪些工具、哪些工具该让模型用——增删改查、启停、重启，全部即改即生效；
- **Skills**：本机各处的技能（DSH / Agents / Codex / Claude / 项目级 / 你自己指定的任意目录）一目了然，逐个或整组启停、创建、导入、回收；
- **AGENTS.md**：管理多套全局指令基线预设，一键「应用」写入 `~/.dsh/AGENTS.md`，新会话生效、当前会话不变；
- **History**：已归档会话统一管理，按项目分组、批量恢复/删除，对话导入/导出，保留期自动清理；
- **场景记忆**：`~/.dsh/tool-management/memories/<场景>/` 下一个文件夹 = 一个场景、一个 `.md` = 一条记忆——**新建场景**（带描述）、往里放 `.md`（文件名支持中文）、开关场景；启用场景里的记忆正文**整篇自动进入系统提示词**，不用每次重复解释。保留场景 `global`（界面「全局」）恒定注入任何对话。

不手改 `cordis.patch.yml`，不碰任何技能源文件，重启与升级后配置依旧。

---

<!-- 图片占位 1：MCP 管理页截图 → docs/images/MCP.png -->

![MCP 管理](docs/images/MCP.png)

<!-- 图片占位 2：Skills 管理页截图 → docs/images/技能.png -->

![Skills 管理](docs/images/技能.png)

<!-- 图片占位 3：AGENTS.md 预设页截图 → docs/images/提示词.png -->

![AGENTS.md 预设](docs/images/提示词.png)

<!-- 图片占位 4：History 归档会话页截图 → docs/images/会话.png -->

![History 归档会话](docs/images/会话.png)

<!-- 图片占位 5：场景记忆页截图 → docs/images/场景.png -->

![场景记忆](docs/images/场景.png)
<!-- 图片占位 6：记忆页截图 → docs/images/记忆.png -->
![记忆](docs/images/记忆.png)

<!-- 图片占位 7：子智能体页截图 → docs/images/子智能体.png -->
![子智能体](docs/images/子智能体.png)

## 核心亮点

| 能力 | 说明 |
|---|---|
| 工具级开关 | MCP 服务器内的**单个工具可独立启停**：模型看不见也调不到，随时恢复；整台服务器还支持批量启停 |
| 重启语义 | 重启只重连、**不改变启停状态**（对已停用的服务执行重启不会意外启用它） |
| 密钥安全 | `env` / `headers` 中的密钥**默认打码**、URL 查询串遮蔽；查看明文与所有写操作一样受 token 保护 |
| 写入保护 | 每次改写补丁前自动留 `.bak` 时间戳备份（保留 5 份）；重复 loader id 写前拦截、跨级迁移失败自动回滚 |
| 备份恢复 | JSON 导入支持 `overwrite` 覆盖同 id 条目，不再只能跳过 |
| 技能来源 | 接入 `~/.agents` / `~/.codex` / `~/.claude` 三个官方不加载的技能目录，并支持**自定义任意技能目录**（只读接入、重叠拒绝） |
| 技能操作 | 创建技能、ZIP/文件夹导入、插件回收站（恢复 / 永久删除 / 系统回收站兜底）、系统编辑器打开源文件。**删除只对项目级来源开放**：DSH 技能与导入技能（`~/.dsh/skills/`、`~/.dsh/tool-management/skills/`）**不可删除**，只能停用 |
| 技能来源命名 | `DSH 技能` = 官方 `~/.dsh/skills/`；**`导入技能`** = 插件导入/新建的落点 `~/.dsh/tool-management/skills/`（优先级高于 DSH 技能，同名时遮蔽官方那份） |
| 即时刷新 | 技能目录由后台线程监听，编辑器里改完技能页面自动刷新 |
| AGENTS.md 预设 | 多套全局指令基线预设库：新建 / 导入 / 编辑 / 应用 / 删除；「应用」写入 `~/.dsh/AGENTS.md`（新会话生效，当前会话不变） |
| 会话归档管理 | History 页按项目分组展示已归档会话：搜索、全选、批量恢复 / 永久删除、保留期自动清理（改保留期后倒计时以修改时间为基准重置） |
| 对话导入 / 导出 | 从 Claude Code / Cursor（JSONL）、Codex（Markdown）、任意文本无痛接管对话；导出可选会话范围，目录默认桌面，支持 Markdown / JSONL |
| 场景记忆自动生效 | 记忆 = `~/.dsh/tool-management/memories/<场景>/<name>.md`；勾选启用的场景，其目录树内所有 `.md` 正文**自动进入系统提示词**（per-agent `systemPrompt` 段），模型无需任何工具调用，切换后**下一个请求即生效**；保留场景 **`global`（界面「全局」）恒定注入任何对话** |
| 记忆导入 | 记忆页「导入记忆」：`.md` / `.zip`（可多选、可拖入）；zip 内目录名即场景，裸 `.md` 落到弹窗所选场景（留空 = 保留场景「全局」）；zip 内 `<场景>/<名>/SKILL.md` 按 **bundle** 导入（同层文件作附件）；同名跳过并列出名单，**为此补出来的场景也会在结果里列出** |
| 场景启用开关 | 场景是**显式记录**（带描述、顺序），目录名支持中文；「启用场景」多选开关全局持久化在 `rules-index.json` 的 `active`；**无配置时全部启用**，`global` 与 `_shared/` 恒常生效 |
| 场景档案（自由搭配） | 每个场景可勾选自己的 **MCP 工具集 / 技能集 / 子智能体绑定 / 记忆**（任意组合；清单只列实时存在的条目，勾=启用/未勾=停用；MCP 还支持两级：不勾服务器=整台停用，勾了服务器但一个工具都不勾=该服务器全停）。**记忆段只影响注入**（没勾的记忆不进提示词，文件原样保留）。勾了工具/技能段的场景可「设为当前模式」：应用档案前先落盘快照、退出按快照**原文**恢复；仅记忆 / 仅子智能体的场景不显示模式按钮；进入后下一请求生效 |
| 轻量子智能体 | `~/.dsh/tool-management/agents/<人设>.md` 一个文件一个人设（frontmatter 可选：`description` / `provider` + `model` / `tools` 白名单 / `toolsDeny` 黑名单，正文=人设提示词，缺省自动派生）；页头「导入」支持 `.md` / `.zip`（同名跳过并列出名单）；模型经 `subagent_list` / `subagent_run` 调用——子代理带人设运行、只回传结果、即用即弃（不进 History）；**自动继承当前启用场景的记忆段**；场景档案可绑定「本场景可用哪些人设」（绑定外调用直接拒绝）；运行默认需确认，设置可关 |
| 前缀缓存友好 | 段文本只由「启用场景 + 文件内容」决定，逐字节稳定；场景切换 / 编辑记忆只变化一次，其余请求缓存照常命中（不违反"零注入层"——那条只禁每轮动态变化的内容） |
| 模型工具 | **12 个**：`skill_mcp_manager_*` 管 MCP，`skill_manager_*` 管技能，`rule_manager_*` 管场景记忆（创建前需用户确认，可在设置中关闭），`subagent_list` / `subagent_run` 调用人设子智能体（运行前默认需确认，设置 `requireConfirmForModelSubagentRun` 可关）。**三个确认门都识别会话审批策略**：`approval=never`（完全权限）下确认卡不可能弹出，插件视为「用户已预先批准」直接放行并记 `confirm-bypass` 日志（与官方子代理工具在完全权限下的行为一致） |
| 界面 | 独立的 `dsm-*` 设计系统，**七栏**（场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话）页头同构、段卡片统一；勾选类界面（档案四段 / 人设工具黑白名单）共用同一套排版，长列表都有筛选框；人设的模型与工具限制收在「高级选项」折叠区（已配置则自动展开）；通知分两级（成功 = 浮层，警告/错误 = 页内横幅）；档案弹窗固定高度，加减段不跳动 |

## 快速开始

前置：已装好 DSH（`dsh web` 可运行），Node.js ≥ 18。

```sh
# 安装（装包 + 自动挂载）
dsh plugin --profile web add dsh-plugin-tool-management@latest

# 更新：重复执行同一命令
# 卸载：
dsh plugin --profile web remove dsh-plugin-tool-management
```

装完硬刷新浏览器（Cmd/Ctrl+Shift-R），设置里出现 **工具** 面板（场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话 七栏）即安装成功（客户端改动由 DSH 热加载，无需重启）。

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
- **同名技能自选**：多处出现同名技能时，默认按来源优先级自动取一个生效（其余显示「被覆盖」，无开关）；想改用某来源的版本，点该行「启用这个」即设为**同名首选**并启用——首选只写进状态文件（`preferredSkills`），不动任何源文件；赢家行可「取消首选」回到自动。来源整体停用时「启用这个」会被拦截并提示先启用该来源。
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

### 管场景（场景页）

> 场景 = 分组维度，记忆（`.md`）= 内容；场景可挂「档案」：MCP 工具集 / 技能集 / 子智能体绑定 / 记忆，四段自由搭配。
> 数据统一收在 `~/.dsh/tool-management/`（目录结构、旧路径自动搬迁、缓存设计见 [Changelog](docs/Changelog.md)）。

- **场景是显式记录**：`memories/<场景>/` 是它的记忆目录，场景本身带**描述**与顺序（存在 `rules-index.json` 的 `scenes` 切片）。`~/.dsh/tool-management/memories/办公/流程.md` 即"办公"场景下的一条记忆。场景名支持中文等任意 Unicode（≤64 字符，不含 `/ \ < > : " | ? *`，不以 `.` 开头，**单个路径段**）；`global` 是保留场景（界面显示「全局」），`_shared/` 是历史保留的公共场景。
- **新建场景**：点「新建场景」填名字与一句描述（也可以自己在 `memories/` 下 `mkdir`，效果一样，下次读取会补上记录）。**空场景也合法**——可以先把场景建好、之后再往里放记忆。卡片上还有「改描述」随时补说明。
- **每个 `.md` 就是一条记忆**：一句话或一段话都行，不用写 frontmatter，整篇正文都会注入。往场景文件夹里丢文件就生效，也可以点卡片上的「新建记忆」在页面里写——**文件名支持中文**（如 `站会流程.md`）。
- **开关场景**：场景卡片右侧的开关就是启用/停用（与 Skills 页同一套组件和布局）。其目录树内**所有 `.md` 的正文会自动进入系统提示词**——模型不需要做任何动作，也不用每次重复解释。切换**下一个请求即生效**，无需重开会话或重载插件。
- **默认全部启用**：没有任何配置时所有场景都生效（"丢进去就有用"）；场景多了再在页面上收窄。`global`（「全局」）与 `_shared/` 恒常生效，卡片上没有开关。
- **全局记忆**：保留场景 `global` 的记忆**任何对话都注入**（不吃场景开关），适合"放之四海皆准"的偏好与约定。新建记忆时场景留空即落到这里。
- **导入记忆**：页头「导入记忆」支持 `.md` 与 `.zip`（可多选、可拖入）。zip 内带目录时**目录名即场景**（`工作/standup.md` → 场景 `工作`）；**直接拖入文件夹同理**（按文件夹层级落场景，多级目录保留为 `A/B`）；裸 `.md` 落到弹窗里选的场景——**留空 = 保留场景「全局」**。zip 内 `<场景>/<名>/SKILL.md` 按 **bundle** 导入（落 `<场景>/<名>/`，**同层文件作附件**；附件名非法 / 空 / 单个 >8 MB / 合计 >16 MB 逐条跳过并回报）。文件按原文落盘，**同名自动跳过并列出名单**（不覆盖既有记忆）。所有被丢弃的内容都会**回报原因**（含 zip 内超限条目），不做静默丢弃；导入时引用到的场景若还不存在会**自动补一条场景记录并在结果里列出**（不静默造数据）。
- **记忆 = 一个 Markdown 文件**：`<场景>/<name>.md`（flat）或 `<场景>/<name>/SKILL.md`（bundle，可带附件）。新建时选场景（下拉里是已存在的场景，要去「场景」页先建）、填名称（= 文件名）、描述与正文，frontmatter 全部可选，缺失时插件自动派生。**归属不存在的场景会被明确拒绝**（`场景不存在`），不再静默造场景。
- **bundle 附件**：形态选 bundle 时可直接**添加附件**（多选，单个 ≤8 MB、单次 ≤16 MB / 32 个）；附件存在记忆目录里，**不会进入提示词**（只有 `SKILL.md` 正文注入），编辑时可逐个移除。flat 是单文件，没有目录可放附件。
- **启停与回收**：逐条启停（每行右侧开关，停用的记忆仍留在磁盘上，只是不进提示词）、编辑、移入回收站；页头「回收站」可以**恢复**或**永久删除**已删记忆，删除前有二次确认。`enabled` 等状态存在侧车索引里，绝不回写记忆文件。
- **注入预算可见**：页头下方常驻一条预算条（已用 / 上限字节），超限变红并标「已超限」。默认上限 64 KiB；**某条记忆放不下时只跳过它**、继续装后面放得下的小记忆，段尾会附一份「未注入（超出预算）」清单——模型与用户都能看到哪些记忆这次没进提示词，而不是静默丢失。
- **不再改写 `~/.dsh/AGENTS.md`**：原"始终层"已下线，公共基线改由 `_shared/` 承担，统一走系统提示词段。
- **场景档案（四段自由搭配）**：卡片上「档案」打开编辑器，四段各自独立"添加/移除"——**MCP 工具集**（两级勾选：先勾服务器，「添加」时按当前运行时状态预勾；不勾=整台停用，勾了但一个工具都不勾=该服务器全停）、**技能集**（勾选器只列实时发现的条目，预勾当前启用状态，勾=启用/未勾=停用）、**子智能体绑定**（勾人设名单，全不选=不限制）、**记忆**（场景卡片列出每个场景的记忆与已勾条数，点「选记忆」进场景内明细；**只影响注入**——没勾的记忆不进系统提示词，文件与内容一律不动）。编辑器顶部有筛选框，长列表不用靠滚动找；弹窗固定高度，加减段不跳动。勾了工具/技能段的场景出现「设为当前模式」按钮：**进入模式 = 快照当前启停 → 先落盘快照 → 应用勾选集 → 记忆收窄到该场景**；「退出模式」按快照**原文**恢复（模式期间写进去的整台停用键随之消失）。运行中手动改动不会偷偷回写，点「保存到场景」才落盘。进入后下一请求生效。任一步失败自动回滚并如实上报（回滚未完成会写进错误文本，不谎报「已回滚」）。
- **子智能体（人设）**：`~/.dsh/tool-management/agents/<人设>.md`，一个文件一个人设——frontmatter 可选（`description` 何时调用，**一句话即可** / `provider` + `model` 指定模型路由（**两者是一对**：跨来源换模型必须都填，如 `provider: sensenova` + `model: sensenova-6.8-flash-lite`；只填 `model` 会落在主会话的来源上） / `tools` 工具白名单 / `toolsDeny` 工具黑名单，缺省自动派生），正文就是人设提示词。页面上这些都在「**高级选项**」折叠区里（已经在用模型/工具限制的人设自动展开）：模型是**下拉选择**（宿主 LLM 目录里的 `provider · model` 对，目录里没有的可切「自定义」手填），工具白/黑名单是**勾选器**——候选是**全部 Agent 预设工具名的并集**并标注「当前会话可见 / 其它预设里可用」，因为人设可能在任何预设下被复用，只列当前会话的工具会让换预设后的子代理启动失败（官方 `toolFilter` 对未知名直接拒绝启动）。页头「导入」支持 `.md` 与 `.zip`（zip 内任意层级的 `.md` 都按文件名导入，**同名自动跳过并列出名单**）。模型用 `subagent_list` 看清单、`subagent_run{agent, task}` 调用：子代理**带人设独立运行**、自动继承当前启用场景的记忆段、只把最终输出回传主模型（≤16 KiB），跑完即弃不进 History。场景档案里绑定「本场景可用哪些人设」（绑定外调用报"人设不可用"）；运行默认弹确认（花的是真 token），设置 `requireConfirmForModelSubagentRun: false` 可关，完全权限（`approval=never`）下视为已预先批准直接放行（见 FAQ）。**治理边界**：以上约束只覆盖 `subagent_run` 这一条通道——DSH 官方的 `subagent` / `subagent_fork` 是宿主能力，无确认门、也不认这套人设，任何模式下都不受本插件约束（见 FAQ「两条子代理通道」）。

### 让模型和脚本参与管理

| 入口 | 能做什么 |
|---|---|
| `skill_mcp_manager_list / set_enabled / restart / add` | 模型查询与操作 MCP 服务 |
| `skill_manager_list / set_enabled / create` | 模型查询与操作技能（创建前会征求你同意） |
| `rule_manager_list / read / write` | 模型查询与读写场景记忆（写入前会征求你同意，可在设置中关闭确认） |
| `POST /dsh-plugin-tool-management/api` | 脚本调用的 HTTP API（`{op, args}` 协议） |

> v0.4 起**不再注册斜杠命令**（曾有 `/mcp`、`/skills`、`/agents-md`、`/scene-memory`）：
> 它们只能输出纯文本快照、既不能操作也容易与面板状态不一致，面板里每一项都有等价入口。

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
| 技能启停策略 / 同名首选表 / 自定义目录 | `~/.dsh/tool-management/state.json`（`sources` / `enabledSkills` / `disabledSkills` / `preferredSkills` / `customRoots`） |
| 技能回收站 / 导入暂存 | `~/.dsh/tool-management/trash`、`uploads` |
| 插件新建/导入的技能 | `~/.dsh/tool-management/skills/<技能>/`（官方 `~/.dsh/skills/` 仍作为来源列出，只读接入） |
| AGENTS.md 预设库 / 应用结果 | `~/.dsh/tool-management/agents-md/<预设 id>/AGENTS.md`；「应用」写入 `~/.dsh/AGENTS.md` |
| 归档会话账本 / 保留期 | 插件目录 `data/history-archived-at.json`、`data/history-retention.json` |
| 记忆文件（真源） | `~/.dsh/tool-management/memories/<场景>/<name>.md`（flat）或 `<场景>/<name>/SKILL.md`（bundle）；场景名可含中文；**保留场景 `global`（界面「全局」）的记忆任何对话都注入**；`memories/` 根层的裸 `.md` 不属于任何场景，**不会注入**（体检会报 `noScene`） |
| 记忆索引 / 场景记录 / 启用场景 | `~/.dsh/tool-management/rules-index.json`（`enabled`/排序/标签 + `scenes` 场景记录（label/描述/顺序）+ `active` 启用场景集合（`null` = 全部启用）+ `archives` 场景档案勾选集 + `mode` 当前模式快照） |
| 人设文件（真源） | `~/.dsh/tool-management/agents/<人设>.md`（frontmatter 可选，正文 = 人设提示词） |
| 页面设置 / 确认开关 | `~/.dsh/dsh-plugin-tool-management-settings.json`（`requireConfirmForModelSubagentRun` 等） |
| 记忆回收站 | `~/.dsh/tool-management/rules-trash/<trashId>/`（删除记忆先进这里，可恢复） |
| 运行日志 | `~/.dsh/dsh-plugin-tool-management.log`（滚动） |

## 常见问题

| 现象 | 解决 |
|---|---|
| 装完设置里没有页面 | 硬刷新；不行就重启 DSH。 |
| 出现重复的 MCP 页签 / 工具 | 与旧 loader 行双挂载，删掉 `cordis.patch.yml` 里的旧条目后重启。 |
| 改坏了配置 DSH 起不来 | 同目录取最近的 `cordis.patch.yml.bak-<时间戳>` 恢复。 |
| 页面数据不刷新 | 等待页面自动轮询（默认 5 秒）；或手动点「刷新」。 |
| 镜像源装不到最新版 | 加 `--registry=https://registry.npmjs.org` 稍后再试。 |
| 完全权限（`approval=never`）下还需要确认吗？ | **不需要，也不会弹卡**：三个确认门（`rule_manager_write` / `skill_manager_create` / `subagent_run`）在 never 会话里被视作「用户已预先批准」，直接放行，并在 `~/.dsh/dsh-plugin-tool-management.log` 记一条 `confirm-bypass` 留痕。想让它们重新问一次，就把访问模式切回「工作区内修改」；只想关掉某一项，用插件设置里的 `requireConfirmForModel*` 开关。 |
| `subagent_run` 报「spawn provider 不可用」 | **条件式**：宿主自带 `spawn` provider（最新版无需装包、无需挂载），只有宿主确实没注册、且本插件也挂载不了 `@deepseek-ai/dsh-subagent-spawn-in-process` 时才会出现（错误文本里带原始原因，多见于旧版或特定 profile）。此时在宿主 profile 里挂载该包后重启 DSH——本插件不把它写进 `cordis.patch.yml`，以免缺包的宿主整棵树起不来（取舍见该文件注释）。 |
| 场景里只绑了 A 人设，为什么模型还是跑起了没绑定的子代理？ | **子代理有两条通道**。本插件的 `subagent_run` 走确认门 + 场景人设绑定；DSH 官方的 `subagent` / `subagent_fork` 是宿主能力，**没有确认门、也没有「用哪个人设」的概念**，因此任何模式下都不受本插件的确认与绑定约束（实测：同一条消息里官方 `subagent` 无审批卡直接返回，紧接着的 `subagent_run` 才弹卡；`subagent_fork` 同样无卡）。本插件的治理只覆盖 `subagent_run`；要收紧官方那两个通道得由宿主侧约定或后续版本把它们纳入插件前裁决。 |

## 开发

```bash
npm install
npm run build        # 构建（tsc + 同步客户端 bundle）
npm run build:client # 只同步 src/client.js → lib/client.js
npm run lint         # 语法自检（node --check 两个产物）
npm run check:i18n   # 中英词典键集合 + 占位符对齐
npm test             # 构建 + i18n 自检 + 全部语义契约测试（node --test test/*.test.mjs，76 例）
```

> 本项目的验证方式是**直接跑一遍真实行为**（验收证据与已知问题见 [Changelog](docs/Changelog.md)），而不是断言代码当前怎么实现——
> 后者只是把实现抄一遍，必然通过。例外是十组**语义契约**测试（`npm test`，跑 `lib/` 产物，共 76 例）：
> `archive.test.mjs`（引擎状态机：勾=启用、空段可持久化、失败回滚与如实上报）、
> `import.test.mjs`（导入展开、落点规划与限额回报）、
> `approval-policy.test.mjs`（never 审批策略探测；用真实 cordis + 真实 `ApprovalService` 复现读取链）、
> `subagent-scene.test.mjs`（场景绑定必须在子代理运行**之前**拒绝）、
> `subagent-persona.test.mjs`（人设 frontmatter 往返：`provider`/`model`/`toolsDeny` 读写不丢；目录不存在时创建）、
> `hub-layout.test.mjs`（统一数据目录：旧布局搬移不覆盖、保留场景 global 恒在且不可删、记忆必须归属已存在场景、档案记忆段只影响投影）、
> `skills-delete.test.mjs`（哪些技能可以删：用户级来源不可删、只读来源仍只读）、
> `skills-state.test.mjs`（技能状态文件读取韧性：缺键自愈、类型错仍 fail-closed）、
> `client-exports.test.mjs`（**客户端导出契约**：只求值 factory 不跑 `apply` 也能拿到 `dict`/`pages`；禁止把导出写在 `apply` 方法体里）、
> `client-render.test.mjs`（**装配与渲染**：假 ctx 跑完整 `apply`，断言注册了 `settings.section`，并递归渲染整棵组件树不抛错）。
> 它们断言语义契约而非实现抄写；真实行为验收仍以浏览器/宿主实测为准，契约测试不能替代。
> 另有 `npm run check:i18n`（中英词典键集合 + 占位符对齐）与 `node scripts/i18n-debt.mjs`（还剩多少硬编码中文，当前 113 条：提示词页 38 / 会话页 75）。

结构：宿主端 `src/index.ts`（Cordis 对象插件，`lib/index.js` 为发布产物；`lib/` 全部由 `npm run build` 生成、**不入版本库**，克隆后先构建）；数据目录常量与搬移 `src/hub.ts`；技能核心 `src/skills/core.js`（纯 Node）；AGENTS.md 预设库 `src/agents-md/service.ts`；归档会话管理 `lib/history/`（`workspace.js` / `projcache.js` / `tombstone.js`）；对话导入解析 `src/imports/parsers.js`；场景记忆服务 `src/rules/`（`service.ts` 发现/CRUD/索引/两相扫描段渲染、`provider.ts` per-agent `systemPrompt` 段注册；模块路径与 `rules-*` op 名保留为内部协议，用户可见的页面与目录名已改为「场景记忆」/`memories/`）；浏览器端 `src/client.js`（ModuleLoader CJS bundle，`dsm-*` 设计系统，经同源 API 与宿主通信）。运行时依赖仅 `fflate`（ZIP 解压）。

发布：`npm version patch && npm publish`（`prepublishOnly` 自动构建）。

## 许可证

MIT
