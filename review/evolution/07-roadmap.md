# 07 · 阶段、迁移、待定项

## 1. 分五个阶段，每个阶段自己可验收

规模标签：小（1 个模块）/ 中（2–3 个）/ 中大（跨模块）/ 大（含模型调用与 UI）。

> **实施状态（2026-11，分支 `feat/proactive-memory`）**
>
> - **P0 已落地**（`4ce8768`）：层常量、三级开关、catalog、保留段不进场景。
> - **P1 已落地**（`2543c88` 热路径 / `3689629` 界面 / 后续补齐）：九道门、写入管线、
>   自动段注入、五条工具（`learn` / `forget` / `list(auto)` / `read` / `organize`）、
>   记忆页开关卡、自动记忆列表、候选确认、时间线、停用/恢复、提升为用户记忆、整理草案。
> - **P2 已落地**（冷路径）：`digest`（轮内摘要）/ `episodes`（outbox + dead-letter）/
>   `review`（复习器 + 预算 + 退避）/ `cold`（事件接线）四个模块；`turn/end` 只认
>   `completed`；同会话串行、不同会话并行；`evolution-queue` / `evolution-replay` 两条
>   op 与记忆页的「后台复习」三栏（待复习 / 失败 / 无法处理）+ 手动重跑。
> - **P2 的一处推迟**：`pending.json` 与「待确认」UI 没做。理由：这个队列的生产者是
>   `dream` 的改写/删除提议（P3）与技能提议（P4），P2 阶段没有任何东西会往里放 ——
>   先做一份永远是空的文件加一块永远不出现的界面，只会让"待确认"这三个字在用户眼里
>   失去意义。弱记忆的确认入口不需要它（`candidate` + `evolution-approve` 已经有了）。
> - **P3 已落地**：`dream`（草案 / diff / 应用 / 整批回滚）与 `maintenance`（维护扫描）
>   两个模块；每日轮末自动整理、启动时每天一次维护；记忆页「全库整理」区（健康度、
>   草案清单、逐份 diff、应用 / 回滚、维护预览与执行）。详见下方 P3 章节。
> - **P4 已落地**：`procedure`（步骤结构 / 成功计数 / playbook 晋升 / 技能提议的安装与
>   回滚）一个模块，`INJECTABLE_STATUSES` 统一注入状态白名单；`memory_manager_procedure_done`
>   工具、记忆页「程序性记忆」区、技能页「已学会」徽章。详见下方 P4 章节。
> - **决策 #4「技能进化不进 v1」仍然成立**：P4 做的是"用户确认后才写一份技能"，不是
>   自动技能进化。开关默认关、自动记忆工具默认隐藏、草案默认不应用、技能默认停用；
>   决策 #4 划的是 v1 的边界，P4 是它之后的最后一档，两者不矛盾。
> - **`pending.json` 最终取消**（不是继续推迟）：P3 的草案落在
>   `evolution/dreams/<id>/`（`draft.json` + `manifest.json` + `backup/`），**每一份待审阅
>   草案就是一条待确认项**，而且自带 diff、原由、备份与状态机。再造一份 `pending.json`
>   等于把同一批提议存两遍，还要处理两份状态的一致性。技能提议（P4）届时单独用确认卡，
>   走的不是记忆库。
> - 与本文的**五处偏差**，都是实现时才看清的：
>   1. **catalog 不是纯增量**：`learn` 走增量（`touchCatalog`），但记忆域任何写操作之后
>      与启动时都做一次全量重建。理由是删除/编辑走的是记忆域的 op，它不知道 catalog 的
>      存在，而注入只读 catalog —— 不重建就会出现"删了还在注入"。300 条约 40ms，值得。
>   2. **新增 `evolution-approve`**（设计里没有）：候选不注入，而九道门的设计是"模糊就
>      降级"，没有确认入口的话候选只增不减。换层/合并仍留给 dream。
>   3. **`evolution-toggle` 支持 `inherit`**：逐字段覆盖必须有"清除覆盖"这条路，
>      否则用户点过一次下层就再也回不到跟随。
>   4. **停用与删除是两回事**：停用 = `archived`（文件留着、可恢复、不写墓碑）；删除 =
>      `archived` + 回收站 + 30 天墓碑。设计里只有 `forget`，但用户"别再拿它烦我"和
>      "别再存在"是两种意图，合并成一条会让人不敢点。
>   5. **`organize` 只算规则草案，不做模型整理**：相似度 / 陈旧候选 / 高置信+被用过，
>      三条判据都是确定性函数。模型整理的语义留给 P3 dream（它才有 diff 与回滚）。
> - **`allow` 与 `deny`**：`forget` 目前仍绑在开关上（设计写的是"开关关时可见"）。
>   偏差理由：开关关着时自动条目本来就不注入，模型看不到也就不会主动提；真要删走界面。
>   若后续发现"用户口头要求删、模型够不着"是常见路径，再把它从 `autoAllow` 里摘出来。
>
> ### 界面收敛（2026-11-09，用户反馈："一个按钮、一个弹窗、一个开关、一个工具"）
>
> - **自主记忆从平铺卡片搬进弹窗**：记忆页页头「回收站」左边加一颗按钮，点开弹窗。
>   原先卡片里的三级分段开关（全局 / 本工作区 / 本会话）、生效来源、三段长说明全部撤掉；
>   弹窗第一屏只剩一个总开关、一行「已学 N 条」和条目清单，后台复习 / 全库整理 /
>   程序性记忆折进「更多」。确认弹窗另用一个状态槽，才能叠在自主记忆弹窗之上。
> - **总开关会清下层覆盖**：三级配置本身没删（策略层仍支持），但界面不再给入口，
>   所以每拨一次总开关都会把本工作区 / 本会话已存的 `enabled` 覆盖清成「继承」——
>   否则"全局已开、本会话仍关"这种状态在界面上再也拨不回来。
> - **四条新增工具并成一条 `memory_manager_auto`**：`action=learn|forget|organize|done`。
>   四个 op、九道门、procedure 计数一个字没改，只合并入口；旧名写进
>   `LEGACY_TOOL_NAME_MAP`，避免盘上的关停名单变成死名。工具表少三行、词典只要一条介绍。
> - **工具与总开关双向同步**：这条工具没有独立于开关的状态。开 → 强制可见且不可关；
>   关 → 强制隐藏且不可开。最初只做了"开"这一半：开着时保存过一次工具表，盘上名单
>   就永久不含它，而 `DEFAULT_HIDDEN_TOOLS` 只在首次铺底 —— 关掉开关后模型手里仍留着
>   一条"看得见、调了只会报错"的工具。现在 `normalizeProactiveToolHidden` 一份纯函数给
>   全局/会话读路径、两条写路径、体积报表共用；回包同时给 `forcedVisible` /
>   `forcedHidden`，面板把该行锁在对应状态；`evolution-toggle` / `evolution-settings`
>   写完后立刻 `mcp.scheduleToolRestrictions()`，不等下一次 `tools/change`。设计里
>   "用户可手动开关每一条工具"这条对自主记忆不再适用 —— 它是开关本身的一部分。
> - **`05-tools.md` 的三条新增工具表**以本节为准（那条文档写的是 P1 时的形状）。

### P0 地基（小）

- `layer` 常量与 `_ws` / `_session` 保留段；目录创建按开关。
- `evolution/settings.json` + `workspaces.json` + `sessions.json` 三级读写（KV + TTL）。
- `EffectiveConfig` 解析 + 注入层取用。
- catalog 结构与构建/重建；`mtime/size/hash` 失效。
- 记忆页开关卡（三级作用域 + 来源显示），只读展示。
- `memory_manager_list/read` 加层字段与 `injects` 标记。
- **`renderSceneMemory` 排除保留段**（现在什么都不加，只是不让它们混进场景段）。

**验收：现有记忆注入逐字节不变。** 这一条是回归底线，先钉死再加东西。

### P1 热路径（中）

- `memory_manager_learn` + 工具可见性（开关关 → 不可见）。
- 九道门 + 证据逐字校验 + 路由 + 去重 + 冲突 + 墓碑。
- `state.json` 原子写；`catalog.json` 增量更新。
- `renderAutoBlock()`：独立预算、排序、截断、两层权威声明。
- 会话快照（`WeakMap<agent, {key,text,fingerprint}>`）。
- 记忆页「自动记忆」区：按层分组、编辑/停用/删除/提升。
- `memory_manager_forget` + 确认卡。
- `SCENE_MEMORY_NOTE` 改为「user-authored」，新增 `AUTO_MEMORY_NOTE`。**会导致所有会话重发一次记忆段，CHANGELOG 写明。**

**验收：fixtures 的 preferences / corrections / secrets / dedupe / layers / budget / conflict 全过。**

### P2 冷路径（中大）

- 已落地：`session/event` 累积 digest；`turn/end` 封存。
- 已落地：`episodes/` + `outbox.jsonl` + 幂等重放。
- 已落地：复习器（宿主 llm）+ 严格 JSON + 成本上限（每会话 ≤2 次）。
- 推迟：`pending.json` + 待确认 UI（推迟到 P3：P2 没有生产者，见上方实施状态）。
- 已落地：时间线（P1 已落；复习的 `actor` 写作 `learn`）。
- 已落地：`memory_manager_organize`（只出草案，P1 收尾时落地）。
- 已落地：dead-letter + 失败可见（`evolution-queue` + 「后台复习」三栏 + 逐条重试）。

**验收：crash 重放 0 重复；模型失败降级不影响会话；复习成本 ≤3%。**

### P3 dream（中大）

- 已落地：episode / outbox 保留 30 天（`prune` / `compact`）；会话层 14 天 GC。
- 已落地：dream 输入只读（条目一行摘要 + 最近 episode）、严格 JSON 校验、每份草案带
  reason、应用前完整备份、整批回滚（含 `drift` 保护）。
- 已落地：TTL 到期降候选并标待确认、180 天衰减、层配额按分数清候选（每次 ≤20%）、
  工作区目录消失 90 天归档。全部只改状态，不删文件。
- 已落地：健康度面板（注入体积 / 待确认 / 冲突 / 过期）与维护预览（`dry`）。
- 推迟：工作区**改名合并**提示（需要宿主给目录改名事件，目前只有"消失"，没有"搬去哪"）。

实现时才看清的三件事：
1. **校验跑两遍**：生成时单条不合法只丢那一条，应用时**任何**一条不合法就整批拒绝。
   草案可能躺了两天，库已经变了；半套合并比不合并更糟。
2. **候选不能直接升 core**：治理表的状态机是 candidate → active → core，跳档会让一条
   从没被注入过的弱推断直接占常驻额度。升 core 还要 `helpful ≥ 3` 且 `harmful = 0`，
   `setStatus` 里再判一次（那道才是权威）。
3. **回滚比反向重放简单也更对**：备份整份盖回去是 O(1) 的正确性；逐条反向操作要能
   重放每一步的中间态（merged from / 旧边界 / 旧索引），算错一步就是个说不清的状态。
   代价是会覆盖应用之后的新写入，所以先比 `state.json` 摘要，不一致就拒绝（`force` 才越过）。

**验收：100 条库整理后注入 token 不升；输入库不动；回滚 100%。**

### P4 程序性记忆（大，可选）— 已落地

- 已落地：`procedure` 类型 + 步骤结构（真值在 `state.json`，正文的编号列表是给人读的
  投影）+ 成功/失败计数（只认 `memory_manager_procedure_done` 的显式回报）。
- 已落地：`core → playbook` 晋升（成功 ≥ 3、harmful = 0、有 ≥ 2 步、无待确认，
  不认 active → playbook 的跳级）；注入只放标题 + id，L0 常驻待遇跟着走。
- 已落地：技能提议（出草案 → 界面确认卡 → 写后回读 lint + 技能清单可加载校验 +
  失败自动移进回收站）；走技能域自己的 `skill-create` / `skill-delete`，落点、默认停用
  与回收站纪律和界面完全一致。
- 已落地：`learned` 徽章（`evolution/learned-skills.json` sidecar）与
  `evolution-skill-rollback`（移进回收站并摘徽章，原记忆与步骤不动、可再生成）。

实现时才看清的四件事：
1. **步骤不能放 frontmatter**：`parseSkillDoc` 只认顶层 `key: value`，数组进去会被压成
   半句话。所以结构化步骤放 `state.json`，frontmatter 只留 `auto_title` 与 `auto_steps`
   两个标量；正文解析只用来给"有正文、没状态"的旧条目兜底。
2. **成功只认显式回报**：设计里"工具全成功"那句暗示可以从轮末自动推断，但一次无关的
   对话也会被算进去 —— 三次误判就能把一条没跑过的做法升成 playbook。改成模型做完之后
   调一次 `memory_manager_procedure_done`（界面也有按钮），`memory_manager_read` 读
   procedure 时会把这句话附在正文后面。
3. **技能写入走 op 而不是 `skill_manager_save` 工具**：那条是给模型的，带"只在用户指令
   下"的契约与自己的审批门禁；界面这边的确认卡是另一次授权。两者最终都落到
   `skill-create`，差别只在谁点的确认 —— 直接调 op 不会绕过门禁，也不会让模型以为
   它能自己建技能。
4. **`learned` 徽章不写进技能文件**：技能格式是宿主的，往 frontmatter 塞私有字段会让
   别的工具读到不认识的键。sidecar 名单只在自己的页面与 op 里用，回滚时删一行即可。

另外：**playbook 是 `auto_status` 的新一级**，原先散落在各处的
`status === 'active' || status === 'core'` 统一收进 `INJECTABLE_STATUSES` —— 漏改一处的
症状是"清单里显示生效、注入里永远看不见"。维护扫描**有意跳过** playbook：它是验证 +
人工确认链的成果，不该被 TTL / 衰减降回候选；要下线由用户手动归档。

**验收：0 个不可加载技能（lint 不过即回滚）；全部可回滚（移进回收站，可恢复）；
全部人工确认（`confirm !== true` 后端直接拒）。测试覆盖三种 lint 失败、清单不可加载、
同名不覆盖、重复应用、回滚后可再生成。**

## 2. 阶段依赖

```text
P0 ──► P1 ──► P2 ──► P3 ──► P4
       │      │
       └──────┴──► 可以停在 P1（只有热路径，没有后台复习）
```

P1 结束就是一个可用的功能：模型能主动记、能忘、能注入。P2 之后才是"自己会整理"。如果只想先验证"自主记忆有没有用"，做完 P1 就够。

## 3. 兼容与迁移

### 3.1 从 0.22.5 升级

- 首次打开开关才创建 `memories/_ws/`、`memories/_session/`、`evolution/`。关闭时不创建、不扫描。
- `memories-index.json` 结构不变（`version: 1`），只多 `rules` 条目。
- 现有用户记忆、场景、导出/导入、回收站行为不变；自动记忆是增量。
- 关闭开关后文件仍在磁盘，投影跳过；UI 显示「已暂停」。重开恢复。
- 卸载插件不删 `memories/` 与 `evolution/`——它们是用户数据，不是缓存。README 写明。

### 3.2 从 v0.2 草案迁移

v0.2 的 `memories/_auto/*.md` 带 `auto_scope` 字段：

| `auto_scope` | 迁到 |
| --- | --- |
| `global` | `memories/global/` |
| `workspace` | 当前 cwd 的 `_ws/<hash16>/`（取不到则 `global/` 并标 `auto_degraded`） |
| `scene` + `auto_scene` | `memories/<scene>/`（场景不存在则 `global/`） |

迁完写 `memories/_auto/.migrated`（内容为时间戳），不删原目录——留作回滚。**只在开关首次打开时迁一次**。

### 3.3 降级风险（必须写进 README）

旧版本（< v0.3）不认识 `_ws` / `_session`，会当成两个普通场景渲染：

- 症状：记忆页多出两个叫 `_ws`、`_session` 的场景，内容是乱的；注入段出现 `## Scene: _ws`。
- 不是数据损坏，但会让模型看到不该看的层归类。
- **降级前必须**：关开关 → 导出 → 清空 `_ws` / `_session`（或整体移走）。
- UI 的「关于」里给这条路径。

不自动处理的原因：旧版本没有"保留段"概念，任何自动规避都会变成隐式特例，更难解释。

## 4. 待你拍板的 9 件事

每条都给了建议。回「全按建议」或指出反对项。

| # | 问题 | 建议 | 影响 |
| --- | --- | --- | --- |
| 1 | 默认 `learnScope` | `global`（到处学），但 `enabled` 默认 `false` | 打开即用，不用先选项目 |
| 2 | 自动写入策略 | 高置信事实/偏好/纠正直接写（可撤销）；procedure/改写/删除待确认 | 体验流畅 vs 安全 |
| 3 | 复习用哪个模型 | 默认会话当前模型；可配更便宜的；每会话 ≤2 次 | 默认换模型会让学到的东西风格不一致 |
| 4 | 技能进化进 v1 吗 | 不进。v1 只做 memory + procedure 提议 | 技能写坏的影响面比记忆大 |
| 5 | 自动段预算 | 动态 `clamp(contextWindow×1.5%, 800, 2400)`，默认 1600；条数 40 + L1 门槛 | 已定（04-governance §3） |
| 6 | 会话级开关是否持久化 | **持久化**到 `sessions.json` | 不持久化的话重启就忘，用户以为关了其实又开了 |
| 7 | 会话层是否允许手写 | **允许**，但需确认卡（"只在这个对话有效"） | 用户说"这次别动 migrations，记住"是合理诉求 |
| 8 | 三个保留段的前缀 | `_ws` / `_session` / `_shared`（现有） | `_` 开头已经过不了 UI 的场景名校验，天然保留 |
| 9 | `_auto` 迁移是否保留原目录 | **保留**，只写 `.migrated` 标记 | 回滚需要 |

## 5. 还没想清楚的（明确列为风险，不是遗漏）

| # | 问题 | 当前处理 | 什么时候必须解决 |
| --- | --- | --- | --- |
| 1 | 工作区 hash 后，用户看不出 `_ws/3f2a` 是哪个项目 | UI 显示 `workspaces.json` 的 `label`；CLI 不暴露目录名 | P3 之前 |
| 2 | 跨工作区的"同一项目"识别（clone / 改名） | 只提示不自动合并 | P3 |
| 3 | 复习模型的 prompt 会不会随记忆增长而变长 | 只给 catalog 的 oneLine，≤80 条；超了按分数截断 | P2 |
| 4 | 多语言（中英混写）的 Jaccard 去重准确率 | 0.82 阈值偏保守，宁可漏合并 | P1 评测 |
| 5 | 会话被宿主删除后，`sessions.json` 的孤儿 | 30 天 GC；读不到存活清单时不剪 | P3 |
| 6 | 用户在两个窗口同时改同一条记忆 | `withWriteLock` + 版本号；冲突时后者收到"已被修改" | P1 |

## 6. 代码落点（详细版见 `08-appendix.md`）

| 文件 | 改动 |
| --- | --- |
| `src/memories/constants.ts` | `LAYER_*`、`WORKSPACE_GROUP_PREFIX='_ws'`、`SESSION_GROUP_PREFIX='_session'`、`AUTO_MEMORY_NOTE`、预算常量 |
| `src/memories/discovery.ts` | `deriveFromDoc` 读 `auto_*`；`groupToLayer()` 前缀识别 |
| `src/memories/projection.ts` | `resolveActiveScenes` 的 `knownScenes` 排除保留段；新增 `layersFor(agent)` |
| `src/memories/snapshot.ts` | `renderSceneMemory` 排除保留段；新增 `renderAutoBlock()`；`SCENE_MEMORY_NOTE` 改文案 |
| `src/memories/catalog.ts` | **新增**：catalog 构建/增量/失效/重建 |
| `src/evolution/config.ts` | **新增**：三级配置读写 + `EffectiveConfig` |
| `src/evolution/state.ts` | **新增**：`state.json` 原子读写 + 版本迁移 |
| `src/evolution/gates.ts` | **新增**：九道门 |
| `src/evolution/review.ts` | **新增**：复习器（模型调用 + JSON 校验） |
| `src/evolution/dream.ts` | **新增**：草案生成/校验/应用/回滚 |
| `src/tools/memory.ts` | 加 `learn` / `forget` / `organize`；`save` 加 `layer`；`list/read` 加字段 |
| `src/ops/memory.ts` | 加 `rules-learn` / `rules-forget` / `rules-promote` / `rules-edit-auto` |
| `src/index.ts` | 配置接入；工具可见性；`session/event` 捕获；`turn/end` 封存；注入接入；审批分支 |
| `src/http-api.ts` | 10 个 `evolution-*` 端点 |
| `src/client/47-memory.js` | 开关卡、自动区、待确认、时间线、健康度 |
| `src/client/30-dict.js` | 中英文案 |
| `test/evolution/*.test.mjs` | 8 组 fixtures + 6 条行为测试 |
