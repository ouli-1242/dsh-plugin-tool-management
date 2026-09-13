# Changelog

`dsh-plugin-tool-management` 的变更记录与关键决策。本文档**取代**原先散在 `docs/计划`、`docs/设计`、`docs/日志`、`docs/审查`、`docs/交接` 下的过程文档（2026-09-13 合并），内容按「版本 → 功能 → 验收证据 → 已知问题」组织。

- 用户可见的功能说明在 [`../README.md`](../README.md) / [`../README_EN.md`](../README_EN.md)。
- 每条结论都标注**证据形式**。凡是没实测过的，一律写「未验证」，不写作「已支持」。

---

## v0.5.0（2026-09-13）

本次发布把此前散落的四套变更合并成一个版本，并修掉一轮真实故障。**详细条目见下一节「v0.5.0 详情」**
（该节原编号为 v0.4，内容不变，只改标题以免与发布号冲突）。

**给使用者的三句话**：数据全部收进 `~/.dsh/tool-management/`（首次启动自动搬迁、只搬不删、绝不覆盖）；
「场景」从"恰好有这个名字的目录"升级为带描述与顺序的**显式记录**，保留场景 `global` 恒定注入；
「工具」设置页七个标签重做，斜杠命令全部下线。

### 新增 / 变更
- **统一数据目录**：记忆、场景、人设、AGENTS.md 预设、新建/导入的技能、回收站、索引与配置全在 `~/.dsh/tool-management/` 下；旧位置（`$DSH_HOME/scene-memory/`、`$DSH_HOME/rules/`、`$DSH_HOME/subagents/`、插件 `data/`）首次启动自动搬入。
- **场景显式化**：`rules-index.json` 的 `scenes` 切片带 `label` / `description` / `order`；空场景合法；保留场景 `global`（界面「全局」）不可删；根层裸 `.md` 不再注入并会在体检里报 `noScene`。
- **技能来源**：新增插件自有来源（界面名 **「导入技能」**）作为新建/导入的落点，优先级高于 `~/.dsh/skills/`；`~/.agents` / `~/.codex` / `~/.claude` 与自定义目录仍为只读接入。
- **界面**：工具页七标签（场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话）；场景卡片补描述与绑定摘要；场景档案编辑器新增第 4 段「记忆」；人设表单的模型与工具限制收进「高级选项」（模型下拉 + 白/黑名单勾选器）。
- **契约测试 61 → 76 例**：新增客户端导出契约、装配与渲染（含带数据挂载）、技能状态文件读取韧性、技能删除权限四组。
- **DSH Market 收录徽章**：本插件已被 [DSH Market](https://dsh.market/) 收录（issue [#145](https://github.com/2BingLing/dsh-market/issues/145) 标记 `accepted`）。`README.md` 挂中文徽章、`README_EN.md` 挂英文徽章，片段取自该仓库 [PLUGIN-BADGE.md](https://github.com/2BingLing/dsh-market/blob/master/PLUGIN-BADGE.md)；两张 SVG 均实测 HTTP 200。
- **英文 README 与中文对齐**（`README_EN.md`）：此前英文版落后于中文版若干处——「Model tools」重复两行且都写 10 个（实为 12）、UI 写 "six pages"（实为七栏）、缺「记忆导入」「场景档案」「轻量子智能体」三行、多出中文版没有的「Rule checkup」一行（导致整表错位）、快速开始仍写旧的五个独立页面（实为一个「工具」面板七栏）、`rule_manager_*` 描述仍用 "rules"（应为 scene memories）。逐行核对后两版核心亮点表均为 **22 行（20 数据行）且逐行对齐**，21 条图片引用与 git 索引逐字符一致。
- **截图 `MCP.png` 大小写修复**：`docs/images/mcp.png` 被提交成小写而 README/screenshots.json 都引用 `MCP.png`，Windows 不区分大小写掩盖了这点，GitHub 上该图 404（其余六张正常）。两步 `git mv` 改名后实测 `MCP.png` → HTTP 200、`mcp.png` → 404。
- **模型工具计数与入口表更正（中英双版）**：「模型工具」由 **12 → 14**——此前两版都漏了 `agentsmd_list` / `agentsmd_apply`（模型可查/切 AGENTS.md 预设库，不提供新建/删除以免误删用户预设），现按四组写出各占几个：MCP 4 / 技能 3 / AGENTS.md 2 / 场景记忆 3 / 子智能体 2 = 14。依据是代码实测 `tools.register()` 共 14 处（`src/index.ts` 12 处 + `src/subagents/tools.ts` 2 处）。「让模型和脚本参与管理」入口表同步补上 `agentsmd_*` 与 `subagent_*` 两行（4 → 6 行数据），中英两版表格逐行对齐。

### 修复（本轮真实故障）
- **「工具」页整页白屏**：`sceneLabel` 定义在 `MemoryPage` 闭包里却被 `ScenesPage` 调用 → `ReferenceError`，被 slot 边界吞成日志。已提到模块作用域并参数化。
- **导出静默丢失**：`module.exports._pages` / `DICT` 写在 `apply` 方法体末尾，`apply` 提前返回就永不执行。已改为在 factory 作用域落地。
- **Skills 页被锁死**（弹「状态文件不可读，已拒绝覆盖」）：校验器要求每个来源都在状态文件里有记录，而新增 `hub` 来源后旧文件被判非法 → fail-closed 全停用 + 锁定写入。文件其实完好。已改为校验归一化后的文档（**缺键自愈、类型错仍拒绝**）。
- **删除权限**：`DSH 技能` 与 `导入技能` 改为**可写不可删**（技能只能停用），删除只对项目级来源开放；服务端在碰文件之前拒绝。

### 已知限制（未变）
- 浏览器交互验收仍**未跑**（宿主要 launch token）；能进 CI 的两层是导出契约与装配/渲染测试，它们挡不住交互行为。
- 硬编码中文欠账未清零（提示词页 / 会话页）；结构类问题与官方 Config schema 缺失见「已知问题」节。

---

## v0.5.0 详情 — 统一数据目录 + 场景显式化 + 界面重做（2026-09-13）

### 破坏性/结构性变更

**① 插件产生的文件全部收进一个 hub**：`$DSH_HOME/tool-management/`

```
~/.dsh/tool-management/
├─ memories/<场景>/<名>.md | <场景>/<名>/SKILL.md   记忆正文（真源）
├─ scenes/                                           场景目录（记录本身在索引里，见下）
├─ agents/<人设>.md                                  子智能体人设
├─ agents-md/<预设 id>/AGENTS.md                     全局指令基线预设库
├─ skills/                                           插件新建/导入的技能
├─ trash/                                            技能回收站；rules-trash/ 记忆回收站
├─ rules-index.json                                  启停/顺序/场景记录/档案/模式
├─ state.json                                        技能启停策略与自定义目录
└─ config.json                                       页面设置（`dsh-plugin-tool-management-settings.json` 保留原名）
```

旧位置**首次启动自动搬入**（`src/hub.ts` + `relocateLegacyLayout()` / `relocateLegacyPersonas()`）：
`~/.dsh/scene-memory/`、更旧的 `~/.dsh/rules/`、`~/.dsh/subagents/`、插件目录 `data/agents-md-presets/`。

搬迁纪律（三条，都是为了不丢数据）：**只搬不删**（源目录留空壳）、**绝不覆盖**（目标已存在同名项则跳过）、**每进程一次且失败不阻断**（旧目录仍可读）。
`~/.dsh/skills/`（DSH 官方技能目录）**不搬**：仍作为可切换来源列出，只是插件新建/导入的技能改落 `tool-management/skills/`（同名时 hub 版本优先）。

**② 场景从「恰好有这个名字的目录」升级为显式记录**

- 记录存 `rules-index.json` 的 `scenes` 切片：`label` / `description` / `order` / `createdAt`。
- **空场景合法**（可以只有描述、还没有记忆）。
- 保留场景 **`global`（界面显示「全局」）**：恒定存在、不可删除、其记忆注入任何对话 —— 保留了「全局」语义，但不再靠「`memories/` 根层裸 `.md`」这种隐式写法表达。
- **根层裸 `.md` 不再注入**，且体检会报 `noScene`（附可操作建议），不静默失效。
- 记忆写入要求场景**已存在**（`error.rules.sceneNotFound`）；导入会自动补记录并**回传** `scenes` 让界面告知用户。
- 场景名单个路径段（`a/b` 在创建与删除两侧都判非法）。

**③ 斜杠命令全部下线**：`/mcp`、`/skills`、`/agents-md`、`/scene-memory`。它们只能输出纯文本快照，既不能操作也容易与面板状态不一致；面板里每一项都有等价入口。

### 界面

- **场景页**：卡片补齐「描述 + 记忆条数 + 已绑定摘要（MCP/技能/子智能体/记忆各多少）+ 磁盘目录名」；新增「改描述」（`rules-update-scene`）；保留场景不显示删除/停用开关；统计标签从硬编码中文改走 i18n。
- **新建/改场景表单**：独立字段与文案（原来直接复用记忆的字段，出现「留空 = 全局」这类错误语义的占位符）。
- **场景档案编辑器**：新增第 4 段「记忆」（`archive.memories`，id = `<场景>/<名>`）。勾选语义与其余段同构——**段未定义 = 不碰；段已定义但没勾的记忆不进提示词**；勾选**只影响投影**，记忆文件与内容一律不动。场景改成卡片（描述 + 已勾/总数 + 「始终注入」标记），点「选记忆」进场景内的记忆明细钻取视图。四段都加筛选框。
- **档案弹窗里的勾选区拉高**（用户反馈「记忆、各种集的选择滑动框都很小」）：弹窗上限 620px → 720px，段体从写死 `height:216px` 改成 `min-height:300px` + `flex:0 0 auto`（**下限优先**），列表自身出滚动条，装不下时由 `.dsm-form` 整体滚动。
  两种写法的取舍记一笔：`flex:1` 平分看似「填满空间」，但四项分 720px 每段只剩约 155px，**比原来的 216px 还矮**——第一版就是这么写的，算完才发现。已把这条写成断言（禁止 `flex:1`、下限 ≥ 260px、弹窗上限要装得下四段下限）。
- **人设表单**：模型与工具限制收进「**高级选项**」折叠区（已配置则自动展开）。模型 = 宿主 LLM 目录里的 `provider · model` 下拉 + 「自定义」手填兜底；工具白名单/黑名单 = 勾选器，候选是**全部 Agent 预设工具名的并集**并标注「当前会话可见 / 其它预设里可用」。折叠区**首次展开才拉候选**（枚举预设需要 standing mount，不该在开弹窗时付代价）。
- **四个表单的提示去冗余**（用户反馈「辅助提示很多余，而且杂乱」）。诊断结论不是"提示太多"，而是**提示在替占位符和标签重复说同一句话**，以及**表单被当成说明书**：
  - 人设：删「人设名」提示（校验规则在输入不合法时本来就会报）、删「描述」提示（占位符的例子已说明该写什么）、删工具白名单里解释 UI 设计的最后一句；模型字段原来一处三份说明（占位符 + 提示 + 「模型来源」自己的提示）压成一句「留空继承主会话」。
  - 场景：删表单底部的第三段说明（功能说明归页面副标题）、删「描述」提示（筛选场景属实现细节）；「场景名」提示压成「创建后不可改名。」
  - 导入记忆 / 新建记忆：场景提示压成「留空 = 全局」；删「名称」提示与整段绝对路径说明。
  - 顺手修掉一处**真的自相矛盾**：同一个保留场景，导入记忆里显示「所有场景」、新建记忆里显示「全局」→ 统一为「全局」。
  - 共删 6 条提示行、改短 4 条，并同步删除词典里随之失效的 6 个键（中英各一份）。`check:i18n` 在过程中抓到一处漏删（英文词典残留 `memory.scene.field.desc.hint`），引用完整性测试抓到一处漏改（`memory.name.hint` 仍被 `t()` 调用）——两条护栏都按预期生效。
- **技能来源改名与删除权限**（用户裁定）：
  - hub 来源的界面名 **「管理器技能」→「导入技能」** —— 它是插件导入/新建技能的落点，不是"管理器自己的一类技能"。
  - **用户级来源不可删**：`DSH 技能`（`~/.dsh/skills/`）与 `导入技能`（`~/.dsh/tool-management/skills/`）**可写但不可删**，界面不再显示「移到回收站」；删除只在**项目级来源**（`<项目>/.dsh/skills`）开放。理由是用户自己放进来源目录的技能不该被插件从磁盘上搬走。
  - 可删除位是来源定义上的显式标记（`deletable`），不再从 `mutable` 推断；服务端在**碰文件之前**拒绝，错误码 `error.skill.notDeletable`（与「只读来源」的 `error.root.readonly` 区分开，提示能说清"你还能做什么"）。
  - 注意：刷新页面即可看到名称与按钮变化，但**服务端那道闸要重启宿主才生效**。
- **勾选类原语提到模块作用域**（段卡片 / 勾选行 / 筛选行 / 分组标题 / 段头动作 / 段脚注），档案编辑器与人设工具选择器共用同一套排版。
- **七个页面的副标题统一为同一句式**（`管理X：动作、动作与动作。`）：场景从「定义式 + 两句」改为与其他页同构；子智能体去掉绝对路径；提示词页与会话页的两条原本是**硬编码中文**（英文界面下永远是中文），一并接进 i18n（新增 `prompts.desc` / `sessions.desc`）。
- **i18n**：MCP 页与共享状态层（级别、运行状态、表头、表单字段、详情、确认弹窗、工具栏）从硬编码中文改为 `t()`。**剩余欠账 113 条**：提示词页 38、会话页 75（见「已知问题」）。

### 修复

| 缺陷 | 根因 | 证据 |
|---|---|---|
| **Skills 页被锁死**：弹「状态文件不可读，已拒绝覆盖」+「已安全停用所有技能」 | 校验器 `validManagerStateDocument` 要求**每个** `userRoots()` 来源都在 `sources` 里有布尔值、在 `disabledSkills` 里有数组；而 v0.4 给来源列表加了 `hub`。用户磁盘上那份 `state.json` 是加 `hub` **之前**写的（`sources` 只有 `agents/codex/claude/custom-*`），于是**版本升级本身**把一份完好文件判成非法 → `failClosedManagerState()`：全部来源停用 + 写入锁定。文件一个字节都没坏（1483 字节、合法 JSON、无 BOM，实测 `JSON.parse` 通过） | 活体验收：用户报告 + 对比 `userRoots()`（`dsh, hub, agents, codex, claude`）与文件键（缺 `hub`）。**修法**：`readManagerState` 改为校验**归一化之后**的文档（缺键补默认值），并加一道结构守卫——**缺键自愈，类型错（`sources: []`、`disabledSkills: {dsh: "x"}`）与不认识 `version` 仍然拒绝**。回归测试 `test/skills-state.test.mjs`（3 例）覆盖两侧；测试本身抓到过「自愈过宽」（`sources: []` 被静默放行） |
| 人设目录不存在时 `subagent-create` 直接 ENOENT | 人设搬到 hub 内的 `agents/` 后，全新安装该目录不存在；旧目录 `$DSH_HOME/subagents/` 一直有人建，所以从未暴露 | 活体探测返回 `ENOENT: ...\tool-management\agents\hub-probe.md` → 修后单测 `test/subagent-persona.test.mjs` 覆盖 |
| 旧布局迁移把场景目录**多套一层**（`memories/办公/办公/周报.md`） | `relocateLegacyLayout` 对目录也用了 `join(memoriesRoot, name, name)` | `test/hub-layout.test.mjs` 迁移用例抓出 |
| 英文界面下 MCP 级别筛选永远是中文且翻不过来 | `MCP_LEVEL_OPTIONS` 是**模块级常量**，`apply()` 早于 locale 注册 | 改为渲染时求值 `mcpLevelOptions()` |
| 中文界面丢失「已移除自定义目录」的目录名 | `result.custom.removed` 中文缺 `{name}` 占位符（英文有） | 新增 `scripts/check-i18n.mjs` 做键集合 + 占位符比对并接进 `npm test` |
| `skill-create` 不传 root 时技能落到 `~/.dsh/skills/` 而非 hub | 服务层 `String(args.root \|\| 'dsh')` 的默认值漏改（只改了 `core.js` 的默认值，UI 实际总是显式传 root） | 活体实测抓出 → 服务层默认值改 `'hub'`，技能页「新建」的默认来源同样改为 hub（`activeSource` 优先） |
| **导出静默丢失**：`module.exports._pages` / `module.exports.DICT` 从未生效 | 两条追加语句写在 **`apply(ctx)` 方法体末尾**（方法体从 `apply(ctx) {` 一直延续到文件倒数第 3 行），而 `apply` 开头是 `const slots = ctx.get('slots'); if (slots === undefined) return`。对象字面量在 factory 求值时定型，方法体里的追加随提前返回一起消失 | 由本轮新增的 `test/client-exports.test.mjs` 抓出（**不是浏览器抓到的**，见下方「未定性的界面故障」）。修法：`DICT` 与 `_pages` 都移到 factory 作用域，`apply` 只向占位对象填充；护栏断言「缩进 ≥ 8 空格的 `module.exports.X =` 一律不允许」 |

### 新增只读 op

- `preset-tools`：全体 Agent 预设工具名并集 + 各工具所属预设 + 当前会话是否可见（60 秒缓存；MCP 工具名 `mcp__*` 不列）。
- `model-candidates`：宿主 LLM 目录的 `(provider, model)` 对，**不发网络请求**。

### 验收证据（活体，宿主 3080）

| 验收项 | 结论 | 证据 |
|---|---|---|
| 新目录生效 + 保留场景「全局」恒定注入 | ✅ | 本轮对话 system prompt 实际出现 `## 场景记忆：全局` / `## 场景记忆：办公` / `## 场景记忆：导入场景` 三段 |
| 目录自动建出 | ✅ | `~/.dsh/tool-management/{memories/global,scenes,agents-md}` 落盘；索引 `scenes.global = {label: 全局, order: 0}` |
| 场景守卫 | ✅ | `尚未创建`→`error.rules.sceneNotFound`；删 `global`→`error.rules.reservedScene`；删非空场景→`error.rules.sceneNotEmpty`；`a/b`→`error.rules.invalidGroup` |
| 档案记忆段三态 | ✅ | 勾一条→只注入该条；段清空→该场景全不注入而 `global` 仍在；移除段→回到「不碰」（`rules-budget` 三次输出） |
| 导入自动补场景 | ✅ | 返回 `{"imported":["导入场景/导入探针"],"scenes":["导入场景"]}` |
| 游离记忆 | ✅ | 体检报 `noScene`（warning），且不进 `rules-budget` 投影 |
| `model-candidates` | ✅ | 列出 4 个来源，含 `sensenova/sensenova-6.8-flash-lite` |
| `preset-tools` | ✅ | 4 个预设、49 个工具，其中 15 个标为当前会话可见 |
| 人设黑名单落盘 | ✅ | 修 mkdir 后活体复测：`subagent-create{provider:sensenova, model:sensenova-6.8-flash-lite, tools:[read_file,glob,grep], toolsDeny:[bash,pwsh]}` → 文件落在 `tool-management/agents/hub-probe.md`，frontmatter 含 `tools: read_file, glob, grep` + `toolsDeny: bash, pwsh`；`subagent-get` 原样读回 |
| 技能落 hub | ✅（需显式 root） | `skill-state` 来源表出现 `hub  mutable=true  path=...\tool-management\skills`；`skill-create{root:hub}` → 文件落 `tool-management/skills/hub-probe-skill-hub/SKILL.md`。**实测暴露**：不传 root 时仍落到 `~/.dsh/skills/`（服务层默认值漏改）→ 已修（见「修复」表） |
| 官方技能通道可见 hub | ✅（间接） | 插件把自己的技能源注册进官方 `ctx.skills.registerProvider`（`skills/service.ts:343`），`skill-state` 的 hub 来源与 `skill-detail` 都能列出/读取 hub 内技能；**未做**「模型真实调用 `skill` 工具读到它」的端到端（会烧 token） |
| 新界面（浏览器交互） | ❌ 未验证 | 见下「本轮诚实的失败」 |

### 本轮诚实的失败（记录过程，避免下次重走）

- **想用「假 React + 假 fetch 在 Node 里驱动真实 bundle」做交互级 UI 验收**，投入很大但渲染循环迟迟不收敛：
  依次踩到 ①setState 同值高亮 → 用浅比较解决；②`build` 与事件 `insert` 顺序；③ useEffect 依赖里的
  新闭包（`[refresh]`）导致每轮重跑 → 对函数依赖改用源码文本比较；④**按树位置给组件身份会让匿名组件撞 key**，
  hook 状态串到别的组件上；⑤组件某轮未渲染时残留的 hook 游标会写错槽位（该条最隐蔽：`{deps,effect}`
  被写进了 state 槽）。判定为**不可靠地基** → 整体回退删除（不留在仓库里充数）。
- 尝试用 Playwright 打开 3080 做界面验收失败：8123 测试宿主已停，其 token 对 3080 无效（401）；
  另起的测试宿主（8134）因 `npx` 启动链路卡住未起来。
- **结论**：浏览器交互验收仍以**真浏览器 + 有效 token** 为准，本轮**未跑**；能进 CI 的那两层见下
  （`test/client-exports.test.mjs` 与 `test/client-render.test.mjs`），它们挡「导出丢失 / 装配失败 /
  渲染期抛错」，挡不住交互行为。

### 界面故障：整页白屏（2026-09-13 用户报告，已定位并修复）

用户报告「工具打开什么都没显示」，并提供了浏览器控制台栈。**根因已确定**：

```
ReferenceError: sceneLabel is not defined
    at ScenesPage (client.js:2526)
client.js:526 slot entry crashed in 'settings.section': ReferenceError: sceneLabel is not defined
```

`sceneLabel()` 定义在 **`MemoryPage` 函数体内部**（闭包），而 `ScenesPage` 渲染场景卡片时也调用它。
两个页面是各自独立的函数作用域，闭包无法共享 → `ScenesPage` 一渲染就抛 `ReferenceError`，
被 shell 的 slot 边界捕获成一条 `slot entry crashed` 日志，面板什么也不画（**整页空白**）。

- 修法：`sceneLabel` 提到**模块作用域**并把 `scenes` 作为参数传入（`sceneLabel(data.scenes, name)`），
  五处调用点全部改为显式传参。
- 同类排查：写了一次性 AST 静态扫描（页面组件里「以调用/读取形式出现、但既不在本页声明、也不在
  模块作用域声明」的标识符），**只有 `undefined` 与浏览器全局 `FileReader` 两处误报**，无第二处同类缺陷。
- 为什么前一轮的渲染测试没抓住：那一版把 `fetch` 写成直接 reject，页面停在 loading 态，
  `(data.scenes || []).map(...)` 的回调一次都没执行。**修测试**：`test/client-render.test.mjs`
  新增「带数据挂载」用例——假 fetch 按 op 返回**真实形状**的夹具（scenes / rules / 人设 / 归档都非空）、
  真的执行 effect、等 promise settle 后再渲染 4 轮。已用「把 `sceneLabel` 改名为 `sceneLabelBROKEN`」
  注入验证：该用例确实报 `ScenesPage（第 2 次渲染）: sceneLabelBROKEN is not defined`。
- 教训（与上一节同源）：**空数据的渲染测试等于没测**。列表、回调、条件分支都必须有数据走一遍。

### 排查过程留档（2026-09-13 白屏）

定位过程本身有两条可复用的教训，记下来避免重走：

- **不能进浏览器复现**：3080 宿主要求 launch token 才能开页面（`dsh-client-connection` 的
  `authorizeIndex`），我不会去进程里取用户凭据，所以**全程没有浏览器观测**，只能靠静态分析与
  自建 harness 逼近——最终是**用户贴出的控制台栈**一句话定位。以后遇到同类现象，第一件事就该是
  要控制台输出，而不是先写探针。
- **自建探针会骗人**：我一度用自写的花括号扫描器判断作用域，被 CSS 模板串与正则里的花括号带偏，
  得出「导出语句在 factory 作用域」的错误结论，随后连续多轮插桩自相矛盾。改用 **TypeScript
  编译器的 AST**（`ts.createSourceFile` + `getLineAndCharacterOfPosition`）才得到权威结论：
  `module.exports = {` 与 `return module.exports` 同属 factory，而 `_pages` 挂在 `method:apply` 里。
  **结论：判断作用域用真解析器，不要用手写扫描器。**
- 已排除的假设：宿主侧插件正常（`rules-list` op 返回 200）；`lib/client.js` 语法与解析正常；
  `ctx.get('slots')` 与官方 `dsh-client-ui-layout` 注册的服务名一致；bundle 除 `react`
  （平台种子模块）外无其它 `require`。
- 本轮第一个修复（导出的 `_pages`/`DICT` 静默丢失，见「修复」表）是**真缺陷但不是本次白屏的原因**，
  两者都保留在记录里，不合并叙述。

### 契约测试

`npm test` = build + `check:i18n` + **76 例** node --test：

- `archive.test.mjs`（13）：档案纯逻辑 + 引擎状态机
- `import.test.mjs`（16）：zip/上传展开、落点规划、限额**回报**（不静默丢）
- `approval-policy.test.mjs`（6）：`never` 审批策略探测，用真实 cordis + 真实 `ApprovalService`，兄弟 fiber 复现读取链
- `subagent-scene.test.mjs`（6）：场景绑定必须在子代理运行**之前**拒绝
- `subagent-persona.test.mjs`（9）：frontmatter 往返（`provider`/`model`/`toolsDeny`）、目录不存在时创建、重名拒绝
- `hub-layout.test.mjs`（12）：旧布局搬移不覆盖、`global` 恒在且不可删、记忆必须归属已存在场景、档案记忆段只影响投影、路径回传
- `skills-state.test.mjs`（3）：**技能状态文件读取韧性** —— 旧文档缺后来新增的来源键 → 自愈补默认值不 fail-closed；文件不存在 → 默认状态；version 不认识 / 非 JSON / 类型写错 → warning + 锁定 + 全部来源停用（fail-closed）
- `skills-delete.test.mjs`（4）：**哪些技能可以删** —— 用户级来源（DSH 技能 / 导入技能）可写但不可删，删除在碰文件之前就被拒（`error.skill.notDeletable`）；只读来源仍报 `error.root.readonly`；界面名「导入技能」
- `client-exports.test.mjs`（4）：**运行时导出契约** —— 只求值 factory（不跑 `apply`）就必须拿到
  `dict`/`pages`/`apply`；词典 zh/en 键集合一致、无空文案；代码里每个字面量 `t('键')` 都能解析。
  反向护栏：禁止缩进 ≥ 8 空格的 `module.exports.X =`；另有**档案弹窗布局契约**（段体下限优先、禁止 flex:1 平分、列表自身出滚动条）
- `client-render.test.mjs`（4）：**装配与渲染** —— 假 ctx 跑完整 `apply`，断言它往 `settings.section`
  注入并注册 `dsm-tools`；七个页面组件都被填充；整棵组件树（自建 hook dispatcher，真实 React dispatcher
  接口）递归渲染不抛错；**带数据挂载**：假 fetch 按 op 返回真实形状的夹具并真的执行 effect，
  等 promise settle 后再渲染 4 轮，列表/回调/条件分支都走到。已用「注入缺陷 → 必须失败」自检过两次
  （面板抛错；`sceneLabel` 改名 → 报 `not defined`）

辅助脚本：`npm run check:i18n`（中英键集合 + 占位符一致）、`node scripts/i18n-debt.mjs`（按页面统计硬编码中文欠账）、`node scripts/find-hardcoded-zh.mjs`（逐行定位）。

---

---

## v0.3 — 场景记忆与场景档案（2026-09-13）

### 功能

- 记忆真源从 `$DSH_HOME/rules/` 更名到 `$DSH_HOME/scene-memory/`（v0.4 已再次搬迁，见上）。
- **单投影**：活动场景的记忆正文 → per-agent `systemPrompt` 段（自动在场，模型无需任何工具调用）。原「始终层写 `~/.dsh/AGENTS.md`」下线，公共基线改由 `_shared/` 承担。
- **两相扫描 + 指纹缓存**：每次装配只做一次 `stat` 遍历产出指纹（不读正文），指纹不变直接复用上次拼接结果。**刻意不用 `fs.watch`**——Windows 上递归监听不可靠，而监听静默失效的后果是永久返回过期内容。
- **注入预算**：某条记忆放不下时只跳过它、继续装后面的小记忆，段尾附「未注入（超出预算）」清单，模型与用户都能看见。
- **场景档案**：每场景可配 MCP 工具集 / 技能集 / 子智能体绑定，段未定义 = 不改动该域，段已定义但空 = 全部停用。勾了工具/技能段的场景可「设为当前模式」：先落盘快照 → 应用 → 记忆收窄；退出按快照**原文**恢复。
- **轻量子智能体**：`subagent_run` 带人设独立运行、只回传结果（≤16 KiB）、跑完即弃、不进 History。
- **导入**：人设 / 记忆支持 `.md` 与 `.zip`（含 bundle 形态：`<场景>/<名>/SKILL.md` + 同层附件）；重名跳过并报告，绝不覆盖。
- **UI v2**：七栏（场景 / MCP / 技能 / 子智能体 / 提示词 / 记忆 / 会话），页头同构、段卡片统一、通知两级；技能同名可选来源（`preferredSkills`）。

### 关键设计决策

| 决策 | 理由 |
|---|---|
| 勾选集存储「勾选的启用集合」，MCP 落**停用补集** | 应用时该域启停 = 与勾选集完全一致；未勾服务器 → `['*']` 整台停用（通配由 guard/restrict 原生支持，服务器后加载也被拦） |
| 单一「当前模式」 | 避免多场景启停冲突；退出后 `active` **不恢复** |
| 子智能体绑定不走模式 | 按「启用场景」并集实时生效 →「记忆 + 子智能体」型场景勾上即生效，因此这类场景不显示模式按钮 |
| 手动改动不自动回写档案 | 「保存到场景」是显式动作，防静默覆盖 |
| 子智能体走官方 `ctx.subagents` 原语自建薄工具，不用 agent-preset 组合 | preset 是会话创建时加入的插件组合，与「运行中即用即弃」不符且对轻量人设过重；preset 留作将来「重型模板」载体 |
| 单工具 + 参数路由，而非每人设一个工具 | 工具清单随文件增删抖动会让 tool list 不稳定 |
| spawn provider 惰性兜底挂载（有意偏离原设计，用户批准） | yml 的 `insert` 行是启动期解析，缺该包的宿主会因单行加载失败拖垮整棵插件树；且与运行时兜底存在双挂载窗口。改为 `ctx.subagents.list()` 探测 → 缺失才 `apply()` → 失败原因原样抛给模型 |
| **非干扰原则**（最高约束） | 只走官方扩展缝（`SystemPrompt.section`、`tools.register/guard/restrict`、`ctx.subagents.start`、`cordis.patch.yml`），状态全落自有命名空间。**红线**：不得为插件功能改 DSH 原生文件语义、不得改原生段名/段序、不得破坏前缀缓存契约 |

### 验收证据（活体）

| 验收项 | 结论 | 证据 |
|---|---|---|
| 档案「勾=启用」方向（只勾 github） | ✅ | 磁盘 `{github:[], tavily:['*'], context7:['*'], …}`；运行时 github on:26 / tavily off:5；5 台未勾服务器 `allToolsDisabled:true` |
| 勾服务器 + 只勾部分工具 | ✅ | 档案存 24 个；重进模式后停用名单**恰为**未勾的那两个 |
| 全不勾 = 全部停用 | ✅ | 档案 `mcp:{}` 成功持久化；进入后 6 台全 `['*']` |
| 退出模式完全还原 | ✅ | 退出后 `disabled={}`、全部 on、`mode=null`；两次进/退一致、无残留 |
| 仅记忆 / 仅子智能体场景 | ✅ | 无模式按钮；直连 API 返回结构化拒绝 |
| 模式中删除场景 | ✅ | 拒绝并提示先退出模式 |
| 记忆收窄 | ✅ | 进入后 `active:["pw-test"]`；退出后 `active` **保持** |
| 子代理继承场景记忆段 | **实锤（继承）** | 人设要求复述「场景记忆」段首行 → 子代理返回「这是 S3 继承验证用的场景记忆首行。」 |
| 绑定外运行前拒绝 | ✅ | `Error: 人设不可用: echo-test（可用: other-helper）`，且 `runSerial` **未被调用**（不白烧 token） |
| 跨来源模型路由（决定性证据） | ✅ | 子会话 `request/header` 与 `request/context` 均为 `{"provider":"sensenova","model":"sensenova-6.8-flash-lite"}`（contextWindow 262144）；`subagent/descriptor = {mode:"one-shot", provider:"spawn", label:"other-helper"}` |
| never 预检（修复前后 A/B 同会话） | ✅ | 修复前 = `Error: the user rejected tool "subagent_run"`；宿主载入修复后 = never 专属文案。两次对照唯一变量 =「宿主是否载入带修复的 `lib/`」 |
| 三个确认门具名复跑（never 会话，真写盘） | ✅ | `rule_manager_write` → 落盘 261 B 记忆；`skill_manager_create` → 落盘 453 B 技能；两者各留 `confirm-bypass` 日志 |
| 官方 `subagent` / `subagent_fork` **无 ask 门** | ✅ | 两次实跑均无审批卡，会话日志该调用后**无 `approval/asked`**；对照本插件 `subagent_run` 弹卡 → `approval/decided {outcome:"allowed-once"}` |
| 全局记忆注入 | ✅ | 仅一条无场景记忆时 `rules-budget.usedBytes` 由 **0 → 155**（修复前恒 0：根层记忆从不注入） |
| bundle 导入三段贯通 | ✅ | UI 计数与徽章 → 磁盘字节数与 zip 条目逐一相等 → 下一轮 system prompt 出现该场景段 |
| 导入限额 7 例 | ✅ | 由其中 2 例抓出静默丢弃缺陷（见下） |
| 真实文件夹拖拽 | ⚠️ 部分 | Playwright 不支持目录投递；用忠实的合成 `FileSystemEntry` 树驱动插件真实代码路径（并抓出目录前缀丢失缺陷） |

### 缺陷与根因（本轮修复）

| 缺陷 | 根因 | 状态 |
|---|---|---|
| **C1** MCP 档案勾选语义方向反转 | `computeMcpPlan` 把勾选集当**停用名单**直写 sidecar | 已修（改产补集） |
| **C2** 模式进入缺「记忆启用集收窄为 `{S, _shared}`」，而注释/README 声称已实现 | 引擎 deps 无 active 通道 | 已修 |
| **C3**「段已定义但全不勾 = 全部停用」不可持久化 | `normalizeMcpSpec` 丢服务器级空清单 + 引擎删空段 | 已修 |
| **C4** subagent 两工具绕过 `defineTool` 注册 | 参数未编译即入库，绕过 `ToolArgsError` 校验 | 已修 |
| **C5** `subagents.*` i18n 键全缺（整页渲染原始键名） | zh/en 均零定义 | 已修（各补 21 键） |
| **C6** `['*']`（整台服务器停用）**从未真正生效** | `readDisabledTools` 用 `/^[A-Za-z0-9_-]{1,128}$/` 过滤服务器级名单，`'*'` 不匹配 → 静默丢弃。连带失效四件事：guard 热路径、整台展开、模式快照保真、勾选器 `allToolsDisabled` 标记 | 已修（解析处放行 `'*'`）。**纯自动化测不到**：引擎契约测试注入假 deps，绕过 sidecar 解析层 —— 浏览器实测抓出 |
| never 预检恒 false | `(ctx as any).approval` 在 `inject` 未声明 `approval` 时**抛异常**（`cannot get property "approval" without inject`），被 `try/catch` 吞成 `false`。对照 `dsh-tools` 用 `ctx.get("approval")` 取同一条缝 | 已修（抽到 `src/approval-policy.ts`，三个门共用一处前裁决） |
| zip 单条目 >8 MiB **静默丢弃** | fflate `filter` 回调丢弃但不回报 | 已修（逐条回报原因） |
| zip 条目 >2000 **静默丢弃** | 同上（只回报 2000 条） | 已修（条目数上限只报一次） |
| 拖文件夹时目录前缀丢失（记忆落到全局而非 `文件夹测试/…`） | 记忆/人设 `ImportModal` 用 `f.name`，丢掉 `_dssmPath` | 已修（改用 `uploadFilePath(f)`） |
| 人设 `model` 无法跨来源 | `resolveModel(provider, model)` 是二元组、不做 `provider/model` 拆分 | 已修（补 `provider` 键：frontmatter、list/get、表单、双语 i18n） |
| `SubagentResult` 诊断字段读错（读 `detail`，官方是 `diagnostic`） | 恒 undefined，失败时模型只见空输出 | 已修 |
| `parseModeState` v1 快照兼容分支是死代码 | 两个分支返回同一个 `{}`，升级前数据退出模式会把「快照启停」还原成「全启用」 | 已修（v1 布尔表折算为 v2 停用名单） |
| Minor 1 运算符优先级：allowed 为空时丢右括号且 `(无)` 永不生效 | `+` 先于 `\|\|` | 已修 |
| Minor 2 en 词典整块重复 + `memory.archive.emptySection` 只有 en（zh 用户看不到「全不勾 = 全部停用」提示） | 词典维护漂移 | 已修 |
| Minor 3 `toolStates` 不滤 `'*'` 产出 `server/*` 伪键 | 与另一处口径不一致 | 已修 |
| Minor 12 spawnReady 一次性标记（挂载失败也置 true 不重试） | — | 已修（每次调用先探测） |
| Standards 1 `lib/` 与 `src/` 同提交漂移 | lib 入库 + `lint` 只 check 2 个产物 | 已修（lib 出版本库，克隆后先 `npm run build`） |
| Standards 2 WRITE_OPS 漏 3 个写 op（`rules-trash-remove` / `rules-attach` / `rules-detach` 不受 token 保护） | op 表与写白名单是两份手工清单 | 已修（改为从各 service 的 `writeOps` 派生） |
| Standards 3 `core.js` `skillDetail` 引用未定义变量 `key`（未知来源抛 ReferenceError） | 无测试套件，只能靠运行撞上 | 已修 |
| Standards 12 `writeHistoryRetention` 吞错后仍返回 `ok:true` | 与其余域「失败必报」相悖 | 已修 |

---

## v0.2 及更早

- 五域合并为一个设置面板：MCP / Skills / AGENTS.md 预设 / History（归档会话）。
- **MCP**：工具级启停（模型看不见也调不到）、重启只重连**不改变启停状态**、密钥（`env` / `headers`）默认打码、改写补丁前自动 `.bak` 时间戳备份（保留 5 份）、重复 loader id 写前拦截、跨级迁移失败自动回滚。
- **Skills**：接入 `~/.agents` / `~/.codex` / `~/.claude` 等官方不加载的技能目录并支持自定义任意目录（只读接入、重叠拒绝）；创建 / ZIP 与文件夹导入 / 回收站（恢复、永久删除）/ 系统编辑器打开源文件；目录由后台线程监听，编辑器改完页面自动刷新。
- **AGENTS.md 预设**：多套全局指令基线，一键「应用」写入 `~/.dsh/AGENTS.md`（新会话生效、当前会话不变）。
- **History**：归档会话按项目分组、搜索、全选、批量恢复 / 永久删除、保留期自动清理；从 Claude Code / Cursor（JSONL）、Codex（Markdown）、任意文本导入对话；导出支持 Markdown / JSONL。

## 关键设计决策（长期有效）

| 决策 | 理由 |
|---|---|
| 系统提示词段必须**同步返回 string**，且只由「启用场景 + 文件内容」决定 | 段文本是会话级恒定的 → 前缀逐字节稳定 → 前缀缓存可命中。禁止在段里放时间戳/计数/相对时间 |
| `tools/pre-execute` 是全局瀑布，可拦任何工具名 | 三个确认门（`rule_manager_write` / `skill_manager_create` / `subagent_run`）都在这一层 |
| `never`（完全权限）下确认门**放行**而非拒绝 | 语义是「用户已预先批准」；且与官方子代理工具在完全权限下的行为一致。放行会记 `confirm-bypass` 日志留痕 |
| 审批策略探测必须用 `ctx.get('approval')` 而非 `ctx.approval` | 后者在 `approval` 不在 `inject` 且 fiber 链上无提供者时**抛错**，被 try/catch 吞掉后表现为「永远不是 never」 |
| 人设的工具候选取**全体预设并集** | 人设可在任意预设下被复用；只列当前会话的工具会让换预设后的子代理启动失败（官方 `toolFilter` 对未知名直接拒绝启动） |
| MCP 停用表存**勾选集的补集**，通配 `['*']` = 整台停用 | guard/restrict 原生支持通配，服务器后加载也会被拦 |
| 场景记忆的模块路径与 op 名保留 `rules-*` 内部协议 | 避免大范围改名；用户可见名称是「场景记忆」/`memories/` |
| `lib/` 不入版本库 | 曾出现同一提交内产物与 `src/` 漂移；克隆后必须先 `npm run build` |
| 浏览器端 `src/client.js` 经 `scripts/sync-client.mjs` **逐字节**复制到 `lib/` | 不走 tsc；勿改该同步语义 |

---

## 开发与验证约定

```bash
npm install
npm run build        # tsc + 同步客户端 bundle
npm run lint         # node --check 两个产物
npm run check:i18n   # 中英词典键集合 + 占位符对齐
npm test             # build + check:i18n + 全部契约测试（67 例）
```

**验证哲学**：真实行为验收优先于断言代码当前怎么实现（后者只是把实现抄一遍，必然通过）。
契约测试只锁语义（如「场景绑定必须在运行前拒绝」），**不能替代**浏览器/宿主实测。
无条件纪律：证据先于声称、诚实边界、红队自查（主动列出未验证项与做不到的事）。

---

---

---

## 已知问题（对照性审查遗留，**改代码前先读**）

> 来源：`docs/审查/2026-09-13-场景档案v2双轴评审.md` + `docs/审查/2026-09-13-全项目对抗性审查.md`（两份过程文档已合并入本文件）。
> 已修复项见 v0.3「缺陷与根因」表；下面是**仍未修**或**被撤回/改判**的部分。

### Standards 轴（代码质量）

| 编号 | 标题 | 严重度 | 问题 | 状态 |
|---|---|---|---|---|
| Standards 4 | `index.ts` 单文件 2498 行 / any 密度高 | Important | `apply()` 内嵌 51 个 handler + YAML 生成/解析 + sidecar + 鉴权门 + 工具注册；68 处 `: any`，strict TS 边界保护为零 | **未修**。建议按域拆 `mcp/patch.ts` / `history/ops.ts` / `api/route.ts`，给 op 协议定义 `OpArgs` 映射类型 |
| Standards 5 | TS/JS 混用：约定三分之二、包袱三分之一 | Important | `history/workspace.js` / `projcache.js` 是上游 esbuild 产物直接当源码；`core.js` 2956 行无类型；`rules/service.ts` 不得不再声明一遍 `ParsedSkillDoc` | **未修**。建议至少给 core.js 开 `checkJs`，workspace/projcache 注明「原样移植」 |
| Standards 6 | 五域重复基础设施 | Important | 写串行队列 ×3（逐字相同）、TTL 缓存 ×5、`message()` ×4、原子写 ×2 而另有两处裸 `writeFile`（同域四种持久化强度）、win32 identity ×3、场景名校验前后端各一份 | **未修**（收敛重复是既定方向） |
| Standards 7 | 错误/返回/日志约定不统一 | Important | skills 成功返回 `{ok:true,data}`、rules/index 返回扁平 `{ok:true,...}`；错误三种形状 → `translateError` 对 MCP/History/AGENTS.md 页完全失效；日志四通道（README 宣称的「运行日志」其实只有技能域在写） | **未修** |
| Standards 8 | 五页脚手架重复 | Important | 各页手写 title-row + 徽章 + 三格统计 + 筛选 + 空态 + 确认弹窗；操作反馈 4 种实现；缺 `PageHeader` / `SummaryBar` / `ConfirmModal` 三个共享组件 | **部分缓解**（v0.3 C 批统一了 Notice/页头/段卡片；v0.4 把勾选类原语提到共享作用域；**共享组件仍未提取**） |
| Standards 9 | 命名 | Minor | 模型工具三种前缀并存（`agentsmd_*` 是唯一不带 `_manager` 的）；`index.ts` 注释仍写旧环境变量名 `DSH_SKILL_MCP_MANAGER_TOKEN` | **部分撤回**（「README 称 10 个工具实为 12」**误报撤回**：逐一数 `tools.register(defineTool(...))` 恰好 10 个）；其余未修 |
| Standards 10 | 死代码 / Speculative Generality | Minor | `core.js` 的 `setSkillEnabled` 是纯转发；`client.js` DICT 里 `root.gemini/cursor/opencode/ccswitch` 与整组 `error.proto.*` 来自上游已裁剪协议 | **部分已修**（`rules/service.ts` 死代码已删）；DICT 死键与 Middle Man 未处置 |
| Standards 11 | `index.ts` 手写 YAML 解析（约 200 行） | Minor | 注释已声明 known limitation，可接受，但它是 index.ts 膨胀主因 | **未修**（随 index.ts 拆分处理） |

附加结论：

- **可拓展性**（专项 9）：新增第六域至少动 5 处（index.ts 的 WRITE_OPS / handlers / 工具注册 / pre-execute 门 + client.js 的 tab/新页/CSS + README），无 ops→页面→工具的域注册表接缝。**反例是好的**：新增技能来源只需在 `core.js` 的 `userRoots()` 加一项。未修。
- **「无测试套件」的复核结论**：`skillDetail` 的 ReferenceError 与门禁漂移恰好都是断言级测试能拦的；在 13k 行、五域复杂度下，「无测试」的决定已不成立 → 此后引入 `node:test` 契约测试（4 → 13 → 22 → 39 → 47 → 61 例）。

### Spec 轴（官方对齐）

| 编号 | 标题 | 严重度 | 问题 | 状态 |
|---|---|---|---|---|
| Spec Critical 1 | `workspace` 子类触达官方私有面 | Critical | `src/history/workspace.js` 读写 `requireState` / `readSessionHeader` / `enqueueOperation` / `sessionKnown` / `requireTable` / `setState` / `headers` / `sessionPaths` 等，对照 `dsh-workspace` 类型声明**全部是 private**；官方无「可替换」承诺 | **未修** |
| Spec Critical 2 | `projcache` 子类同理 | Critical | 写 `this.table`、调 `installWritePath()`、`super.put`、`requireTable().delete`（均 private）；注释自认依赖「`super.write` 返回后不再异步落盘」的上游实现细节。另：垫片引用的 `putSoft` 在锁定的 0.1.5-rc.2 中 grep=0（不存在），注释与本地证据不符（防御性写法，无功能故障，**历史出处待确认**） | **未修** |
| Spec Important 3 | 缺官方 Config schema | Important | 官方 /develop/basic/config 要求导出同名 Schemastery schema；插件只有 `{name, inject, apply}`，`config.token/presetsDir/rulesRoot/stateDir/rulesMaxBytes/maxBodyBytes` 裸读，无加载期校验与默认值（cordis 支持 Standard Schema 校验） | **未修** |
| Spec Important 4 | patch 语义核实 | Important | `disabled:true` 生效链路、`ctx.loader.entries()`、`!!js` 重入警告均**属实**。微偏：表达式并非只在 activation 求值，而是**每次读取都重算** | 核实项（无待修） |
| Spec Important 5 | inject 与实际使用漂移 | Important | — | **部分撤回 + 澄清**：①「inject `timer` 无使用」**误报撤回**——`ctx.timeout(ms)` 被 `wait()` 在 mcpm 重启轮询路径真实调用，移除会引入回归；②`ctx.get('sessions')` 在已 inject 下行为等价，判为风格项，待拆分时统一 |
| Spec Important 6 | 本地类型漂移（已漂移 2 处） | Important | `writeText` 第 3/4 参名义与官方完全不同（第 5 参按位置恰好对位）；`prepareDocument():Promise<unknown>` vs 官方 `Promise<string\|undefined>`，却被径直当 home 路径用 | **未修** |
| Spec Minor 7 | 工具命名 / `defineTool` 契约 | Minor | 官方无前缀强制；`defineTool` 六字段与 `output` 强制项全部符合；审批/禁用全走官方缝 | 符合（无需修） |
| Spec Minor 8 | systemPrompt 约定 | Minor | `section({name,order,text:provider})` 为官方 API，order 3000 落在 2900→5000 空档合法；手动 `emit('system-prompt/change')` 越过官方「注册/注销自动 emit」约定，**多余无害** | 符合 |
| Spec Minor 9 | 客户端协议 | Minor | `dsh.client.platform/inject` 合规；localStorage 用法与 `{op,args}` 协议**无官方约定可对照（待确认）** | 符合（两条待确认） |

**官方已提供但插件重写**：临时文件 + rename 原子写（官方有 `dsh-atomic-write`）、retention / archivedAt / agents-md-presets 的 JSON sidecar（官方有 `dsh-storage-domain`；projcache 一侧已正确使用）。
**官方确无、必须自写**：`fs.watch`/轮询、回收站、zip 解压（fflate）、YAML patch 编辑、token 鉴权。

### 未定性与未跑项（不是缺陷编号）

| 项 | 状态 |
|---|---|
| 一次**未被任何脚本触发**的 `scene-mode-set(null)`（模式自动退出、技能快照还原、MCP 停用表回写为空） | **未解决**。已排除进程启动触发；候选解释是自动化点击与 React 重渲染的竞态或人为点击；事后「进入 → 静置 25s」重复 1 次未复现。建议下一轮用「点击后立刻断言 mode 未被退出」的脚本跑 5 次以定性 |
| 服务器「后加载」场景（进模式后才启动的服务器是否被 `['*']` 拦住） | **未跑** |
| `subagent_run` 参数不可见的线上抓包复核 | **未做**（实际表现受模型按 description 推断与 API 宽容度掩盖，但契约偏离成立） |
| `dsh-llm types.d.ts`、`dsh-llm-deepseek` 两处引用 | **未逐行复核**（C3 结论不依赖它们） |
| 全项目审查的复核范围 | 两轴由独立子代理完成，主评审**仅复核 Critical 级发现**；Important/Minor 的行号未逐条重验 |

---

## 升级韧性（触达官方私有成员）

审阅对象：DSH `0.1.5-rc.2` → `0.2.0`。**升级官方包时按此表逐条回归**，优先 1/2/3。

| # | 触达的私有面 / 硬编码 | 升级风险 | 最先坏的回归项 |
|---|---|---|---|
| 1 | `dsh-workspace` `WorkspaceRegistry` 私有成员（`src/history/workspace.js` 的 `ArchiveWorkspaceRegistry`） | 私有成员改名/增删——**纯 JS 子类无编译期保护** | `workspace.js` 运行期 undefined 崩溃，或索引语义错位 |
| 2 | `dsh-session-projection-cache` 写路径（`src/history/projcache.js`：init 内写 `this.table`、`installWritePath()`、`super.put`、`requireTable().delete`） | 写路径成员变更；**alpha.2 已演示过 `putSoft` 移除** | 墓碑 / `whenIdle` 失效 |
| 3 | `cordis.patch.yml` 硬编码官方行 `id: workspace` / `id: session-projection-cache` 的 `disabled:true` | 官方行 id 变更或拆分即**落空** | 官方实例与子类**双注册** → 启动失败（duplicate-route throw） |
| 4 | `!!js` patch 表达式（`id!=='…'` 短路防递归） | `Entry.disabled` 是**未缓存 getter**、每次 evaluate 都重算；触碰自身行会重入 | 递归/重入风险（现有短路顺序论证成立，属脆弱面） |
| 5 | spawn provider 挂载口径（有意偏离原设计） | 若改回 yml `insert`：缺包的宿主会因单行加载失败**拖垮整棵插件树**，且与运行时兜底存在**双挂载窗口** | 现行落地是惰性探测 + 可选 peerDependency；缺 provider 时受影响面只有 `subagent_run` |
| 6 | `dsh-fs` / `dsh-settings` 本地类型声明漂移 | 官方签名再变时**无编译期拦截**（本地声明已不一致） | fs/settings 调用语义错位（当前靠「按位置恰对位」侥幸成立） |
| 7 | `inject` 声明与实际使用漂移 | `inject=['timer']` 本身正确（`ctx.timeout` 真实使用）；误按「未使用」移除会引入回归 | 评价为风格项，待拆分时统一 |
| 8 | 缺官方 Config schema | 官方要求导出同名 Schemastery schema | 无加载期校验与默认值——配置形态变更时静默走偏 |
| 9 | 官方已有能力但插件自写（原子写、JSON sidecar） | 官方演进后与自写实现语义分叉 | 原子写强度不一（两处裸 `writeFile`） |
| 10 | 已核实的官方契约点（低风险，作升级回归基线） | `disabled:true` 链路、`ctx.loader.entries()`、`dsh.bundle.patch`、`dsh.client.platform/inject`、`defineTool` 六字段与 `output`、`PreToolDecision{kind:'ask'}` / `ToolGuard` / `ToolRestriction`、`SystemPrompt.section` order 3000 空档、`agent/created\|disposed`、`SubagentStartRequest/SubagentResult/SubagentRun` 字段（`diagnostic`、`signal` 必填、无 `provider` 字段）、`ctx.subagents.start(name, request)` **双参** | 逐点回归 |

---

## 边界与未验证事项

### 做不到 / 明确的边界

| 事项 | 口径 |
|---|---|
| 子代理是否继承全局场景记忆段 | 设计期判定**静态不可判定**（in-process child 的 scope 挂接未文档化）→ 双路径：默认假设继承 + 运行时验证。**实测结论：继承**（人设复述段首行成功） |
| 官方 subagent 通道的治理 | 官方 `subagent` / `subagent_fork` 是宿主能力，**无 ask 门、不认插件人设**；插件的确认门与场景绑定**只覆盖 `subagent_run`**（实测：同一条消息里官方 `subagent` 无卡直接返回，紧接着的 `subagent_run` 才弹卡） |
| 官方工具在 `never` 会话下的行为 | **未单独实跑**：这是「无 ask 门」的直接推论（never 只作用于 ask；无 ask 可判即无可拒） |
| 模式期间的手动改动 | 按「手动改动不自动回写档案」，**不保留** |
| 档案应用写入强度 | 对 N 个工具/技能是**逐条写**（写锁内串行）；量大时可优化为一次原子写，**v1 未做** |
| `subagent_run` 的失败分支（spawn provider 缺失） | 本机宿主最新版自带 provider，**构造不出该形态 → N/A** |
| 人设删除 | UI 上人设**不入回收站**（删了就是删了，v1 从简） |
| 人设文件不可被模型改写 | v1 **无 subagent 写工具**，只能人为编辑磁盘文件 |
| 子智能体并发 | v1 串行队列（同一时刻至多 1 个），`maxDepth: 1` 防递归套娃 |
| 子代理会话落点 | 内存态 + `dispose()` 移除，**不落盘、不进 History** |
| `subagent_fork` / continuable 子代理 | **未接入**（v1 范围外） |
| 契约测试的边界 | 引擎状态机用例是**注入假 deps** 的契约测试，替代不了真实写通道——C6 正漏在这层 |
| 方案 B 与宿主策略相悖（有意为之） | 插件确认门语义是「问用户」→ never 时放行并留痕；宿主 `decide()` 的 never=自动拒绝针对的是「没人可问」 |
| never 探测的降级边界 | 只在读取链**完整可用**时生效；无 approval 服务 / 无 `exec.agent.session` / 读取抛错一律返回 `false` → 退回正常问询，**绝不因「读不到」而擅自放行** |
| 首选技能指向已停用来源 | 该条目**仍赢分组**（键未失效，语义 =「这是用户选的来源」），行上如实显示「已停用」运行态（边界观察，非缺陷） |
| 导入的部分成功语义 | 重名**跳过并报告**（绝不覆盖）；非法名 / 空内容 / 超限条目单条跳过、其余照常 |
| 导入的安全边界 | 绝对路径、`..` 穿越、隐藏项一律丢弃并回报 |
| 非干扰原则的红线 | 任何时候不得为插件功能改 DSH 原生文件语义、不得给原生段改名/改序、不得让注入内容破坏前缀缓存契约。违反任一条即**架构回归** |

### 未采纳方案

| 方案 | 理由 |
|---|---|
| 官方 agent-preset 组合当子智能体载体 | preset 是插件组合目录、会话创建时加入，与「运行中即用即弃」不符且对轻量人设过重；留作将来「重型模板」载体 |
| 每人设注册独立工具 | 工具清单随文件增删抖动，tool list 不稳定 |
| 用 `tools/restrict` 控制人设可见性 | 单工具形态下无 per-persona 工具可 restrict；改为 execute 时校验（语义等价且更简单） |
| 钩子（hooks） | 用户范围裁定「不做」 |
| 斜杠命令（新增） | 用户范围裁定「不做」（与 skills 触发方向相反、无增量）；**v0.4 进一步把已有的四条也删了** |

### 计划与实现的偏离（记录实际做法）

1. 未安装 devDep `@deepseek-ai/dsh-subagent`（改用结构化 any + `createRequire`）。
2. spawn provider 挂载改为**惰性探测 + createRequire**（原计划的 yml 挂载行未用）。
3. `subagent_list` 的 `parameters` 必须能生成 `type:object`（空对象产出 `type:null` 会被模型 API 拒绝）→ 加了可选 `scene` 参数。
4. `ctx.subagents.start` 实际签名是 **`start(name, request)` 双参**（原计划误写单对象）。
5. 删除场景时联动清理档案/模式引用（原计划未覆盖；评审后进一步改为**拒绝删除当前模式场景**）。
6. `tsc` incremental（`tsbuildinfo`）曾导致 `lib/index.js` 未重编译、工具 schema 改动未生效 → 重建时删 `tsbuildinfo` 强制全量；**日后遇「改了没生效」先清它**。
7. 启动期 `refresh` 改为合并式更新（修「场景」tab 白屏）；另修：客户端 null 段泄漏为空段定义、`openDrill` 引用已删 state、zh 字典丢键、弹窗缺「添加段」按钮。

### 一次性事项（照实登记）

- 首轮未跑、后续已补齐的：确认弹窗人工点击放行、`subagent_run` 端到端、拖放实拖、导入限额、bundle 导入、官方子代理无 ask 门。
- **仍未补**：官方工具在 `never` 会话下的行为；服务器「后加载」场景；`subagent_run` 参数不可见的抓包复核；一次未被脚本触发的 `scene-mode-set(null)` 的定性。
- 清理测试数据时删除的 `session-bf211678`（测试宿主首次加载自动创建的空会话）**删除前未逐一核对内容**——如实登记，该会话应为空。
- `skill_manager_create` 首轮 `EPERM: rename … .dssm-create-<uuid>` 重试即成功、插件已自行回滚、目标目录无残留 → 判为 Windows 瞬时锁（非插件缺陷）。
- 真实**文件夹拖拽**（Chromium `webkitGetAsEntry` 目录 API）无法用 Playwright 触发（`Dropping a directory is not supported`）；改用**忠实的合成 `FileSystemEntry` 树**驱动插件真实代码路径（并抓出目录前缀丢失缺陷）。
- 测试数据清理声明「`.playwright-cli/` 已删除」与实际不符（目录仍存在）→ v0.4 已把它加进 `.gitignore`。


