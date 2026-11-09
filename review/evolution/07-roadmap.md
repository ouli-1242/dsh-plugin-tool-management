# 07 · 阶段、迁移、待定项

## 1. 分五个阶段，每个阶段自己可验收

规模标签：小（1 个模块）/ 中（2–3 个）/ 中大（跨模块）/ 大（含模型调用与 UI）。

> **实施状态（2026-11，分支 `feat/proactive-memory`）**
>
> - **P0 已落地**（`4ce8768`）：层常量、三级开关、catalog、保留段不进场景。
> - **P1 已落地**（`2543c88` 热路径 / `3689629` 界面）：九道门、写入管线、自动段注入、
>   两条工具（`learn` / `forget`）、记忆页开关卡与自动记忆列表、候选确认流。
> - 与本文的**四处偏差**，都是实现时才看清的：
>   1. **catalog 不是纯增量**：`learn` 走增量（`touchCatalog`），但记忆域任何写操作之后
>      与启动时都做一次全量重建。理由是删除/编辑走的是记忆域的 op，它不知道 catalog 的
>      存在，而注入只读 catalog —— 不重建就会出现"删了还在注入"。300 条约 40ms，值得。
>   2. **新增 `evolution-approve`**（设计里没有）：候选不注入，而九道门的设计是"模糊就
>      降级"，没有确认入口的话候选只增不减。换层/合并仍留给 dream。
>   3. **`evolution-toggle` 支持 `inherit`**：逐字段覆盖必须有"清除覆盖"这条路，
>      否则用户点过一次下层就再也回不到跟随。
>   4. **时间线、停用、提升为用户记忆三件事没做**：`evolution-list` 已经带回
>      `transitions` 与 `counters`，界面接上去即可；提升会动用户记忆，等 dream 一起。
> - **P1 未做**：`memory_manager_list` / `read` / `organize` 三条工具。模型目前只能学与忘，
>   看不了已有条目（设计里 `list` 是 P1 的一部分，实际只做了 UI 侧的读）。

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

- `session/event` 累积 digest；`turn/end` 封存。
- `episodes/` + `outbox.jsonl` + 幂等重放。
- 复习器（宿主 llm）+ 严格 JSON + 成本上限（每会话 ≤2 次）。
- `pending.json` + 待确认 UI + 时间线。
- `memory_manager_organize`（只出草案）。
- dead-letter + 失败可见。

**验收：crash 重放 0 重复；模型失败降级不影响会话；复习成本 ≤3%。**

### P3 dream（中大）

- episode 30 天裁剪；会话层 GC。
- dream 输入/输出/校验/diff/应用/回滚。
- TTL / 衰减 / 配额淘汰。
- 健康度面板。
- 工作区路径失效、改名合并提示。

**验收：100 条库整理后注入 token 不升；输入库不动；回滚 100%。**

### P4 程序性记忆（大，可选）

- `procedure` 类型 + 步骤结构 + 成功计数。
- playbook 晋升 + 注入只放标题。
- 技能提议（`skill_manager_save` 确认卡 + 写后 lint + 回滚）。
- `learned` 徽章。

**验收：0 个不可加载技能；全部可回滚；全部人工确认。**

## 2. 阶段依赖

```text
P0 ──► P1 ──► P2 ──► P3 ──► P4
       │      │
       └──────┴──► 可以停在 P1（只有热路径，没有后台复习）
```

P1 结束就是一个可用的功能：模型能主动记、能忘、能注入。P2 之后才是"自己会整理"。如果只想先验证"主动记忆有没有用"，做完 P1 就够。

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
