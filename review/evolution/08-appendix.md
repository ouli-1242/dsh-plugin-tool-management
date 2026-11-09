# 08 · 附录：外部对照、代码落点、术语表

## 1. 外部实现对照（核对日期 2026-11）

### 1.1 总表

| 实现 | 默认 | 存哪 | 注入什么 | 整理 | 作用域 | 开关 |
| --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** auto memory | 开 | 机器本地，按项目分目录 | `MEMORY.md` 索引，每次只加载前 200 行或 25KB；主题文件按需读 | 无显式整理 | 项目 / 全局两层 | 单一开关 |
| **Codex** memories | **关** | `~/.codex/memories/` | `memory_summary.md` 约 2500 token | 两阶段 + SQLite（租约、水位、幂等）；6h 空闲 | 机器本地 | `generate_memories` / `use_memories` 分离 |
| **Hermes** | — | episodic / semantic / procedural 三层 | 渐进披露 | observe→distill→reuse→refine；3+ 次重复生成 SKILL.md | 全局 | — |
| **Mem0** | — | 托管 / 本地 | 混合检索 | 2026 版改 **ADD-only**（冲突靠检索排序，不删除） | `user_id` / `agent_id` / `run_id` | — |
| **Letta / MemGPT** | — | core / recall / archival | core 块常驻 | agent 自编辑记忆块；sleep-time compute | 按 agent | — |
| **Anthropic Dreams** | 手动 | 输入 store 不动，输出新库 | — | 异步任务，最多 100 会话 | — | — |
| **ACE** | — | bullet 列表 | 全量 | Generator/Reflector/Curator；delta + 计数器 | — | — |
| **Cursor** Memories | 开 | 云端，按项目/按人 | 自动附加 | 后台提议 + 用户批准 | 项目 / 个人 | 单一开关 |

### 1.2 六条可直接借用的结论

1. **Claude Code 的索引模式**：`MEMORY.md` 当索引、主题文件按需读。本设计的 `catalog` + 正文懒加载是同一思路，但 catalog 是机器生成的，不靠模型维护。
2. **Codex 的写/用分离**：`generate_memories` 与 `use_memories` 是两个开关。本设计采纳，并扩展成三级继承（`01-model.md` §3.3）。
3. **Codex 的两阶段 + 水位 + 幂等**：本设计的 outbox + watermark + `(sid, turn, seq)` 幂等键直接对应。
4. **Anthropic Dreams 的"输入不动、输出新库"**：本设计的 dream 草案 + 人工确认。**这一条不能省**——整理是全库操作，出错代价最大。
5. **ACE 的 delta + 计数器**：本设计禁止整段重写，只追加证据和计数器。ACE 实测过 context collapse：18,282 token 在多轮重写下被压到 122 token，准确率掉 9.6 分。
6. **Cursor 的"提议 + 批准"**：证明"后台提议、用户批准"可以产品化，不必全自动。

### 1.3 三条不能照搬的

| 做法 | 为什么不行 |
| --- | --- |
| Codex 的默认关 → 本设计也默认关 | 这一条**采纳了**，但 Codex 只有一个全局开关，没有"只给这个项目开"。本设计加三级继承 |
| Hermes 的"3+ 次重复自动生成 SKILL.md" | 技能写坏的影响面比记忆大一个数量级。本设计只提议，不自动写 |
| Mem0 的 ADD-only | 只解决"冲突不删"，没解决"库无限膨胀"。本设计保留淘汰与 TTL |

### 1.4 为什么"四级层"不是发明

外部实现里，**两级（全局 + 会话/项目）居多，四级基本没有**。我们多出来的这一级（场景）不是发明——DSH 本来就有"场景"这个手动维度，只是 v0.2 之前没有把它和记忆归属连起来。

外部的作用域维度对比：

| 实现 | 分的是什么 | 维度数 |
| --- | --- | --- |
| Mem0 | 身份（谁） | 3（user / agent / run） |
| Letta | 类型（多重要） | 3（core / recall / archival） |
| Hermes | 类型（什么性质） | 3（episodic / semantic / procedural） |
| Claude Code | 位置（哪个项目） | 2（项目 / 全局） |
| **本设计** | **位置（哪可见）** | **4（全局 / 工作区 / 场景 / 会话）** |

关键区别：别人分的是**身份**或**类型**，我们分的是**可见范围**。这不是同一个轴，所以数量不可直接比。

## 2. 代码落点（行号为 0.22.5）

### 2.1 只读不改（理解现状用）

| 文件:行 | 内容 | 与本设计的关系 |
| --- | --- | --- |
| `src/index.ts:2213` | memory 域 `applicableTo: subagentDepthOf(agent) === 0` | 子代理不注入，不递归学习 |
| `src/index.ts:2047` | `toolVisibleFor` | `learn` / `organize` 的可见性挂这里 |
| `src/index.ts:5441` | `requireConfirmForModelRuleWrite` 门禁 | 管 `save`，不管 `learn` |
| `src/index.ts:5305` | 探测 approval 必须 `ctx.get('approval')` | `forget` 的确认卡 |
| `src/memories/projection.ts:62` | `resolveActiveScenes` | 保留段要排除；层解析要新增 |
| `src/memories/snapshot.ts:412` | `renderSceneMemory` | 排除保留段；自动段另起 |
| `src/memories/constants.ts:92` | `SCENE_MEMORY_NOTE`（含 "complete set"） | 必须改成 user-authored，加自动段声明 |
| `src/memories/constants.ts:142` | `isValidGroupPath` 支持 `a/b/c` | 所以 `_ws/<hash>` 不用改扫描器 |
| `src/skills/frontmatter.ts:39` | `parseSkillDoc` 只读顶层扁平标量 | 证据/计数放 `state.json` |
| `src/scope/workspace-key.ts:27` | `workspaceScopeKeyOf` → `ws:<路径>` | 工作区层的键来源 |
| `src/settings-sidecars.ts:45` | `createSettingsSidecars` 范式 | 三级配置的读写照这个写 |
| `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:279` | `turn/end: { turn, reason }` 不带消息 | 必须用 `session/event` 累积 digest |

### 2.2 要改的 13 个文件

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `src/memories/constants.ts` | `LAYER_*`、`_ws`/`_session` 前缀、`AUTO_MEMORY_NOTE`、预算 | P0 |
| `src/memories/discovery.ts` | `deriveFromDoc` 读 `auto_*`；`groupToLayer()` | P0 |
| `src/memories/projection.ts` | 保留段排除；`layersFor(agent)` | P0 |
| `src/memories/snapshot.ts` | 排除保留段；`renderAutoBlock()` | P0/P1 |
| `src/memories/catalog.ts` | **新增** | P0 |
| `src/evolution/config.ts` | **新增** | P0 |
| `src/evolution/state.ts` | **新增** | P1 |
| `src/evolution/gates.ts` | **新增** | P1 |
| `src/evolution/review.ts` | **新增** | P2 |
| `src/evolution/dream.ts` | **新增** | P3 |
| `src/tools/memory.ts` | 3 个新工具；2 个扩字段 | P1 |
| `src/ops/memory.ts` | 4 个新 op | P1/P2 |
| `src/index.ts` | 配置/可见性/捕获/注入/审批 | P0–P2 |
| `src/http-api.ts` | 10 个 `evolution-*` | P1–P3 |
| `src/client/47-memory.js` | 开关卡/自动区/待确认/时间线/健康度 | P0–P3 |
| `src/client/30-dict.js` | 文案 | P0–P3 |

（16 项，`07-roadmap.md` §6 里按模块合成了若干行。）

### 2.3 新增 op 的命名

沿用现有 `rules-*` → 已改名的 `memories-*` 前缀。查一下现状：现有 op 是 `rules-list` / `rules-read` / …（`src/ops/memory.ts`）。

新增：

```text
memories-learn       创建/合并一条自动记忆
memories-forget      删除 + 墓碑
memories-promote     换层（UI / dream 用，不给模型）
memories-edit-auto   编辑自动条目并锁定（UI）
memories-organize    触发 dream 草案
memories-apply       应用草案
memories-rollback    回滚草案
```

## 3. 术语表

| 词 | 含义 | 别混用 |
| --- | --- | --- |
| 层 / layer | 记忆的可见范围：`global` / `workspace` / `scene` / `session` | 不是作用域粒度 |
| 生效层 | 同上 | — |
| 学习域 / `learnScope` | 允许 agent 主动学的上下文范围 | 不是"记忆存在哪" |
| 写入目标 / `writeTarget` | 学到的条目默认落哪层：`route` / `session` / `workspace` / `global` | 不是"注入顺序" |
| `origin` | 谁写的：`user` / `auto` | 不是"来源可信度" |
| 作用域粒度 | 现有「作用域」页的 `global` / `session` / `workspace` | 不是层 |
| 学习 / learn | agent 主动写记忆 | 不是用户手写 |
| 复习 / review | 轮末的写入判定（轻量，单轮） | 不是 dream |
| 整理 / dream | 批量合并/晋升/归档（重量，出草案） | 不是单轮写入 |
| 孵化器 | 会话层在会话结束后的角色：等待晋升或删除 | — |
| 九道门 | 写入前的九项校验 | 不是"九个工具" |
| L0–L3 | 注入分级：常驻 / 排序 / 按需 / 归档 | 不是"层" |
| catalog | `evolution/catalog.json`，注入用的派生索引 | 不是 `memories-index.json` |
| 墓碑 / tombstone | 用户删除的记录，30 天内阻止自动复活 | 不是回收站 |
| 死信 / dead-letter | 重试 3 次仍失败的 outbox 项 | 不是"已丢弃" |

## 4. 参考链接（人工核对，非抓取）

- Claude Code memory：`docs.claude.com/en/docs/claude-code/memory`
- Codex memories：`developers.openai.com/codex/memories`
- Mem0：`docs.mem0.ai`（2026 版 ADD-only 变更说明）
- Letta / MemGPT：`docs.letta.com`
- ACE（Agentic Context Engineering）：arXiv 2510.04618
- Anthropic Dreams：Anthropic 工程博客，2026
- DSH 同类插件：`dsh-brain`、`dsh-self-evolution`、`dsh-memory-evolve`（本地 npm 包，行为按实测描述，无官方文档）

外部实现的细节会变；本文件只保证"核对日期 2026-11 时是这样"。设计决策不依赖它们的某个具体数值，只依赖模式（索引+按需、写用分离、草案+确认、delta+计数器）。
