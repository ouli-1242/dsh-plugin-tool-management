# 01 · 三轴模型：层、来源、学习域

## 1. 三个轴，各回答一个问题

v0.2 用一个 `scope` 字段同时表达"存哪"和"在哪学"，这是含混的根源。v0.3 拆成三个互不相干的轴：

| 轴 | 取值 | 回答 | 谁决定 | 存在哪 |
| --- | --- | --- | --- | --- |
| `layer`（生效层） | `global` / `workspace` / `scene` / `session` | 这条记忆**谁能看见** | 写入时定，dream 可改 | 目录 + frontmatter `auto_layer` |
| `origin`（来源） | `user` / `auto` | **谁写的**，据此定权威与门禁 | 写入入口决定 | frontmatter `origin` |
| `learnScope`（学习域） | `off` / `session` / `workspace` / `global` | **在什么上下文里允许 agent 主动学** | 用户设置，三级继承 | `evolution/*.json`，不是记忆属性 |

前两个是**数据属性**（跟着记忆走），第三个是**策略属性**（跟着环境走）。把它们混成一个字段，就会出现"这条记忆的 scope 是 session 还是 workspace"这种没法回答的问题——它既是会话里学的，又是工作区的。

还有一个策略字段 `writeTarget`，它不在轴上，是**上限**：路由判出"想要哪一层"之后，与它取更窄者（§2.3）。它不决定"在哪学"，也不决定"内容该落哪"，只决定"最宽能到哪"。

## 2. 交叉组合：能组合什么，不能组合什么

### 2.1 你的原话拆成两个诉求

> "生效层级是会话，自进化的记忆都是工作区的"

这句话里其实有两个独立的决定：

- **"自进化的记忆都是工作区的"** → 写入目标 = 工作区层。这决定 `layer=workspace`。
- **"生效层级是会话"** → 如果指的是记忆的可见范围，那 `layer=session`，与上一条**直接矛盾**：同一层不可能既是工作区又是会话。

所以必须先分清你说的"生效"是哪一种：

| 你的意思 | 配置 | 结果 |
| --- | --- | --- |
| A. **只在这个会话学**，学到的存进项目，下个会话还能用 | `learnScope=session` + `writeTarget=workspace` | `layer=workspace`；换会话仍注入 |
| B. **只在这个会话学，也只在这个会话用**，会话结束就作废 | `learnScope=session` + `writeTarget=session` | `layer=session`；换会话不注入，进孵化器 |
| C. **这个项目一直学**，跨会话 | `learnScope=workspace` + `writeTarget=workspace` | `layer=workspace` |
| D. **按内容判断**，该进项目进项目，该当便签当便签 | `learnScope=session` + `writeTarget=route` | 由路由表（§5）决定，默认推荐 |

**A 就是你要的那个组合**，而且它是合法的：在会话里学，但产物是工作区资产。B 是另一种合理诉求（临时探索），但不是"都是工作区的"。

A 有一个必须说清的副作用：**存进工作区就等于对其他会话可见**。你在会话 A 里学到的"这个仓库用 pnpm"，会话 B 打开同一个项目时会看到它——哪怕 B 没开自进化。这是工作区层的定义，不是 bug；但它和"只在这个会话生效"是相反的。UI 在选 A 时要显示这句提示，别让用户以为它还是私有的。

### 2.2 一条硬约束：写入层 = 生效层

不允许出现"存在 A 层，但只在 B 层可见"。原因是注入要维护第二套键：

```text
反例：文件在 memories/_ws/<hash>/，但注入时按 session 过滤
     → 要维护 storageKey 和 visibleKey 两个身份
     → dream 合并、墓碑、回收站、导出全部要对两套键
     → 一处漏改就是"记忆莫名消失"或"串项目泄漏"
```

所以最终 `layer` 只有一个：**路由结果与 `writeTarget` 上限取窄者**。不引入"存储层"与"生效层"的双重身份。如果哪天真需要"工作区存储 + 场景可见"，加一个 `when_scene` 过滤字段即可（加法，不改结构），而不是拆两个层。

### 2.3 完整的组合矩阵

`origin` 与 `layer` 的组合（数据侧），四种来源 × 四个层：

| origin \ layer | `global` | `workspace` | `scene` | `session` |
| --- | --- | --- | --- | --- |
| `user`（你手写 / `save`） | 现有 | **v1 开放** | 现有 | **v1 开放**（需确认） |
| `auto`（`learn` / 复习器） | 只提议 | 主战场 | 少（要明说） | 孵化器 |

`learnScope` × `writeTarget` 的组合（策略侧），七种有意义。注意 `writeTarget` 是**上限**，不是目标：

| # | learnScope | writeTarget（上限） | 行为 | 建议场景 |
| --- | --- | --- | --- | --- |
| 1 | `off` | — | 不学；已有记忆照常注入 | 别人的机器、敏感项目 |
| 2 | `session` | `session` | 本会话学，最多落会话：项目事实也只能当便签 | 探索、一次性排障 |
| 3 | `session` | `workspace` | 本会话学，最多落工作区：项目事实进工作区，会话约束仍进会话 | **你说的 A** |
| 4 | `session` | `route` | 本会话学，按内容判层（含全局，但需明说） | 推荐默认 |
| 5 | `workspace` | `workspace` | 这个项目一直学，最多工作区 | 长期项目 |
| 6 | `workspace` | `route` | 项目内学，按内容判层 | 推荐 |
| 7 | `global` | `route` | 到处学，按内容判层 | 默认 |

需要额外证据或降级的组合：

- `writeTarget=global` 且 `learnScope=session`：**合法**。会话里也能说出全局真理（「以后所有项目都先给结论」）。但进 `global` 要过两道：`user_explicit` + 引句含全局措辞（"所有项目/总是/以后都/every project/always"）。过不了就落 `workspace`，标 `auto_degraded=global-needs-explicit`。
  > 这条我最初写成"直接拒绝"，与 §5 路由表第一行打架——路由表说"用户说所有项目 → global"，拒绝规则说"会话里学的不许进 global"。根因是把 `learnScope`（在哪学）当成了 `writeTarget`（能写到哪）的上限，而这两件事无关。
- `writeTarget=scene` 且当前没启用场景：降级到 `workspace`，标 `auto_degraded=no-scene`。
- `learnScope=workspace` 且拿不到 cwd：降级到 `session`，标 `auto_degraded=no-workspace`。

## 3. 三级开关：只给这个对话/工作区开

### 3.1 继承链

```text
① 全局   evolution/settings.json
            { enabled: false, learnScope: "global", writeTarget: "route", ... }

② 工作区 evolution/workspaces.json[<hash16>].evolution
            { enabled?: true, learnScope?: "session", writeTarget?: "workspace" }

③ 会话   evolution/sessions.json[<sid>].evolution
            { enabled?: false, pausedAt?: "...", learnScope?: "session" }
```

解析顺序：**会话 → 工作区 → 全局，逐字段取第一个有定义的**。`undefined` 表示继承，不是"关"。

```ts
function resolveEvolutionConfig(global, workspace, session): EffectiveConfig {
  const pick = <K extends keyof EvolutionConfig>(k: K) =>
    session?.evolution?.[k] ?? workspace?.evolution?.[k] ?? global[k]
  return { enabled: pick('enabled'), learnScope: pick('learnScope'), ... }
}
```

### 3.2 为什么下层能覆盖上层的"关"

这是关键设计点。如果规定"全局关了下面一律不能开"，那你的诉求（全局关、只给这一个开）就无法表达。

| 全局 | 工作区 | 会话 | 结果 | 是否符合直觉 |
| --- | --- | --- | --- | --- |
| 关 | 未设 | 未设 | 关 | 是 |
| 关 | **开** | 未设 | 开（仅此工作区） | 是：你只给这个项目开了 |
| 关 | 未设 | **开** | 开（仅此会话） | 是：你只给这个对话开了 |
| 开 | **关** | 未设 | 关（仅此工作区） | 是：这个项目敏感 |
| 开 | 关 | **开** | 开（仅此会话） | 是：项目默认关，这个对话临时开 |
| 开 | 未设 | **关** | 关（仅此会话） | 是：这个对话别学 |

最后一行值得单说：**"这个对话别学"不应该影响下一个对话**。所以会话级覆盖必须持久化到 `sessions.json`（按 sid），不能只放内存——否则重启就忘，用户以为关了其实又开了。

### 3.3 "关"有三种，别做成一个

一个布尔值表达不了三种诉求：

| 配置 | 学（写） | 用（注入） | 用户想干什么 | UI 文案 |
| --- | --- | --- | --- | --- |
| `enabled=false` + `inject=false` | 关 | 关 | 功能休眠，什么都别干 | 「关闭」 |
| `enabled=false` + `inject=true` | 关 | 开 | 别学了，但之前学的还能用 | 「暂停学习」 |
| `enabled=true` + `inject=false` | 开 | 关 | 先攒着，我回头再看 | 「只记不用」（高级） |

默认把前两档暴露在 UI 上（「关闭」/「暂停学习」），第三档放高级设置。Codex 的 `generate_memories` / `use_memories` 两个开关就是这个思路，只是它没有三级继承。

**`inject` 的默认值跟随 `enabled`**：没显式设置时，学到哪一档的 `enabled`，就用哪一档的 `inject`。所以"全局关、只给会话 A 开"时，会话 B 既不在学、也不注入——符合"这个项目我暂时不想要自动记忆"的直觉。反过来，"我不学，但想用已有的"要显式设 `inject=true`，这是少数场景，放高级设置。

不这样定的话会出现一个别扭的默认：全新安装（`enabled=false`）却因为机器上有历史文件而注入自动记忆，用户会问"我不是关了吗"。

### 3.4 开关的存储与失效

| 层级 | 文件 | 键 | 生命周期 |
| --- | --- | --- | --- |
| 全局 | `evolution/settings.json` | 无 | 永久 |
| 工作区 | `evolution/workspaces.json` | `<hash16>`（`sha256(workspaceScopeKeyOf(cwd))` 前 16 位） | 工作区在就在 |
| 会话 | `evolution/sessions.json` | 真实 sid（校验过 `SEGMENT_RULE_HINT`） | 会话删后按 GC 清 |

读写方式沿用现有侧车范式（`src/settings-sidecars.ts`）：读走 3 秒 TTL 缓存，写走 `withWriteLock` + 严格读（文件损坏时拒绝保存，不用默认值覆盖）。

注入热路径需要**同步**拿到配置。做法与 `injectSettingsSync()` 相同：内存快照 + 异步预热，未加载时返回上一次的值（首次启动返回默认值 `enabled=false`，宁可少学一轮，不可猜错）。

## 4. 层与"作用域粒度"不是一回事

现有「作用域」页有一个全局设置：`global` / `session` / `workspace`，决定"逐条开关存在哪一格"。它和本篇的 `layer` 长得像，必须钉死区别：

|  | 层（本篇） | 作用域粒度（现有页面） |
| --- | --- | --- |
| 回答 | 这条记忆**谁能看见** | 逐条开关**存在哪一格** |
| 粒度 | 每条记忆一个层，四层可同时存在 | 全局只有一种粒度 |
| 真相 | `memories/` 的目录 + `auto_layer` | `scope-overrides.json` 的键 |
| 谁改 | 学习器 / 用户 | 用户在设置里点 |

**硬约束：层永远不读 `scopeMode()`。** 层只用真实的 sid（`sessionScopeIdOf`）和真实的 cwd（`workspaceScopeKeyOf`）。

否则：用户把粒度从"按会话"切成"按工作区"，所有 `_session/<sid>/` 的记忆会在一瞬间变成共享的——一次静默的隐私事故，且没有任何提示。反过来切回"按会话"，工作区记忆又集体消失。这不是配置问题，是数据归属问题。

两者相乘的合法组合：一条会话记忆可以被本会话单独关掉（`scope-overrides.json` 的 memory 域），但它不会因为粒度切换而换层。

## 5. 写入路由：新学的东西落哪一层

按顺序判，第一条命中就停，得到"**想要**落的那层"。然后与 `writeTarget` 上限取窄者；`writeTarget=route` 表示不设上限。

| 判据 | 落层 | 例子 |
| --- | --- | --- |
| 用户说「所有项目 / 总是 / 以后都」 | `global`（只提议，见下） | 「所有项目都先给结论」 |
| 只是本次对话的约束（换会话即失效） | `session` | 「这次别动 migrations」「先用 staging」 |
| 与该 cwd 有关的事实 / 命令 / 约定 | `workspace` | 「这个仓库用 pnpm」 |
| 明确以「写代码时 / 这个场景下」限定 | `scene` | 「写作时不要用表格」 |
| 以上都不成立（模型推断的弱信号） | `session`（孵化） | 「看起来他偏好短回答」 |

三条反向规则：

1. **场景开着，也不把项目事实写进场景。** curator 一看"当前有场景"就全归场景，是这套设计最容易犯的错。后果：用户切一次场景，刚学的项目事实全部消失，他会报"记忆丢了"。所以路由**不把当前场景当默认值**，只把它当"用户是否明说了模式限制"的证据。
2. **`global` 只由用户明说或跨工作区重复证据进入。** 模型推断的"通用偏好"先落 `session` 或 `workspace`。全局层写错的影响面最大，而用户甚至不知道它存在。
3. **推断强度决定层，不决定是否记录。** 弱推断不是不记，是记到最容易反悔的层。这比"弱就不记"好：信息留住了，错误代价被限制在一个会话内。

## 6. 层的生命周期

### 6.1 会话层 = 孵化器

- 会话结束不删文件，只是不再注入（sid 不匹配）。会话被恢复时自动回来——这正是"续上一个对话"该有的行为。
- dream 扫所有 `_session/*`：同一 `key` 在 **≥2 个不同会话**出现且内容一致 → 晋升（同工作区内 → `workspace`；跨工作区且 `user_explicit` → 提议 `global`）。
- 只有一条证据、且 30 天没人用 → 删，**不写墓碑**（它是本次对话的推断，不是用户的事实）。
- GC：sid 不在宿主存活清单、且目录 mtime > 30 天 → 整目录删。清单读不到时**不剪**（与 `pruneSessionScopes` 同一条纪律：读不到 ≠ 全被删了）。

### 6.2 工作区层 = 有身份的缓存

- 身份 = `sha256(workspaceScopeKeyOf(gitRootOf(cwd) ?? cwd))` 前 16 位，目录 `_ws/<hash16>/`。**必须先收敛到 git root**，否则从 `/repo` 进到 `/repo/src` 就换了个工作区，刚学的项目事实全部消失。真实路径与键存 `evolution/workspaces.json`，供 UI 显示。
- 改名/搬家 → 键变 → 旧目录成孤儿。**不做自动合并**（可能把两个不相干的项目并成一个，不可逆）；UI 在"同名 + 同 git remote + 旧路径已不存在"时提示一次，用户点"是同一个"才合并（改目录名 + 改映射 + 改 state 里的 id 前缀）。
- 路径失效：`workspaces.json` 标 `missingAt`，记忆保留 90 天，UI 标"路径已不存在"，可一键归档。项目在移动硬盘上拔掉，不该等于清空记忆。
- TTL：工作区层的事实默认 180 天；被用过（`helpful` 增长）就续期。

### 6.3 场景层 = 跟着场景走

改随目录改名、删随回收站、切走就看不见——这是它的定义，不是 bug。

删除场景会连同场景层的自动条目一起进回收站（`rulesRemoveScene` 的现有语义）。**不做隐式迁移**——少一条隐式搬运路径，就少一个"记忆莫名搬家"的 bug。代价要在 UI 上说清：「该场景下还有 3 条自动记忆，将一起进回收站」。

改名时目录与索引前缀都迁（`rulesUpdateScene` 已做），`state.json` 里的 id 前缀与 `auto_scene` 要跟着改（新增一步；漏了会让证据记录变成孤儿）。

### 6.4 全局层 = 最长寿，也最该有 TTL

身份/偏好类不设 TTL；事实类 365 天。

## 7. 四个保留段名

`_shared`（现有）、`_auto`（v0.2 遗留，v0.3 不再使用）、`_ws`、`_session`。全部满足：

- 不能作为场景名创建（`rulesCreateScene` 校验）。
- 不出现在场景选择器、场景卡片、场景档案里。
- `resolveActiveScenes` 的 `knownScenes` 要排除它们——**别只过滤渲染**，漏了 `collapseActiveForNewScene` 会让新建场景时把保留桶当候选清掉。

`_auto` 在 v0.3 保留为只读迁移源：首次启动时若发现 `memories/_auto/*`，按 `auto_scope` 字段搬到对应层，搬完留一个 `.migrated` 标记。见 `07-roadmap.md` §4。

## 8. 术语约定（后文一律按这个用词）

| 词 | 含义 | 不用它表示 |
| --- | --- | --- |
| 层 / layer | 记忆的可见范围，四选一 | 作用域粒度、开关范围 |
| 学习域 / learnScope | 允许主动学的上下文范围 | 记忆存在哪 |
| 写入目标 / writeTarget | 学到的条目默认落哪层 | 注入顺序 |
| 作用域粒度 | 现有「作用域」页的 `global/session/workspace` | 层 |
| 学习 / learn | agent 主动写记忆 | 用户手写 |
| 复习 / review | 轮末的写入判定（轻量） | dream |
| 整理 / dream | 批量合并/晋升/归档（重量，出草案） | 单轮写入 |
