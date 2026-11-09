# 05 · agent 怎么管理这些记忆

## 1. 一条权限原则

> **模型可以"读"和"追加"，不可以"搬家和合并"。**

搬家（换层）、合并、批量删，这三个动作的共同点是**不可逆且影响面不可见**：模型看不到"这条记忆还被 5 个项目引用"，也看不到"合并后用户会不会找不到"。它做这些事的成功率远低于做"记一条"。

所以权限按可逆性分，不按重要性分：

| 动作 | 可逆性 | 给谁 |
| --- | --- | --- |
| 读（list / read / search） | 无副作用 | 模型 |
| 追加（learn / save） | 删掉即可 | 模型**提议** + 用户逐条确认 |
| 忘单条（forget） | 墓碑 30 天可恢复 | 模型（用户要求时） |
| 触发整理（organize） | 只出草案，不应用 | 模型 |
| 换层 / 合并 / 批量删 / 清空 | 影响不可见 | **只给 UI 和 dream** |

## 2. 工具清单

> **已过时（2026-11-09）**：下表写的是 P1 的形状。实际落地时四条自主记忆工具
> （`learn` / `forget` / `organize` / `procedure_done`）已合成一条
> `memory_manager_auto`，用 `action=learn|forget|organize|done|idea` 分叉。
> `action=learn` 每次都弹宿主确认卡，用户可选同意（写入）/ 拒绝（不写）/ 输入想法
> （模型调 `idea` 后改好重提）；只有同意落盘。工具本身**跟随总开关开合**，在工具表里
> 是只读行，`tool_manager_tools` 也不能把它开出来。记忆只分全局 / 本项目两层，正文存
> `evolution/notes/`，不进用户记忆的场景体系。偏差理由见 `07-roadmap.md` 的
> 「界面收敛」与「独立库 / 两层 / 逐条确认」两节。

现有 5 条（`src/tools/memory.ts`）+ 新增 3 条 = 8 条。

| 工具 | 状态 | 读/写 | 需确认 | 开关关时可见 |
| --- | --- | --- | --- | --- |
| `memory_manager_list` | 现有，扩字段 | 读 | 否 | 是 |
| `memory_manager_read` | 现有，扩字段 | 读 | 否 | 是 |
| `memory_manager_search` | 现有，扩范围 | 读 | 否 | 是 |
| `memory_manager_switch` | 现有，加限制 | 写 | 否 | 是 |
| `memory_manager_save` | 现有，加 `layer` | 写 | 按现有门禁 | 是 |
| `memory_manager_learn` | **新增** | 写 | 否（自动） | **否** |
| `memory_manager_forget` | **新增** | 写 | **是** | 是（用户要删时不依赖开关） |
| `memory_manager_organize` | **新增** | 写（草案） | **是** | **否** |

`learn` / `organize` 在开关关闭时**不可见**（`toolVisibleFor` 返回 false）。理由：看不见的工具不会被误调，也不需要模型理解"为什么这个工具有时在有时不在"——它只需要知道"现在能不能主动记"。

`forget` 保持可见：用户说"忘掉 X"是明确指令，不该因为自动记忆关着就不能执行。

## 3. 每个工具做什么

### 3.1 `memory_manager_list`

```text
入参：
  layer?      global | workspace | scene | session      （不填 = 全部可见层）
  status?     active | core | candidate | archived | superseded
  kind?       preference | fact | correction | procedure
  all?        含 archived/superseded（默认 false）
  limit?      默认 50，上限 200

返回：按层分组的一行一条
  [auto/workspace] pkg-manager  [pref] 这个仓库用 pnpm…  conf .95  used 3
  [user/global]   tone          [pref] 回答先给结论        —
```

「会注入」的判定统一为：`status ∈ {active, core}` 且 `enabled !== false` 且层匹配当前会话。`list` 返回里标 `injects: true/false`，模型不用自己推。

### 3.2 `memory_manager_read`

```text
入参：id（必须带层前缀，如 _ws/3f2a.../pkg-manager）
返回：正文 + frontmatter 摘要 + evidence（最近 5 条）+ counters + transitions（最近 5 条）
```

对自动条目额外返回 `origin / status / basis / boundary / confidence`。这些字段是"为什么记它"的依据，模型读了才知道该不该依赖。

### 3.3 `memory_manager_search`

```text
入参：
  query      关键词（空格分词，AND）
  layer?     限定层
  include?   notes（默认）| episodes（v2）| all
返回：命中的 id + oneLine + 分数
```

默认包含 `_ws` / `_session`，不包含 `archived`（要 `all=true`）。搜索走文本匹配，不做向量检索——本地、可解释、零依赖。300 条以内，关键词 + 二元组召回足够。

### 3.4 `memory_manager_switch`

```text
入参：id, enabled
```

限制：`superseded` / `archived` 的条目**拒绝直接打开**，要先「恢复」。理由：旧事实和新事实同时注入，模型会看到两条矛盾的记忆，然后随机选一条。

### 3.5 `memory_manager_save`（现有，扩展）

```text
入参：name, description, body, layer?, scene?
```

- `layer` 默认 `route`（按 §01 §5 的路由表判）。用户说"记住这个项目用 pnpm" → `workspace`。
- **允许写 `workspace` / `global` / `scene`**（`origin=user`，权威最高）。
- **允许写 `session`**，但必须显式 `layer=session`，且要确认卡（"这条只在这个对话有效"）。会话层手写是合理的（"这次别动 migrations，记住"），但用户容易误以为它跨会话，所以要确认。
- **拒绝写保留段前缀**（`_ws/` / `_session/` / `_auto/` 作为字面 id 前缀）。层通过 `layer` 参数指定，不通过 id 猜。

`save` 的 description 保持「Only on the user's instruction」不变，门禁继续走 `requireConfirmForModelRuleWrite`。

### 3.6 `memory_manager_learn`（新增）

```text
入参：
  text        一句话结论（必填，≤2KB）
  kind        preference | fact | correction | procedure（必填）
  key?        语义槽位；不填从 text 归一化
  layer?      覆盖 writeTarget（默认按配置的路由）
  evidence?   当前 turn 的原文引句；不填则从 digest 找用户最后一句
  basis?      为什么知道；不填用 evidence
  boundary?   什么时候可能错
  supersedes? 被取代的 id
  ttlDays?    默认按 kind

返回：
  OK created _ws/3f2a.../pkg-manager (active, conf .95; evidence turn 3)
  QUEUED (conflicts with user memory "deploy"; approve in Memory → Pending)
  REJECTED: derivable from package.json; read it instead
  REJECTED: evidence not found in this turn
```

**不复用 `save` 加 `auto` 参数**：`save` 的契约是"只在用户要求时写"，受确认门禁；自动写入不该问用户。两把钥匙混成一个工具，门禁只能按参数分叉，模型传错就两头错。授权边界要落在工具名上。

`learn` 的写入仍过九道门（`03-flows.md` §6），尤其是证据门——**必须逐字子串**。模型自己编的引句一律拒绝。

### 3.7 `memory_manager_forget`（新增）

```text
入参：id, reason?
```

- 单条删除：文件进回收站，`state.json` 写墓碑（`key` + `layer` + `textHash`，30 天）。
- 返回：`Forgot _ws/3f2a.../pkg-manager; won't be relearned for 30 days.`
- **需确认卡**，卡片上显示"将删除这条记忆，30 天内不会再自动学到"。
- 不给批量参数。批量删只走 UI。

### 3.8 `memory_manager_organize`（新增）

```text
入参：scope?  workspace | global | all（默认 workspace）
返回：Drafted 5 changes (3 merges, 1 archive, 1 promote). Review in Memory → Pending.
```

只生成草案，不改任何文件。用户确认后才应用。模型调它是因为用户说"整理一下记忆"，它不该自己决定合并谁。

## 4. 模型看不到什么

| 数据 | 为什么不给模型 |
| --- | --- |
| `state.json` 全文 | 证据链是审计数据，不是上下文素材；给模型只会诱导它"引用证据"来假装可靠 |
| 其他会话的记忆 | 结构性隔离：扫描根本不进入其他 sid 目录，不是读进来再过滤 |
| 其他工作区的记忆 | 同上，按 hash 目录隔离 |
| `pending.json` 的完整内容 | 只告诉模型"有 3 条待确认"，不告诉它具体是什么（防止它绕过 UI 直接写） |
| 墓碑列表 | 墓碑是实现细节；模型知道"30 天不能复活"就够了 |
| 配额的具体数字 | 只返回"已满/未满"，避免模型为了腾位置自己删东西 |

## 5. UI 布局

不新增页签，全部放现有「记忆」页（#27 的教训：窄侧栏放不下第 9 个页签）。

```text
记忆页
├── [开关卡] 三级作用域
│     全局：关 · 本工作区：开 · 本会话：继承
│     已学 87 条 · 注入 8 条 / 1.1k token · 上次整理 2 天前
│     [暂停本会话] [设置]
│
├── [待确认 3]  折叠区，有才显示
│     · 合并 3 条 pnpm 相关 → 1 条        [查看] [应用]
│     · 提议：把 "deploy-flow" 建成技能   [查看] [应用]
│
├── [自动记忆] 按层分组
│     ▸ 工作区（87）  ▸ 全局（34）  ▸ 场景（12）  ▸ 会话（5）  ▸ 已归档（21）
│       每行：文本 · 状态 · confidence · 最近使用 · […菜单]
│       菜单：编辑 / 停用 / 提升为用户记忆 / 删除
│
├── [用户记忆] 现有场景列表（不动）
│
└── [时间线] 最近 50 条变更
      · 10:32 学到 "这个仓库用 pnpm"（工作区）
      · 昨天  dream 合并 2 条，归档 1 条
```

开关卡的三级作用域要能一眼看懂"现在到底开没开"：

```text
┌──────────────────────────────────────────────┐
│ 自主记忆                          [ 已开启 ] │
│ 全局：关   本工作区：开   本会话：继承        │
│ 来源：本工作区设置                            │
│ [暂停本会话]  [关闭本工作区]  [高级设置]      │
└──────────────────────────────────────────────┘
```

「来源」那行很重要：用户改了三级设置后，经常忘了是哪一级生效的。显示"来源：本工作区设置"能省掉大量困惑。

## 6. HTTP 端点

沿用现有 `http-api.ts` 的回环 + JSON 校验 + `request-gate` 模式。

| 端点 | 方法 | 作用 | 权限 |
| --- | --- | --- | --- |
| `evolution-status` | GET | 三级配置 + 健康度 + 来源 | 只读 |
| `evolution-list` | GET | 按层/状态分页列表 | 只读 |
| `evolution-item` | GET | 单条详情（证据/计数/变更） | 只读 |
| `evolution-toggle` | POST | `{ scope: global\|workspace\|session, enabled }` | 写 |
| `evolution-forget` | POST | `{ id }` | 写（CSRF 防护） |
| `evolution-promote` | POST | `{ id, to }` | 写 |
| `evolution-review` | POST | 立即复习当前会话 | 写 |
| `evolution-dream` | POST | 生成草案 | 写 |
| `evolution-apply` | POST | `{ draftId, changes }` | 写 |
| `evolution-rollback` | POST | `{ draftId }` | 写 |

写端点必须：

- 只接受回环地址（现有 `http-fence.ts`）。
- 校验 `Content-Type: application/json`。
- 单次请求体 ≤ 64KB。
- 幂等键（`draftId`），重复提交不重复应用。

## 7. 工具数会不会太多

8 条记忆工具 + 现有 30 余条，工具表不会炸。但**描述要短**：每条 ≤ 3 行，把细节留给 `read` 的返回值。现有 `memory_manager_save` 的描述已经偏长，新增的三条要克制。

`learn` / `forget` / `organize` 的 description 草案：

```text
memory_manager_learn:
  Record something worth remembering across sessions, without asking.
  Only available when autonomous memory is on. Evidence must be a verbatim
  quote from this turn; inferred notes are stored as candidates.

memory_manager_forget:
  Delete one memory and stop relearning it for 30 days. Use when the user
  asks to forget something. Confirm with the user first.

memory_manager_organize:
  Draft a cleanup of learned memories (merge duplicates, archive stale ones).
  Produces a reviewable draft; does not change anything until the user applies it.
```

## 8. 一次典型调用的完整链路

用户：「以后别用 npm，这个仓库统一 pnpm」

```text
① 模型识别到「以后」= 明确偏好 + 项目范围
② 调 memory_manager_learn({
     text: "这个仓库用 pnpm，不要生成 package-lock.json",
     kind: "preference",
     key: "package-manager",
     evidence: "以后别用 npm，这个仓库统一 pnpm"
   })
③ 工具内：
   a. 逐字校验 evidence 是当前 turn 用户文本的子串 → 通过
   b. 路由：writeTarget=route，有 cwd → workspace
   c. 冲突检查：无同 key 条目
   d. 配额检查：工作区 87/200 → 通过
   e. 算 confidence：user_explicit 0.95 + 0 额外证据 = 0.95
   f. 写 _ws/3f2a.../package-manager.md
   g. 更新 state / catalog / index
④ 返回 "OK created ..."
⑤ 下一轮：自动块出现这一行（本会话快照已建，实际是下个会话才发）
⑥ 会话结束：dream 扫到，无重复，维持 active
⑦ 第 3 天用户说"CI 里还是 npm"：同 key 合并，boundary 加一条
```

注意第 ⑤ 步：**本会话不重发注入块**。模型这一轮已经知道（它自己刚写的），重发是浪费且会破坏前缀缓存。
