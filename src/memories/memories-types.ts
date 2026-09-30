// 记忆域的对外类型面：依赖注入、规则条目、场景投影、服务出口、索引与档案形状。
//
// 从 memories/service.ts 整段搬来，一行未改。类型在编译期擦除，这一层只为把「形状」与
// 「实现」分开 —— service.ts 里读一个接口要翻过几百行实现，而 ops/ctx.ts 的依赖契约正
// 是要对着这些形状写的。
import type { ModeState, SceneArchive } from './archive.js'
import type { GroupIndexEntry, RuleIndexEntry, SceneIndexEntry } from './index-io.js'

// ── 对外接口 ───────────────────────────────────────────────────────────────

export interface MemoriesDeps {
  /** 记忆根目录（绝对路径；空串/未提供时按 $DSH_HOME/tool-management/memories 解析）。 */
  memoriesRoot: string
  /** 侧车目录（索引/回收站；空串/未提供时按 $DSH_HOME/tool-management 解析）。 */
  stateDir: string
  /** 场景记录目录（绝对路径；空串/未提供时按 <stateDir>/scenes 解析）。 */
  scenesDir?: string
  /**
   * 全局 `AGENTS.md` 的**宿主实际读的那一份**（同步返回；拿不到返回 null）。
   *
   * 为什么必须由外部注入而不是自己 `join(resolveDshHome(), 'AGENTS.md')`（2026-09-30 审查
   * P2-19）：全局指令的路径在本插件里有**两条独立来源** —— 写侧用宿主文档切片出的 profile
   * home（`ensurePaths()`，见 `index.ts` 的注释「不合并是有意的」），而 `resolveDshHome()`
   * 是 `$DSH_HOME` ‖ `~/.dsh`。两者不同时，去重会拿**另一个文件**去比 → 比对永远不相等 →
   * 同一份预设正文被注入两遍（常驻上下文成本）。所以让调用方把正确路径喂进来，本文件不猜。
   */
  globalAgentsMdPath?: () => string | null
  /** 场景记忆段预算上限（字节），默认 65536。 */
  maxBytes?: number
}

export interface Rule {
  id: string
  group: string
  name: string
  /** 对外契约用 form（与 §7.1 一致）；内部发现用 DiscoveredEntry.kind。 */
  form: 'flat' | 'bundle'
  /** 规则文件绝对路径（flat= .md；bundle= <名>.md，旧数据可能是 SKILL.md）。 */
  path: string
  description: string
  descriptionDerived?: boolean
  whenToUse?: string
  globs?: string
  metadata?: unknown
  enabled: boolean
  order: number
  tags: string[]
  pinned: boolean
  note: string
  updatedAt?: string
  /**
   * 正文文件在磁盘上的字节数（记忆是**直接吃注入预算**的那一域，128 KiB 上限按场景段算，
   * 界面上此前却看不出哪条大）。读不到文件时不带这个字段 —— 0 与"不知道"必须能分开。
   */
  bytes?: number
  /** 同名 bundle 存在时被遮蔽的 flat（UI 标红，不参与投影）。 */
  shadowed?: boolean
  /**
   * bundle 记忆的附件摘要。**只在 `rules-list` 的返回里**补上（发现阶段不扫附件目录）；
   * flat 记忆没有这个字段。目录读不到时也不会有（界面据此不显示附件标签，而不是谎报 0）。
   */
  attach?: { count: number; bytes: number; names: string[] }
}

export interface GroupRow {
  name: string
  label: string
  order: number
  count: number
}

/** 场景 = 记忆的一级归属；`global` 为保留的「全局」场景。 */
export interface SceneRow {
  name: string
  label: string
  order: number
  /** 该场景目录树内的记忆条数（不含被遮蔽条目）。 */
  count: number
  /** 是否参与系统提示词注入（`_shared` 与 `global` 恒为 true）。 */
  active: boolean
  /** `_shared`：公共基线，UI 上锁定为常开。 */
  shared: boolean
  /** 保留场景 `global`（界面「全局」）：不可删除、不可停用。 */
  global: boolean
  /** 场景描述（用户在「新建/编辑场景」里填的一句话）。 */
  description: string
}

/** 场景记忆段的一次渲染结果（纯函数产物，确定性：无时间戳/计数）。 */
export interface SceneMemoryProjection {
  text: string
  bytes: number
  truncated: boolean
  maxBytes: number
  /** 参与渲染的场景（确定性顺序，含 `_shared` 与全局 `''`）。 */
  scenes: string[]
  items: Array<{ id: string; scene: string; name: string; bytes: number }>
  /** 因超出预算**未**注入的记忆（确定性顺序；段尾也会列出它们，模型与用户都能看见）。 */
  dropped: Array<{ id: string; scene: string; name: string; bytes: number }>
}

/** 当前生效的场景提示词投影（供注入兜底与只读状态展示）。 */
export interface ScenePromptProjection {
  /** 提供这段提示词的场景；`null` = 没有任何场景绑定提示词。 */
  scene: string | null
  /** 绑定的预设 id；`null` = 未绑定。 */
  presetId: string | null
  /** 预设正文（逐字节原样；段为空时宿主会删除该段）。 */
  text: string
  /** 绑定了预设但文件不存在/为空（UI 要如实标出来，别让用户以为注入了）。 */
  missing: boolean
  /**
   * 绑定的预设与**当前 `~/.dsh/AGENTS.md` 内容一致** → 不重复注入（否则同一份正文会出现两遍）。
   * 此时这份预设本来就是生效中的基线，用户看不出差别；界面据此显示「生效中」。
   */
  duplicate?: boolean
}

export interface MemoriesService {
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生；与 ops 表同文件同源维护）。 */
  writeOps: ReadonlySet<string>
  /**
   * 记忆段文本（`memory-manager-catalog`；注入通道同步取用，见 src/context-inject.ts）。
   * **读失败抛异常**（2026-09-30 审查 F7）：注入通道据此报 `error` 而不是把"读不动"当成
   * "用户清空了记忆"，从而不发那条假的「已清空」。界面投影走内部的 `sceneMemory()`（不抛）。
   */
  memoryText: () => string
  /**
   * 场景段文本（`scene-manager-catalog`）：**启用的场景 + 场景说明**（约定）。
   * 与记忆段是两个独立注入段，各自去重、各自可被关掉（见 snapshot.ts 的 renderSceneCatalog）。
   * 与 `memoryText` 同口径：读失败抛异常。
   */
  sceneCatalogText: () => string
  /**
   * 全局提示词正文（注入兜底用；官方 agent-instructions 行没挂时才被取用）：
   * 场景期间 = 当前场景绑定的提示词，否则 = `~/.dsh/AGENTS.md` 正文。
   * **读失败抛异常**（同 `memoryText`）：预设/基线文件读不动时不能报成"没有提示词"。
   */
  promptText: () => string
  /**
   * `promptText()` 的来源文件（同步；注入通道用作 instructions 形态的 `changes`，
   * 界面据此显示文件清单与「已载入/已更新」）。`[]` = 本次没有提示词正文。
   * 与 `promptText()` 同源，因此同样可能抛 —— 注入通道已在自己的 `files()` 调用处接住。
   */
  promptFiles: () => Array<{ path: string; digest: string }>
  /** 失效快照与场景记忆缓存（写操作后调用）。 */
  refresh: () => Promise<void>
  /**
   * 场景档案引擎专用：读-改-写 mode/archives/active 切片（写队列内执行，非公开 op，无门禁面）。
   * `fields` = 意图声明，只写列出的那几项；不传按 `patch` 里出现的字段全写（见实现处注释）。
   */
  patchIndex: (
    patch: { mode?: ModeState; archives?: Record<string, SceneArchive>; active?: string[] | null },
    fields?: ReadonlyArray<'mode' | 'active' | 'archives'>,
  ) => Promise<void>
  /** 场景档案引擎专用：只写一个场景的档案（队列内逐场景增量，不覆盖并发写的别的场景）。 */
  saveArchive: (scene: string, archive: SceneArchive | null) => Promise<void>
  /** 场景档案引擎专用：读 mode/archives/active 切片。 */
  readArchiveSlice: () => Promise<{ mode: ModeState; archives: Record<string, SceneArchive>; active: string[] | null }>
  /**
   * 各场景的锁定态（场景名 → 是否被锁；只读快照，直接读索引）。
   * MCP 删除服务要同步清场景档案里的引用：被锁场景的档案是用户显式冻结的，
   * 那部分键必须保留并如实上报，不能绕开门禁偷偷写（见 mcpmRemove）。
   */
  sceneLocks: () => Promise<Record<string, boolean>>
}

// ── 内部类型 ───────────────────────────────────────────────────────────────

export interface RulesIndex {
  version: 1
  rules: Record<string, RuleIndexEntry>
  groups: Record<string, GroupIndexEntry>
  /** 场景记录（`scenes/<名>.json` 的镜像，索引为准）：名称 → 描述/顺序/创建时间。 */
  scenes?: Record<string, SceneIndexEntry>
  /** 启用场景集合；`null` / 缺失 = 全部场景启用（默认，保证"丢进去就有用"）。 */
  active?: string[] | null
  /** 场景档案（设计 §2.1）：每场景可选的 tools/skills/subagents 勾选集，键存在性独立于集合空否。 */
  archives?: Record<string, SceneArchive>
  /** 当前模式（设计 §2.2）：至多一个场景的档案生效；snapshot = 进入时的运行时启停，退出恢复。 */
  mode?: ModeState
}

/**
 * 一条场景记录。
 *
 * 真源是**索引的 `scenes` 切片**（`index.scenes[name]`）—— 本接口由 `sceneRecordOf()` 从索引
 * 反向构造出来，供响应体使用；`scenes/<名>.json` 那个目录是 v0.3 遗留空壳，从不读写。
 * （主从关系此前写反了，见文件头。）
 */
export interface SceneRecord {
  /** 场景名（= 记忆目录名；`global` 为保留场景）。 */
  name: string
  /** 界面显示名；缺省用 name（保留场景显示「全局」）。 */
  label?: string
  /** 一句话说明这个场景是干什么的（界面卡片副标题）。 */
  description?: string
  /**
   * 绑定的提示词预设 id（`tool-management/prompts/<id>/AGENTS.md`）。
   * 启用该场景时，宿主把这份正文写进 `~/.dsh/AGENTS.md`（scene-prompt-sync.ts，与「提示词」页
   * 的「应用」同一条路，关掉场景恢复进场景前的基线）；预设挂不到官方 agent-instructions 行时
   * （极简），注入通道再拿这份正文兜底（`promptText()` → src/context-inject.ts）。
   * 一个场景至多绑定一个（单值字段即天然单选）；未启用/未绑定 → 不注入。
   */
  prompt?: string
  order?: number
  /** ISO 时间戳；只要**创建**时间，不参与提示词段（段必须逐字节稳定）。 */
  createdAt?: string
}

/** 同步扫描得到的单条场景记忆（供注入文本渲染）。 */
export interface SceneMemoryFile {
  id: string
  /** 一级目录名；`''` = 规则根目录下的全局记忆，`_shared` = 公共基线。 */
  scene: string
  name: string
  description: string
  descriptionDerived: boolean
  order: number
  body: string
  /** `bundle` = 目录形态（正文是 `<名>.md`，同目录其余文件是附件）；`flat` = 单个 .md。 */
  kind: 'flat' | 'bundle'
  /** bundle 的目录（flat 为 `''`）：只用来把**路径**告诉模型，附件正文一律不注入。 */
  bundleDir: string
}
