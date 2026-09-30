// 宿主能力表：每一项写明「插件要用宿主的哪个成员、缺了走哪条降级路」。
//
// 这张表就是与宿主的契约本体 —— 纯字面量，判定逻辑在 probe.ts 的 inspectCapability，
// 取数原语在 host-probe.ts。缺一个成员时界面给出的是这一行点名的降级，而不是删除序列
// 中途抛出的一次异常。
import { callableWithSentinel, isFn, PROBE_SENTINEL, type Target } from './host-probe.js'
import type { CapabilityFinding } from './probe-types.js'

export interface CapabilitySpec {
  readonly id: string
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  // 这里不写 `CapabilityFinding['owner']`：那张表的 owner 还允许 `'plugin'`（运行时上报的行，
  // 如补丁写入校验不可用），而宿主能力表只可能挂在宿主对象上 —— 写宽了会让下面的
  // `targets: Record<CapabilitySpec['owner'], …>` 强制多出一个不存在的宿主对象。
  readonly owner: 'workspace' | 'projectionCache' | 'sessions' | 'persistence' | 'settings' | 'presetRoster' | 'fs'
  readonly fallback: CapabilityFinding['fallback']
  /** Required function members on the owning object's prototype. */
  readonly methods?: readonly string[]
  /** Required non-function members, checked for `instanceof` when given. */
  readonly fields?: readonly { readonly name: string; readonly instanceOf?: 'Map' | 'Array' | 'Set' }[]
  /** Extra live behaviour check; returns a failure detail or undefined. */
  readonly probe?: (target: Target) => string | undefined
  /**
   * Optional extra text appended to the ok detail — how a spec shows what it
   * OBSERVED on the live host (e.g. the settings document path). 返回 undefined
   * 就不加后缀。健康行也带观测值：官方下一次改返回语义，页面上那行字一眼见底，
   * 而不必等到哪个功能静默失明（0.15.0 的教训）。
   */
  readonly describe?: (target: Target) => string | undefined
  /** Members that must be callable when the capability applies. */
  readonly when?: (target: Target) => boolean
  /** Absence is a routing fact, not a failure — see {@link CapabilityFinding.optional}. */
  readonly optional?: boolean
}

/**
 * The capability table. This IS the contract with the host: everything the
 * adapters reach for is listed here with what happens when it is absent, so a
 * missing member produces a named, visible degradation instead of a throw from
 * somewhere in the middle of a delete sequence.
 */
export const CAPABILITY_SPECS: readonly CapabilitySpec[] = [
  // ---- workspace registry: read side -------------------------------------
  {
    id: 'workspace.read-state',
    label: '读取工作区状态',
    kind: 'read',
    owner: 'workspace',
    fallback: 'refuse-operation',
    methods: ['requireState'],
    probe: (t) => {
      try {
        const state = (t as { requireState: () => unknown }).requireState()
        if (state === null || typeof state !== 'object') return 'requireState() 未返回对象'
        const value = state as { archivedSessionIds?: unknown; workspaceIds?: unknown }
        if (!Array.isArray(value.archivedSessionIds)) return 'requireState().archivedSessionIds 不是数组'
        if (!Array.isArray(value.workspaceIds)) return 'requireState().workspaceIds 不是数组'
        return undefined
      } catch (error) {
        return `requireState() 抛错：${String((error as Error)?.message ?? error)}`
      }
    },
  },
  {
    id: 'workspace.read-table',
    label: '读取工作区表',
    kind: 'read',
    owner: 'workspace',
    fallback: 'refuse-operation',
    methods: ['requireTable'],
    probe: (t) => {
      try {
        const table = (t as { requireTable: () => unknown }).requireTable()
        if (table === null || typeof table !== 'object' || !isFn((table as { get?: unknown }).get)) return 'requireTable() 未返回可 get 的表'
        return undefined
      } catch (error) {
        return `requireTable() 抛错：${String((error as Error)?.message ?? error)}`
      }
    },
  },
  {
    id: 'workspace.index-shape',
    label: '工作区索引结构',
    kind: 'read',
    owner: 'workspace',
    fallback: 'refuse-operation',
    fields: [
      { name: 'headers', instanceOf: 'Map' },
      { name: 'sessionPaths', instanceOf: 'Map' },
      { name: 'invalidSessionPaths', instanceOf: 'Map' },
      { name: 'entities', instanceOf: 'Map' },
    ],
  },
  {
    id: 'workspace.read-header',
    label: '读取会话头部',
    kind: 'read',
    owner: 'workspace',
    fallback: 'refuse-operation',
    methods: ['readSessionHeader'],
  },
  // ---- workspace registry: write side ------------------------------------
  {
    id: 'workspace.enqueue',
    label: '串行写事务',
    kind: 'write',
    owner: 'workspace',
    fallback: 'disable-destructive',
    methods: ['enqueueOperation'],
  },
  {
    id: 'workspace.set-state',
    label: '写工作区状态',
    kind: 'write',
    owner: 'workspace',
    fallback: 'disable-destructive',
    methods: ['setState'],
  },
  {
    id: 'workspace.index-header',
    label: '索引会话头部',
    kind: 'write',
    owner: 'workspace',
    fallback: 'disable-destructive',
    methods: ['indexHeader'],
  },
  {
    id: 'workspace.archive-native',
    label: '宿主原生归档入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['archiveSession'],
    optional: true,
    // 分层探针第二层（哨兵真调）：官方实现对未知 id 走读路径校验后受控拒绝
    //（WorkspaceUnknownSessionError）；同步 TypeError 才是「不该路由信任」的信号。
    probe: (t) => callableWithSentinel(t, 'archiveSession', PROBE_SENTINEL),
  },
  {
    id: 'workspace.unarchive-native',
    label: '宿主原生恢复入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['unarchiveSession'],
    optional: true,
    probe: (t) => callableWithSentinel(t, 'unarchiveSession', PROBE_SENTINEL),
  },
  {
    id: 'workspace.batch-native',
    label: '宿主原生批量入口',
    kind: 'write',
    owner: 'workspace',
    fallback: 'native-entry',
    methods: ['archiveWorkspaceSessions'],
    optional: true,
    probe: (t) => callableWithSentinel(t, 'archiveWorkspaceSessions', [PROBE_SENTINEL]),
  },
  {
    id: 'workspace.delete-native',
    label: '宿主原生删除入口',
    kind: 'delete',
    owner: 'workspace',
    // NOT `disable-destructive`: when this slot is empty the plugin performs the
    // whole delete itself, so nothing is disabled. `native-entry` describes what
    // actually happens (the adapter takes over).
    fallback: 'native-entry',
    methods: ['deleteSession'],
    optional: true,
    // 删除路由的 native 判定此前只看方法存在（07 审查五档问题 2）：宿主升级把同名
    // 方法换成别的签名，路由仍会走 native 裸调。哨兵真调把口径提到「可调用」，
    // 文本比对收紧（见 inspectCapability 的 delete 类分支）负责「实现漂移」那一层。
    probe: (t) => callableWithSentinel(t, 'deleteSession', PROBE_SENTINEL),
  },
  // ---- sessions runtime (private members, used only on the live branch) ---
  {
    id: 'sessions.detach-live',
    label: '实时会话落盘与分离',
    kind: 'delete',
    owner: 'sessions',
    fallback: 'disable-destructive',
    methods: ['flush', 'liveEntryFor', 'detachEntered'],
    // 零副作用真调（按官方源码核对）：liveEntryFor/flush 对哨兵在查表处受控抛错；
    // detachEntered 传普通对象在未知 id 处早退（entry 形状 {id} 即可）。
    probe: (t) =>
      callableWithSentinel(t, 'liveEntryFor', PROBE_SENTINEL)
      ?? callableWithSentinel(t, 'flush', PROBE_SENTINEL)
      ?? callableWithSentinel(t, 'detachEntered', { id: PROBE_SENTINEL }),
  },
  {
    id: 'sessions.cold-announce',
    label: '冷会话移除广播',
    kind: 'delete',
    owner: 'sessions',
    fallback: 'disable-destructive',
    methods: ['enter', 'announce'],
    // announce 哨兵真调：内部先 liveEntryFor 查表，哨兵输入在查表处受控抛错。
    // **enter 不真调**（官方实现对任意输入都会往 store 写入条目），它只有存在性 + 文本比对。
    probe: (t) => callableWithSentinel(t, 'announce', PROBE_SENTINEL),
  },
  // ---- projection cache ---------------------------------------------------
  {
    id: 'projection.write',
    label: '投影缓存写入路径',
    kind: 'write',
    owner: 'projectionCache',
    fallback: 'disable-destructive',
    methods: ['write', 'put', 'requireTable'],
  },
  {
    // B2：此前它只是 bridge 运行时那句拒绝里的**临时 id**（`acquireCacheGuard` 里现场拼的），
    // 于是客户端压根不知道它 —— 宿主表不可删时，"路由说可用、点下去必拒"（V13）。提升为
    // 能力表的正式条目后，路由判定与运行时前提同一份依据。
    id: 'projection.table-delete',
    label: '投影缓存行删除',
    kind: 'delete',
    owner: 'projectionCache',
    fallback: 'disable-destructive',
    // 探测内容就是运行时那句硬前提：`requireTable().delete` 在不在。
    probe: (target) => {
      if (typeof target?.requireTable !== 'function') return '宿主投影缓存缺少 requireTable'
      let table: { delete?: unknown } | undefined
      try { table = (target.requireTable as () => { delete?: unknown })() }
      catch (error) { return `宿主投影缓存 requireTable() 抛错：${String(error)}` }
      if (typeof table?.delete !== 'function') return '宿主投影缓存存储不支持安全删除（table.delete 缺失）'
      return undefined
    },
  },
  {
    id: 'projection.delete-native',
    label: '投影缓存删除屏障',
    kind: 'delete',
    owner: 'projectionCache',
    // Absent on rc.2: `sessions/bridge.ts` installs a checked write barrier
    // instead, so absence is a routing fact, not a failure. Only a cache whose
    // write path cannot be wrapped at all is a real problem.
    fallback: 'native-entry',
    optional: true,
    probe: (t) => {
      if (isFn(t?.delete) && isFn(t?.whenIdle)) return undefined
      const wrappable = ['write', 'put'].filter((name) => !isFn(t?.[name]))
      if (wrappable.length > 0) return `宿主缓存无法安全包裹（缺少 ${wrappable.join(', ')}）`
      let table: unknown
      try {
        table = (t as { requireTable: () => unknown }).requireTable()
      } catch (error) {
        return `requireTable() 抛错：${String((error as Error)?.message ?? error)}`
      }
      if (!isFn((table as { delete?: unknown })?.delete)) return '宿主缓存存储不支持行删除（table.delete 缺失）'
      return undefined
    },
  },
  // ---- settings document path（0.1.7 的两处适配面之一）----------------------
  // `prepareDocument()` 在 0.1.7 把返回值从「主目录下的设置文档路径」改成「profile 补丁
  // 路径」（`configEditor.documentPath`）—— 方法一直在、语义变了，方法存在性探测抓不住
  // （0.15.0 的 MCP 页事故就是这么静默发生的）。这一条能拦的是「方法消失 / 签名漂移到
  // 同步抛 TypeError」；**返回值形状**是异步结果，同步探针看不到，那一半由 ensurePaths
  // 的 await 后自检负责（src/index.ts：认 profile 形状上溯 + 主目录不变量检查，异常走
  // noteRuntime）。两半合起来才是这个契约的完整探测。
  {
    id: 'settings.document-path',
    label: '设置文档路径（主目录推导源）',
    kind: 'read',
    owner: 'settings',
    fallback: 'refuse-operation',
    methods: ['prepareDocument'],
    // 零副作用真调：官方实现就是 `Promise.resolve(this.documentPath)`，纯读。拿不到
    // 异步结果没关系 —— 同步 TypeError（签名漂移）才是这一层要拦的。
    probe: (t) => callableWithSentinel(t, 'prepareDocument'),
    // 健康行也常显观测路径（官方 SettingsForms 有同步的 `documentPath` getter，
    // prepareDocument 就是它的 Promise 包装）：语义再变，页面上这行字一眼见底。
    describe: (t) => {
      try {
        const p = (t as { documentPath?: unknown }).documentPath
        return typeof p === 'string' && p !== '' ? `观测路径：${p}` : undefined
      } catch { return undefined }
    },
  },
  // ---- ctx.fs：MCP 域补丁写路径的唯一出口（审查 §5 F5）----------------------
  // 为什么值得单列：补丁文件在插件自己的数据目录**之外**（`~/.dsh/cordis.patch.yml` 与
  // `profiles/<名>/cordis.patch.yml`），读写都得经 `ctx.fs` 显式升级沙箱策略。五个方法里
  // 任何一个改名，19 处补丁写路径会**一起**报错 —— 报错是可见的（不是静默），但要等到用户
  // 点下去才发现；钉在兼容页上就能在升级后第一眼看见。
  //
  // 能探到 / 探不到（如实标注）：成员存在性可探；`writeText` 的**实参个数**可观测（健康行
  // 附注）。「五个位置参数的语义变了」**探不到** —— 真调它会写文件（有副作用），而本探针
  // 的纪律是零副作用（见 callableWithSentinel 的副作用口径）。那半条只能靠宿主升级清单人工核对。
  {
    id: 'fs.patch-io',
    label: '宿主文件读写（补丁文件出口）',
    kind: 'write',
    owner: 'fs',
    fallback: 'refuse-operation',
    methods: ['resolve', 'stat', 'readText', 'writeText', 'listDir'],
    describe: (t) => {
      const w = (t as { writeText?: unknown }).writeText
      return typeof w === 'function' ? `观测 writeText 实参个数=${w.length}` : undefined
    },
  },
  // ---- agent preset roster（0.1.7 的两处适配面之二）-------------------------
  // 0.1.7 把 `read(id)`（直返组合文本）改名成 `readDocument(id)`（返回文档对象，组合
  // YAML 在 `.content`）。读取口是「read 优先、readDocument 兜底」双入口
  // （preset-reach.ts 的 readCompositionText），两个名字**任一在场即可** —— 这正是
  // methods 列表表达不了的 either-or，用 probe 写。list / composedPreset 缺一个，
  // 注入边界矩阵与边界提示就瞎一半，同为必需。
  {
    id: 'preset.roster-surface',
    label: '预设名册读取面',
    kind: 'read',
    owner: 'presetRoster',
    fallback: 'inform-only',
    probe: (t) => {
      const o = t as Record<string, unknown>
      const hasRead = isFn(o.read)
      const hasDoc = isFn(o.readDocument)
      if (!hasRead && !hasDoc) return 'read 与 readDocument 都缺失：组合文本读不到，注入边界矩阵与极简兜底注入失明'
      const missing = ['list', 'composedPreset'].filter((name) => !isFn(o[name]))
      if (missing.length > 0) return `名册缺少 ${missing.join(', ')}：注入边界矩阵不完整`
      return undefined
    },
    // 健康行附注实际走的读取路。0.1.7 起 `read` 改名 `readDocument`，兜底成功是**正常形态**
    // 而非降级 —— 这句话只出现在绿色行上（运行时上报会渲染成问题行，那里不放）。
    describe: (t) => {
      const o = t as Record<string, unknown>
      if (!isFn(o.read) && isFn(o.readDocument)) return '读取走 readDocument（宿主 0.1.7 起的形态）'
      return undefined
    },
  },
]