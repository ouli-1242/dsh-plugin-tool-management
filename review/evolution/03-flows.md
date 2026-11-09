# 03 · 全流程：从启动到一轮记忆的一生

每条流程都标了：**触发 / 输入 / 步骤 / 产物 / 失败怎么办**。实现时按这九条对着写测试。

## 1. 启动与配置解析

**触发**：插件加载、会话创建（`agent/created`）。

```text
① 读 evolution/settings.json（全局）           → 失败：用默认 { enabled:false }，记日志
② 从 agent 取 cwd → gitRootOf(cwd) → workspaceScopeKeyOf()   → 空/超长：workspace=undefined
③ hash16 = sha256(key).slice(0,16)
④ 读 workspaces.json[hash16].evolution          → 缺失：{}（全部继承）
⑤ 从 agent 取 sid → 校验 isValidGroupSegment    → 不合法：session 层禁用
⑥ 读 sessions.json[sid].evolution               → 缺失：{}
⑦ 逐字段解析：session ?? workspace ?? global
⑧ 得到 effective = { enabled, learnScope, writeTarget, inject, dream, budget, ... }
```

**产物**：一份 `EffectiveConfig`，缓存在 `agent` 上（`WeakMap`），配置变更时失效。

**失败怎么办**：

- `settings.json` 损坏 → 用默认值（全关）并报错，**不写回**。理由：坏文件可能含用户刚改的配置，覆盖即丢失。
- `workspaces.json` 损坏 → 工作区覆盖视为空，学到的条目降级 `session` 并标 `auto_degraded=no-workspace-config`。
- 拿不到 cwd → 不落工作区层；`learnScope=workspace` 降级 `session`。

**为什么不用 `scopeMode()`**：见 `01-model.md` §4。层是数据归属，不能跟着 UI 设置漂移。

## 2. 首轮注入

**触发**：`agent/pre-step`，`memory` 域。

```text
① effective.inject === false           → 跳过自动段，只注入用户记忆段（逐字节同现状）
② 取会话快照（WeakMap<agent, { key, text, fingerprint }>）
   - 快照存在且 key 未变              → 直接复用，不重算、不重发
   - 快照缺失或 key 变（切场景/切工作区/首轮） → 重建
③ 重建：
   a. 从 catalog 取候选（不读正文）
   b. 过滤：layer 匹配（global 恒选；workspace 同 hash；scene 匹配当前启用；session 同 sid）
   c. 过滤：status ∈ {active, core} 且 enabled !== false
   d. 排序：score = 0.45*confidence + 0.25*exp(-ageDays/60)
                    + 0.20*log(1+helpful)/log(1+maxHelpful) + 0.10*pinned
   e. 预算：按上下文档算总盘，层间 flex 分配（见 04-governance §3）；用户段过大时自动段缩减
   f. 渲染：`## Learned notes (auto)` + 一行一条
④ 拼成一条 `memory-manager-catalog` 消息（用户记忆段 + 自动段）
⑤ 算指纹（正文 + 框架），与上次相同则不发送
```

**产物**：一条合成 user 消息，注入到本轮。

**失败怎么办**：

- catalog 缺失/损坏 → 只用用户记忆段，自动段缺席一轮；后台触发重建。
- state 读坏 → 自动段缺席（无法判断 status），状态卡报错；**不阻塞会话**。

**为什么快照要自己维护**：现有去重按正文指纹。如果自动块跟着 `memoriesService.memoryText()` 实时重算，那么每学一条，整段记忆就会重发一次，session-stable 的承诺当场失效。所以自动块必须由注入层自己缓存，**不参与**实时指纹。

## 3. 轮内捕获

**触发**：`session/event`（每一轮内持续触发）。

**为什么不能只监听 `turn/end`**：`turn/end` 的载荷只有 `{ turn, reason }`（`@deepseek-ai/dsh-session/lib/types/types.d.ts:279`），不带消息。不知道这一轮发生了什么，复习阶段就没有素材。

```text
累积 digest（内存，按 turn 分桶）：
  - user 消息：原文、seq、时间
  - assistant 消息：只记"是否调用了工具"，不记全文
  - tool/result：工具名、是否成功、关键输出（截断到 500 字符）
  - 纠正信号：用户说"不对/不是/应该是/以后都/记住"等（启发式，见下）
  - 记忆工具调用：memory_manager_* 的入参与结果
```

**产物**：`digest[turn] = { events: [...], signals: {...} }`，在内存里，轮末落盘。

**信号只影响"是否复习"，不直接写**。启发式不是理解：

| 信号 | 判定 | 反例 |
| --- | --- | --- |
| `user_explicit` | 「记住」「以后都」「总是」「别再用」 | 「你记住了吗？」（问句） |
| `user_correction` | 「不对」「不是…是…」「应该是」 | 「不是这样吗？」（反问） |
| `tool_verified` | 同一结论被 ≥2 次工具结果印证 | 单次成功 |
| `repeat` | 同一 key 在 ≥3 轮出现 | 复述同一句话 |

误报只浪费一次复习，不会写错记忆。

**失败怎么办**：digest 是内存态，崩溃即丢。这是有意的——**丢一轮摘要比写错一条记忆好**。需要补的话从 `session/event` 的持久化记录重放（宿主已有）。

## 4. 轮末入队

**触发**：`turn/end`，且 `reason.kind === 'completed'`（不是 `completed`，`TurnEndReasonMap` 是带 `kind` 的判别联合）。

```text
① effective.enabled === false      → 清 digest，退出
② 取 digest[turn]，没有则退出
③ 判定是否值得复习：
   - 有 user_explicit / user_correction 信号    → 是
   - 有 tool_verified 且涉及新结论              → 是
   - turn % reviewEveryTurns === 0              → 是（兜底）
   - 否则                                       → 否，清 digest
④ 写 episodes/<sid>/<turn>.json（摘要，不是全文）
⑤ append 到 outbox.jsonl：{ id, sid, turn, at, digestPath, status: "pending" }
⑥ 触发异步复习（不阻塞 turn/end 返回）
```

**为什么先落 outbox 再复习**：关窗口、崩溃、进程被杀时，只要 outbox 写成功，下次启动就能重放。直接调模型再写入，中间崩溃就永久丢失。

**失败怎么办**：

- `episodes/` 写失败 → 不 append outbox（宁可这轮不学，不要产生指向空文件的队列项）。
- `outbox.jsonl` 写失败 → 记日志；这轮放弃，下一轮继续。
- 复习失败 → outbox 项标 `failed` + `attempts+1`，退避重试（1min / 5min / 30min），3 次后进 `dead-letter`，UI 可见。

## 5. 复习（热路径）

**触发**：轮末异步，或用户点「立即复习」。

```text
① 取 outbox 中 status=pending 的项（按 turn 排序，一次最多 3 项）
② 加文件锁（防止 desktop/web 同时复习同一会话）
③ 组 prompt：
   - 当前生效的记忆摘要（catalog 的 oneLine，≤80 条）
   - 本轮的 digest（用户原话 + 工具结果摘要）
   - 九道门的规则摘录
   - 输出 schema（严格 JSON）
④ 调模型（llm.prepareCall().stream()），温度 0，超时 30s
⑤ 解析 JSON → 逐条过门（§6）
⑥ 写入
⑦ 标记 outbox 项 status=done，更新 watermark
```

**模型选择**：默认用会话当前模型（`agent.model.current()`）。可配更便宜的模型（`evolution.model`），但**只在用户显式配置时**——默认换模型会让"学到的风格"和"对话的风格"不一致。

**成本上限**：每会话最多 2 次复习（`maxReviewsPerSession`），单次 prompt ≤ 8K token。超了跳过并在时间线记「因成本跳过」。这条不是为了省钱，是为了防止"每轮都复习"把长对话拖慢。

**失败怎么办**：

- 模型不可用 / 超时 → 重试一次；仍失败则 `failed`，退避。
- 输出不是合法 JSON → 丢弃本次，记日志，**不重试**（模型已经跑偏，重试只会更贵）。
- 输出 JSON 但 schema 不符 → 丢弃越界字段，保留合法条目；全部不合法则记 `schema-rejected`。

## 6. 写入：九道门

按顺序，任何一道拒绝就停。前八道是 v0.2 的，第九道是分层新增的。

| # | 门 | 判据 | 拒绝后 |
| --- | --- | --- | --- |
| 1 | 来源门 | 只接受当前 turn 的用户文本、工具结果、或 digest 里的事件引用；助手自己的话不算 | 丢弃 |
| 2 | 新颖门 | 能从代码/配置/git 直接读到的，不记（`package.json` 的 scripts、文件路径、依赖版本） | 丢弃，提示"读文件" |
| 3 | 持久门 | 只对本次任务成立的，不记（「这次用 curl」「今天先这样」「下一步跑测试」） | 丢弃 |
| 4 | 安全门 | 秘密、凭据、私钥、JWT、`curl \| sh`、不可见 Unicode、指令覆盖 | 丢弃 + 安全日志；**不做"清洗后保存"** |
| 5 | 范围门 | 路由结果是否超过 `writeTarget` 上限；进 global 是否 `user_explicit` + 全局措辞 | 降到上限层，标 `auto_degraded` |
| 6 | 冲突门 | 与用户记忆冲突 → 只进 `pending`；同 key 自动冲突 → 新证据赢，旧条 `superseded`；不同 key 语义矛盾 → `pending` | 排队或取代 |
| 7 | 配额门 | 该层条数 / 注入预算是否已满 | 先淘汰 `candidate`/`archived`，仍满则拒绝并提示整理 |
| 8 | 证据门 | `user_explicit`/`user_correction` 的 `quote` 必须是 digest 里用户文本的**逐字子串**；`tool_verified` 的 `seq` 必须存在 | 降为 `candidate` 或丢弃 |
| 9 | 层门 | 会话层是否属于本 sid；场景层是否真有该场景；工作区层 hash 是否在 `workspaces.json` 里 | 拒绝或降级，标 `auto_degraded` |

**证据门是最重要的一道**。模型很容易"总结"出一句用户没说过的话。要求逐字子串，能把 90% 的编造挡掉。剩下 10% 靠 `model_inference` 只能 `candidate` 兜底。

写入动作：

```text
① 生成 id（层 + hash16/sid + name）
② 写 memories/<层路径>/<name>.md（原子写）
③ 更新 state.json：evidence / counters / transitions
④ 更新 catalog.json：这条的卡片
⑤ 更新 memories-index.json：rules[id] = { enabled: true }
⑥ 记 logs/ 一条
```

六步不是事务，所以顺序有讲究：**先写正文，再写状态，最后写索引**。中途崩溃的后果是"有文件无状态"（下次扫描补一条 `candidate`），而不是"有状态无文件"（指向不存在的记忆，注入时 404）。

## 7. 整理（dream）

**触发**：每日首次启动、用户手动、或某层条目 > 配额 80%。

```text
① 加文件锁
② 组输入（只读，不动原库）：
   - 全部层的 catalog 摘要（≤200 条）
   - 最近 50 个 episode 摘要
   - 最近 20 条用户纠正
   - 可选 instructions（≤4096 字符）
③ 调模型 → 草案 JSON：{ entries, merges, archive, new, promote }
④ 校验草案：每个 id 必须存在；merge 的源必须同 key；archive 必须给 reason
⑤ 写 dreams/<ts>/{draft.json, manifest.json}，不应用
⑥ UI 显示「有 3 条整理建议」，用户确认后应用
⑦ 应用时：备份旧文件到 memories/<层>/.trash/<ts>/ → 写新文件 → 更新状态 → 可整批回滚
```

**输入库不动**，输出是草案——这是 Anthropic Dreams 的做法：整理是一个"写新库"的任务，不是一个"改旧库"的任务。这样即使整理跑偏，也只是草案不可用，不会毁掉现有记忆。

**失败怎么办**：草案校验不过 → 不展示，记日志；应用中途崩溃 → manifest 里有 `applied: false`，重启后提示"上次整理未完成，可回滚"。

## 8. 关闭 / 降级 / 卸载

| 动作 | 发生了什么 | 不影响什么 |
| --- | --- | --- |
| 关闭（本会话） | `sessions.json[sid].enabled=false`；不再复习，不再注入自动段 | 已有文件保留；用户记忆照常注入 |
| 关闭（本工作区） | `workspaces.json[hash].enabled=false`；该工作区所有会话都不学 | 其他工作区不受影响 |
| 关闭（全局） | `settings.json.enabled=false`；所有层都不学 | 已有文件保留，UI 显示「已暂停」 |
| 卸载插件 | `memories/` 与 `evolution/` 都保留 | 它们是用户数据，不是缓存；README 要写明 |
| 删除工作区目录 | 记忆保留 90 天，标 `missingAt` | 移动硬盘拔掉不等于清空 |
| 删除场景 | 该场景目录整目录进回收站（现有语义） | 其他层不受影响 |
| 降级到旧版本 | **先关开关、导出、清理 `_ws`/`_session`** | 旧版本会把它们当普通场景（见 07 §4） |

## 9. 崩溃恢复与幂等

**幂等键**：`(sid, turn, seq)`。同一 turn 重放时不重复写入。

```text
启动时：
① 读 outbox.jsonl，找 status ∈ {pending, failed}
② 对每条：
   - 对应 episodes 文件不存在 → 标 orphan，跳过
   - 已有同 (sid, turn) 的 done 记录 → 标 done，跳过
   - 否则按 §5 重跑
③ 检查 dreams/*/manifest.json 的 applied=false → UI 提示"上次整理未完成"
④ 检查 state.json 是否可解析 → 不可解析则进只读模式，状态卡报错
```

**死信**：同一项失败 3 次 → `dead-letter`，不再自动重试，UI 显示原因和「重试」按钮。**不要无限重试**，那会让一个坏掉的输出反复烧模型调用。

## 10. 一条记忆的一生

| 时间 | 事件 | 系统动作 |
| --- | --- | --- |
| Day 1 | 用户：「以后这个仓库都用 pnpm」 | `learn` 校验逐字引句 → `_ws/<hash>/package-manager` active，confidence 0.95，evidence turn 3 |
| Day 1 | 下一次会话（同项目） | 自动块出现 `[pref] 这个仓库用 pnpm…`；会话内快照，只发一次 |
| Day 3 | 用户：「CI 里还是 npm，别乱改」 | 不是取代，是补充边界：同 key 合并，`boundary` 加一条，evidence 变两条，不新建第二条 |
| Day 10 | dream | 发现另一条「pnpm 不要 lockfile」重复 → 合并；条目升 `core`（helpful 3） |
| Day 20 | 发布流程被执行 3 次，工具全成功 | procedure 从 candidate → playbook；自动块出现 `[proc] … id: deploy-flow` |
| Day 30 | 用户点「创建技能」 | 走 `skill_manager_save` 确认卡；写后 lint；失败回滚；成功加 `learned` 徽章 |
| Day 45 | 用户说「忘记 pnpm 的事」 | 墓碑写入；条目 archived；自动路径 30 天不能复活 |
| Day 60 | 在新工作区 clone 同一仓库 | hash 变了 → 旧记忆不注入；UI 提示"疑似同一项目"，用户确认后合并 |

## 11. 时序总图

```text
启动      配置解析 ──► effective
                        │
首轮      pre-step ─────┼──► 注入快照（用户段 + 自动段）
                        │
轮内      session/event ─┴──► digest 累积
                              │
轮末      turn/end ───────────┴──► episodes + outbox
                                      │
复习（异步）                            ├──► 模型 → 候选 JSON
                                      │        │
                                      │    九道门
                                      │        │
                                      │    写入（正文 → state → catalog → index）
                                      │
整理（每日）  catalog + episodes ──► dream 草案 ──► 用户确认 ──► 应用/回滚
```
