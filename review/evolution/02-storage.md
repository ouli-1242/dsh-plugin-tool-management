# 02 · 存储：一条一文件，另建 catalog

> **实现更新（2026-11-09）**：本文写的是"自动条目住在 `memories/<group>/`、与用户记忆共用
> `memories-index.json`"的早期形状。落地时它们已搬进**独立库** `evolution/notes/`：
> 正文在 `evolution/notes/global/` 与 `evolution/notes/_ws/<hash16>/`，启停索引是
> `evolution/notes/memories-index.json`，catalog 仍是 `evolution/catalog.json`。
> 用户记忆的目录、索引、场景单选、导出、回收站都不再包含自主记忆；旧文件由
> `migrateLegacyAutoNotes()` 一次性搬过来。层只剩全局 / 本项目两种（会话层、场景层取消）。
> 理由与偏差登记见 `07-roadmap.md`。下面"一条一文件 + 派生 catalog"的结论不变。

## 1. 一条一文件，还是合并成一个大文件

结论：**一条记忆一个 `.md` 文件**。合并省的是读取，丢的是单条回滚和并发安全；读取的问题用 catalog（§4）解决，不用合并解决。

### 1.1 逐项对比

| 维度 | 一条一文件 | 合并单文件 |
| --- | --- | --- |
| 单条编辑 / 删除 / 回滚 | 天然按文件 | 要重写整文件，容易误伤邻条 |
| 并发写 | 两个 turn 写不同条目不冲突 | 必冲突，需要全局锁串行 |
| diff 可读性 | 单条改动 = 单文件 diff | 一条改动淹没在整文件 diff 里 |
| frontmatter | 每条的元数据独立 | 只能存一份，条目元数据要自定义分隔符 |
| 回收站 | 现有按文件进 trash，可单条恢复 | 要自己实现条目级回收 |
| 现有代码复用 | 扫描 / 索引 / 回收 / 导出 100% 复用 | 要写第二套读写 |
| 单条 token 计量 | 天然按文件字节 | 要切分后估算 |
| 目录扫描成本 | 300 个文件约 20–40ms | 约 2ms |
| **每会话读全文成本** | 300 条 × 2KB ≈ 600KB，100–300ms | 一次读 600KB，约 5–15ms |

最后两行才是真差距。但注意：**前 8 行的代价是不可逆的**（并发冲突、回滚粒度），后两行只是性能，且可以用缓存解决。

### 1.2 为什么"合并"在这套系统里格外危险

ACE 论文实测过 context collapse：18,282 token 的记忆在多轮"整段重写"后被压到 122 token，准确率反而掉 9.6 分。合并存储天然诱导"读整文件 → 改 → 写整文件"，这正是 collapse 的产生条件。

一条一文件时，写入只能改一条；想整段重写也没有入口。**存储形态本身就是一道防线。**

### 1.3 什么时候该重新考虑

只有同时满足才考虑分片合并：

- 单层条目 > 2000，且
- 目录扫描实测 > 200ms（当前 300 条约 20ms，差一个数量级），且
- catalog 缓存因 mtime 频繁失效（说明写入极频繁）

即便那时，正确做法也是"按 `kind` 分片"（`preferences.md` / `facts.md`），而不是全库一个文件。v1 不做。

## 2. 目录布局

```text
$DSH_HOME/tool-management/
├── memories/
│   ├── global/                     # 全局层（现有）
│   ├── _shared/                    # 共享组（现有，恒常注入）
│   ├── <scene>/                    # 场景层（现有，可多层 a/b）
│   ├── _ws/<hash16>/               # 工作区层（新）
│   │   └── pkg-manager.md
│   └── _session/<sid>/             # 会话层（新）
│       └── freeze-migrations.md
├── memories-index.json             # 现有：启停/顺序/标签/场景/档案（用户态真源）
└── evolution/                      # 新：策略与派生数据（不在记忆扫描范围内）
    ├── settings.json               # 全局开关
    ├── workspaces.json             # hash16 → { key, cwd, label, evolution?, missingAt? }
    ├── sessions.json               # sid → { evolution?, cwd?, lastSeenAt }
    ├── state.json                  # 证据/计数器/墓碑/水位（不可重建的真源）
    ├── catalog.json                # 注入卡片索引（派生，可重建）
    ├── outbox.jsonl                # 轮末捕获队列（append-only）
    ├── pending.json                # 待确认的改写/删除/技能提议
    ├── episodes/<sid>/<turn>.json  # 轮次摘要（不注入，30 天裁剪）
    ├── dreams/<ts>/                # 整理草案 + manifest.json
    └── logs/                       # 复习/整理/应用日志（本地，按天轮转）
```

三个关键点：

1. **`_ws/<hash16>` 是两级 group 路径，现有扫描器已支持。** `isValidGroupPath` 明确允许 `a/b/c` 多层（`src/memories/constants.ts:142`），`discovery.ts` 的 `current.group` 也按嵌套处理。所以不用改扫描器，只要在投影层按前缀识别层。
2. **`evolution/` 不在 `memories/` 下**，扫描器看不到，不会被当成记忆条目。
3. **`memories/_auto/` 是 v0.2 遗留**，v0.3 首次启动时迁移（见 `07-roadmap.md` §4），迁完留标记不删目录。

### 2.1 目录名为什么是 hash

`workspaceScopeKeyOf(cwd)` 返回 `ws:<归一化路径>`，含 `:` 和 `/`，过不了段名校验；完整路径也太长（键上限 900 字符）。

```text
hash16 = sha256(workspaceScopeKeyOf(cwd)).slice(0, 16)
```

- 碰撞概率：16 位十六进制 = 64 bit，10 万个工作区碰撞概率约 2.7e-10，可忽略。
- 映射存 `workspaces.json`，UI 显示真实目录名。
- **键的真相在 `workspaces.json`**，不在目录名。目录名只是 hash 前缀，不要试图反解。

**身份要向上收敛到 git root，不能直接用 cwd。** 用户从 `/repo` 进到 `/repo/src`，cwd 变了；直接按 cwd 算 hash，刚学的项目事实立刻"消失"，而用户只会认为"记忆丢了"。

```text
workspaceRootOf(cwd):
  ① 从 cwd 向上找 .git（文件或目录，最多 8 层）
  ② 找到 → 用那个目录
  ③ 找不到 → 用 cwd
  ④ 结果按 cwd 缓存（cwd → root），进程内 Map，LRU 256
```

同步 `fs.existsSync` 最多 8 次，热路径可接受；取不到就退回 cwd，不抛错。

不处理的两个情况（列为已知限制）：git worktree 的多个工作树按各自路径分开（分支不同，事实可能冲突）；monorepo 的子包不单独成层（用 git root）。


### 2.2 会话目录的 sid 校验

`sid` 来自宿主，必须过 `isValidGroupSegment`（非空、无路径分隔符、不以 `.` 开头、不是 Windows 保留名）才落盘。不合法则整个会话层降级为"不写"——**没有身份就无法隔离，宁可不记**。

## 3. 一条记忆的文件格式

```markdown
---
name: pkg-manager
description: 这个仓库用 pnpm，不要生成 package-lock.json。
origin: auto
auto_kind: preference
auto_layer: workspace
auto_workspace: 3f2a9c1e8b7d4a06
auto_scene: ""
auto_key: package-manager
auto_status: active
auto_confidence: 0.95
auto_basis: "用户 2026-11-09 说「以后都用 pnpm」"
auto_boundary: "若出现 package-lock.json 或 CI 用 npm，先确认"
auto_supersedes: ""
auto_learned_in: "session:s-abc123"
auto_created: "2026-11-09T10:00:00+08:00"
auto_updated: "2026-11-09T10:00:00+08:00"
auto_ttl_days: 365
auto_degraded: ""
---

这个仓库统一用 pnpm；不要生成 package-lock.json。
```

字段规则：

- **全部顶层扁平标量。** `parseSkillDoc` 只认 `key: value`，嵌套不进入 map（`src/skills/frontmatter.ts:39`）。数组和对象一律放 `state.json`。
- **含 `:`、引号、换行的值必须过 `yamlScalar` 加引号。** 否则 `parseSkillDoc` 在第一个 `:` 处截断，读出来是半句话。`basis` / `boundary` / `description` 最容易踩。
- **`auto_confidence` 是反规范化字段**，方便导出和 UI；真值在 `state.json`，每次写入重算。读到不一致以 `state.json` 为准。
- **`auto_learned_in`** 记录"在哪学的"（`session:<sid>` 或 `workspace:<hash16>`），用于孵化晋升统计。不加这个字段就得扫全部证据链，成本高。
- `origin=user` 的手写记忆不带 `auto_*` 字段；一旦带了 `auto_*`，就按自动记忆处理（`status` 缺失时默认 `active`）。

正文只放"一句话结论 + 必要的操作细节"，不要抄对话。注入时只用 `description` 一行，正文按需读。

## 4. 三个状态文件：谁能重建，谁不能

这是整套存储最容易被做错的地方。三个文件长得像，职责完全不同：

| 文件 | 内容 | 真源？ | 损坏后 |
| --- | --- | --- | --- |
| `memories-index.json`（现有） | 启停、顺序、标签、场景记录、档案 | **是**（用户态） | 从目录重建（丢用户排序/启停），现有 `memories-index-repair` 已有此逻辑 |
| `evolution/state.json` | 证据链、helpful/harmful 计数、墓碑、水位、transitions | **是**（不可重建） | 拒绝写入、备份坏文件、报错；**绝不用默认值覆盖** |
| `evolution/catalog.json` | 每条记忆的注入卡片（一行摘要、token、状态） | 否（派生） | 直接重建（扫文件 + 读 state） |

**为什么 state 不可重建**：证据链是"这句话是谁在哪个 turn 说的"的原始记录；一旦丢了，一条 `active` 记忆就变成"没有依据的断言"，无法审计、无法降级、无法解释。`helpful` 计数丢了，晋升/淘汰就失去依据。墓碑丢了，用户删掉的事实会复活。

**为什么不把证据放进 frontmatter**：`parseSkillDoc` 不支持数组；而且证据会不断增长，把它写进正文文件会让每次追加都重写整文件（正是 §1.2 要避免的）。

### 4.1 state.json 形状

```json
{
  "version": 1,
  "entries": {
    "_ws/3f2a9c1e8b7d4a06/pkg-manager": {
      "evidence": [
        { "session": "s-abc123", "turn": 3, "seq": 41, "source": "user_explicit", "quote": "以后都用 pnpm" }
      ],
      "counters": { "injected": 12, "read": 2, "helpful": 3, "harmful": 0, "lastInjectedAt": "..." },
      "transitions": [
        { "at": "...", "from": "candidate", "to": "active", "actor": "curator", "reason": "user_explicit" }
      ]
    }
  },
  "tombstones": [
    { "key": "package-manager", "layer": "workspace", "workspace": "3f2a...", "textHash": "sha256:...", "at": "...", "until": "..." }
  ],
  "watermarks": { "lastReviewedTurn": 42, "lastDreamAt": "...", "lastCatalogBuildAt": "..." }
}
```

写入方式：读 → 改内存 → 写临时文件 → `fsync` → 原子 `rename`。并发用现有 `withWriteLock`。读坏时拒绝写入，保留正文，备份坏文件，状态卡报错——**不要用默认值覆盖**，那会静默丢掉全部证据。

### 4.2 catalog.json 形状

```json
{
  "version": 1,
  "builtAt": "2026-11-09T17:00:00+08:00",
  "entries": {
    "_ws/3f2a9c1e8b7d4a06/pkg-manager": {
      "layer": "workspace",
      "workspace": "3f2a9c1e8b7d4a06",
      "scene": "",
      "session": "",
      "kind": "preference",
      "key": "package-manager",
      "status": "active",
      "oneLine": "这个仓库用 pnpm；不要生成 package-lock.json。",
      "bytes": 412,
      "estTokens": 18,
      "confidence": 0.95,
      "pinned": false,
      "enabled": true,
      "mtime": 1762653600000,
      "size": 412,
      "hash": "sha256:9f2c...",
      "lastInjectedAt": "2026-11-09T12:00:00+08:00",
      "helpful": 3,
      "harmful": 0
    }
  }
}
```

- `layer` + `workspace` + `scene` + `session` 四个字段决定可见性：`layer` 选哪一条规则，另外三个是归属键。注入时只比对自己那一档（`workspace` 比 hash、`session` 比 sid），不解析目录名。
- `oneLine` 是注入用的那一行（正文压成一行，超过 160 字符截断加 `…`）。
- `estTokens` 按"3 bytes/token（中文）与 4 bytes/token（英文）取更严"估算。
- `mtime` / `size` / `hash` 用来判失效：三者任一与磁盘不一致 → 只重读那一个文件并更新卡片，不重建全表。
- **注入热路径只读 catalog**，不读任何 `.md` 正文。这是"记忆多了也不变慢"的关键。

catalog 的更新时机：

| 触发 | 动作 |
| --- | --- |
| 写入 / 删除一条 | 只改这条的卡片（+ 一次原子写） |
| 扫描发现磁盘与卡片不一致 | 只重读那一条 |
| `state.json` 的 counters 变化 | 不重写 catalog，注入时从 state 现取（用 TTL 缓存） |
| 全量重建 | 启动时 catalog 缺失/版本不符/超过 24h 且条目数变化 → 后台重建 |

全量重建 300 条约 40ms，放后台不阻塞首轮注入；重建完成前用旧 catalog（缺失则只用用户记忆，不注入自动块）。

## 5. 命名与 id

| 项 | 规则 | 例 |
| --- | --- | --- |
| id | `<group>/<name>`，与现有记忆 id 同构 | `_ws/3f2a9c1e8b7d4a06/pkg-manager` |
| `name` | 小写字母数字连字符，≤48 字符 | `pkg-manager` |
| 语义槽位 `auto_key` | 归一化后的短标识，同 key 视为同一件事 | `package-manager` |
| 文本哈希 `textHash` | `sha256(归一化正文)`，用于墓碑与近重检测 | `sha256:9f2c...` |

`name` 由 `auto_key` 派生；`auto_key` 冲突时追加序号（`package-manager-2`），**不覆盖**旧文件——覆盖会丢证据链。

## 6. 与现有索引的关系

`memories-index.json` 的 `rules` 表按 id 存启停/顺序/标签。新增层后：

- 自动条目也在 `rules` 里（复用启停与排序），键是完整 id（含 `_ws/...`）。
- `scenes` 表**不新增** `_ws` / `_session` 记录——它们不是场景，不进场景选择器。
- `active` 场景集合不包含保留桶。`resolveActiveScenes` 的 `knownScenes` 要排除 `_ws` / `_session` 前缀。
- 索引结构不变，`version` 仍为 1。旧版本读到 `_ws/...` 这类 id 会当成普通记忆渲染（见 `07-roadmap.md` §4 的降级风险）。

## 7. 导出与导入

- 导出沿用现有记忆导出（目录 + index 切片）。`origin` / `auto_*` / `auto_layer` 一并保留。
- 导入到不同工作区时：
  - `layer=workspace` 且 hash 不匹配 → 降为 `candidate`，`auto_workspace` 置空，等新工作区首次出现时由 dream 提议归属。
  - `layer=session` → 丢弃（会话 id 无意义），或按用户选择合并为 `workspace` 的 `candidate`。
  - `layer=global` / `scene` → 原样导入，但 `status` 降为 `candidate`（别人的证据不能直接算你的）。
- 墓碑**不导出**。导出墓碑等于把"我删过什么"一起交出去，是隐私泄漏。

## 8. 单条记忆的大小约束

| 约束 | 值 | 超了怎么办 |
| --- | --- | --- |
| 正文 | ≤ 2 KB | 拒绝写入，提示拆成 procedure + 引用 |
| `oneLine` | ≤ 160 字符 | 截断加 `…` |
| `description` | ≤ 200 字符 | 截断 |
| 单条证据引句 | ≤ 500 字符 | 截断，保留 `seq` 可回溯 |
| 每条证据数 | ≤ 20 | 只保留最近 20 条 + 计数汇总 |

2 KB 不是拍脑袋：注入只用 `oneLine`，正文只在 `read` 或 procedure 执行时读。正文超过 2 KB 说明它其实是一份文档，应该做成技能或写进仓库文件，而不是记忆。
