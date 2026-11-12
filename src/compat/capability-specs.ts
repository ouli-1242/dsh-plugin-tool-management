// 宿主能力表：每一项写明「插件要用宿主的哪个成员、缺了走哪条降级路」。
//
// 这张表就是与宿主的契约本体 —— 纯字面量，判定逻辑在 probe.ts 的 inspectCapability，
// 取数原语在 host-probe.ts。缺一个成员时界面给出的是这一行点名的降级，而不是删除序列
// 中途抛出的一次异常。
import { callableWithSentinel, isAsyncFn, isFn, PROBE_SENTINEL, resolvableFromHost, type Target } from './host-probe.js'
import type { CapabilityFinding } from './probe-types.js'

/** 一项宿主能力的规格：长在哪、要什么、怎么判、缺了怎么绕。 */
export interface CapabilitySpec {
  readonly id: string
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  // 这里不写 `CapabilityFinding['owner']`：那张表的 owner 还允许 `'plugin'`（运行时上报的行，
  // 如补丁写入校验不可用），而宿主能力表只可能挂在宿主对象上 —— 写宽了会让下面的
  // `targets: Record<CapabilitySpec['owner'], …>` 强制多出一个不存在的宿主对象。
  readonly owner:
    | 'workspace' | 'projectionCache' | 'sessions' | 'persistence' | 'settings'
    | 'presetRoster' | 'fs' | 'tools' | 'systemPrompt' | 'agentContext' | 'connection'
    | 'subagents' | 'llm' | 'approval' | 'skills' | 'agents' | 'pluginInventory'
    | 'webServer' | 'sandboxPolicy'
  readonly fallback: CapabilityFinding['fallback']
  /** 宿主对象原型上必须具备的方法名。 */
  readonly methods?: readonly string[]
  /** 必须具备的非函数成员；给了 `instanceOf` 就按 `instanceof` 校验类型。 */
  readonly fields?: readonly { readonly name: string; readonly instanceOf?: 'Map' | 'Array' | 'Set' }[]
  /** 额外的活体行为检查：返回失败说明，或 undefined 表示通过。 */
  readonly probe?: (target: Target) => string | undefined
  /**
   * 可选：往 ok 的说明后面追加观测值（如设置文档的实际路径）。返回 undefined 就不加后缀。
   * 健康行也要带观测值 —— 官方下一次改返回语义时，页面上那行字一眼见底，
   * 不必等到某个功能静默失明才发现。
   */
  readonly describe?: (target: Target) => string | undefined
  /** 能力适用时必须可调用的成员。 */
  readonly when?: (target: Target) => boolean
  /** 缺席是路由事实而非失败，见 {@link CapabilityFinding.optional}。 */
  readonly optional?: boolean
  /**
   * 静态检查的**门槛**：只在宿主锚点也认这条能力时才检查（默认总会检查）。
   *
   * 什么时候要它：某个 owner 的参考副本不在本插件的依赖图里（如 connection 的
   * `dsh-client-connection` 不是 peer），doctor 从插件锚点解析不到那个包，于是把一条
   * 运行时其实存在的能力记成 `missing` —— 那是与事实相反的结论，用户照它去修只会白费
   * 功夫（`connection.admit` 就这么误报过）。
   */
  readonly staticWhen?: () => boolean
}

/**
 * 能力表。它就是与宿主之间的契约：适配器伸手要的每一样都列在这里，并写清缺席时的后果，
 * 于是缺一个成员得到的是**有名有姓、界面上看得见**的降级，而不是删除序列跑到一半抛出的错。
 */
export const CAPABILITY_SPECS: readonly CapabilitySpec[] = [
  // ---- 工作区登记表：读侧 ----------------------------------------------
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
  // ---- 工作区登记表：写侧 ----------------------------------------------
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
    // 不能写 `disable-destructive`：这个槽位空着时插件自己把整个删除做完，没有任何东西被
    // 停用。`native-entry` 说的是实际发生的事（适配器接管）。
    fallback: 'native-entry',
    methods: ['deleteSession'],
    optional: true,
    // 删除路由的 native 判定此前只看方法存在：宿主升级把同名
    // 方法换成别的签名，路由仍会走 native 裸调。哨兵真调把口径提到「可调用」，
    // 文本比对收紧（见 inspectCapability 的 delete 类分支）负责「实现漂移」那一层。
    probe: (t) => callableWithSentinel(t, 'deleteSession', PROBE_SENTINEL),
  },
  // ---- 会话运行时（私有成员，只在活宿主分支上用）------------------------
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
  {
    // 列表与删除都会碰实时会话：历史页读会话正文用 `get`，删除子会话级联用 `list`。
    // 缺任何一个都不会在"进入删除主体之前"被发现 —— 路由必须把它们算进要求里。
    id: 'sessions.live-access',
    label: '实时会话读取（get / list）',
    kind: 'read',
    owner: 'sessions',
    fallback: 'refuse-operation',
    methods: ['get', 'list'],
  },
  // ---- 持久化后端：历史列表与删除的共同底座 ------------------------------
  // 这两个成员此前完全不在能力表里：删除入口自己会在破坏性步骤前硬检查，
  // 但兼容页 / 路由看不见它们 —— 页面说「删除可用」而点下去在链路中段才报错。
  {
    id: 'persistence.list',
    label: '会话存储枚举',
    kind: 'read',
    owner: 'persistence',
    fallback: 'refuse-operation',
    methods: ['list'],
  },
  {
    id: 'persistence.transcript-locate',
    label: '会话转写工件定位',
    kind: 'delete',
    owner: 'persistence',
    fallback: 'disable-destructive',
    methods: ['locate'],
  },
  {
    // 投影修复是可选路径：两代读取入口任一在场即可（新版 open 句柄 / 旧版 readFrom）。
    // 都缺时只少「归档会话的投影补建」，不碰数据，所以只上报不拦路。
    id: 'persistence.transcript-read',
    label: '会话转写读取（投影修复）',
    kind: 'read',
    owner: 'persistence',
    fallback: 'inform-only',
    optional: true,
    probe: (t) => (isFn(t?.readFrom) || isFn(t?.open))
      ? undefined
      : '持久化后端既没有 readFrom 也没有 open：归档会话的投影修复会静默跳过',
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
    // 于是客户端压根不知道它 —— 宿主表不可删时，"路由说可用、点下去必拒"。提升为
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
    id: 'projection.cached-title',
    label: '投影缓存标题读取（cachedSnapshot）',
    kind: 'read',
    owner: 'projectionCache',
    fallback: 'inform-only',
    methods: ['cachedSnapshot', 'cachedPredecessorTitle'],
    // 两个入口都是同步、零 I/O 的列表提示面；用哨兵 header 真调一次，只验证「不抛错」
    // 与「有值时带 values 对象」—— 真实标题取决于磁盘记录，交给人工核对。
    probe: (t) => {
      const snapshot = (t as { cachedSnapshot?: (meta: unknown, keys?: unknown) => unknown }).cachedSnapshot
      const predecessor = (t as { cachedPredecessorTitle?: (meta: unknown) => unknown }).cachedPredecessorTitle
      if (typeof snapshot !== 'function') return '宿主投影缓存缺少 cachedSnapshot()：归档列表读不到标题'
      if (typeof predecessor !== 'function') return '宿主投影缓存缺少 cachedPredecessorTitle()：旧格式代际的标题提示不可用'
      try {
        const value = snapshot.call(t, { id: PROBE_SENTINEL }, ['title'])
        if (value !== undefined) {
          const values = value === null ? null : (value as { values?: unknown }).values
          if (typeof value !== 'object' || values === null || typeof values !== 'object') {
            return 'cachedSnapshot() 的返回值缺少 values 对象：标题读取形状变了'
          }
        }
      } catch (error) {
        return `cachedSnapshot(哨兵 header) 抛错：${String((error as Error)?.message ?? error)}`
      }
      try { predecessor.call(t, { id: PROBE_SENTINEL }) }
      catch (error) { return `cachedPredecessorTitle(哨兵 header) 抛错：${String((error as Error)?.message ?? error)}` }
      return undefined
    },
  },
  {
    id: 'projection.delete-native',
    label: '投影缓存删除屏障',
    kind: 'delete',
    owner: 'projectionCache',
    // 宿主没有它时 `sessions/bridge.ts` 会装一层受检的写屏障顶上，所以缺席是路由事实、
    // 不是故障。真正的故障只有一种：缓存的写路径根本包不住。
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
  // （MCP 页就这样静默失明过一次）。这一条能拦的是「方法消失 / 签名漂移到
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
  // ---- ctx.fs：MCP 域补丁写路径的唯一出口----------------------
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
  // ---- 0.2.1 的四处新契约面 ------------------------------------------------
  // 这四条都是**本版适配真实依赖**的宿主成员。它们与上面那些的区别是：上面那些从 0.1.x
  // 起就在表里，而这四个是 0.2.1 才出现的 —— 下一代宿主改掉其中任何一个，对应的功能会
  // **静默失效**（不抛错、只少一半），所以必须在升级后第一眼可见。
  //
  // 逐条的后果：
  //   ① register 没了 → 带人设的子代理委派失败（临时预设注册不上去）；
  //   ② restrict 没了 → 人设的 tools/toolsDeny 不生效，子代理继承父级全部工具；
  //   ③ agent/created 不串行 → 工具限制慢一步（首轮看到的还是继承来的工具集）；
  //   ④ admit 没了 → Web 鉴权退回本地回环判定，本机任意进程可调写 op。
  {
    id: 'agentPreset.register',
    label: '临时子预设注册',
    kind: 'write',
    owner: 'presetRoster',
    fallback: 'refuse-operation',
    methods: ['register'],
    // 只查存在性 + 与参考副本的文本比对，**不真注册**：register 会真的树上挂一棵插件树。
    probe: (t) => isFn(t?.register) ? undefined : '宿主预设名册缺少 register()：带人设的子代理委派无法创建独立预设',
  },
  {
    id: 'tools.restrict-method',
    label: '工具限制施加（restrict）',
    kind: 'write',
    owner: 'tools',
    fallback: 'disable-destructive',
    methods: ['restrict'],
    probe: (t) => isFn(t?.restrict) ? undefined : '宿主工具服务缺少 restrict()：人设的工具限制不生效，子代理将继承父级全部工具',
  },
  {
    // 探测的是 **agent 作用域**上 `on` 在场这一事实。真正的时序保证（announce 等待
    // 串行 agent/created 监听全部完成后才放行收件箱）藏在宿主源码里，探针看不见 ——
    // 这一条能抓的是"ctx.on 整个没了 / 改名"，那时监听器挂不上、限制退化成事后施加。
    id: 'agent.created-event',
    label: '子代理创建事件（agent/created）',
    kind: 'read',
    owner: 'agentContext',
    fallback: 'disable-destructive',
    methods: ['on'],
    probe: (t) => isFn(t?.on) ? undefined : 'agent 作用域缺少 on()：无法在子代理创建时施加工具限制',
  },
  {
    // 0.2.1 起宿主把鉴权栅栏拆成 admit()/requestRejection() 两层（见 http-fence.ts）。
    // admit 不在场时插件退回 requestRejection，再缺则退回本地回环判定 —— 每一级都少一层，
    // 但都不抛错，所以必须单列一条让人看得见现在停在哪一级。
    id: 'connection.admit',
    label: '连接准入（admit）',
    kind: 'read',
    owner: 'connection',
    fallback: 'refuse-operation',
    methods: ['admit'],
    probe: (t) => isFn(t?.admit) ? undefined : '宿主 connection 缺少 admit()：Web 鉴权降级（退到 requestRejection / 本地回环判定）',
    // 静态检查的门槛：`dsh-client-connection` **不是**本插件的 peer（宿主不要求插件直接依赖
    // 它），doctor 从插件锚点解析不到它。那时不能报 `missing` —— 那等于断言"宿主没有这个
    // 能力"，而运行时探针看到的是 Web 组合里真实的 connection 服务（0.2.1 起一定带 admit）。
    // 门槛取宿主侧：至少一个宿主锚点解析得到才查；解析不到退回 `runtime-only`（如实标注
    // "只能对活的宿主查"），而不是编一个"缺失"。
    staticWhen: () => resolvableFromHost('@deepseek-ai/dsh-client-connection'),
  },
  // ---- 不在 inject 清单里的宿主服务：缺席不阻止插件挂载，但会静默少一块功能 ----
  // 这几条与上面那些契约面的区别：它们不是「宿主某个对象上的成员」，而是**整个服务**
  // 换名 / 消失。插件在运行时用 `ctx.get(name)` 软取，取不到就各自降级 —— 没有全局信号，
  // 所以逐条列出来，升级后第一眼能看见是哪一块没了。
  {
    id: 'subagents.runtime',
    label: '子智能体运行时（startActivation）',
    kind: 'write',
    owner: 'subagents',
    fallback: 'refuse-operation',
    methods: ['startActivation', 'getProvider'],
    // getProvider(name) 是只读的 provider 查询：能证明运行时在，也能核对「按名字查、查不到给
    // undefined」这个返回形状。startActivation 不能真调（会启动一个子代理），只核对它是异步方法。
    // 不用 list()：它只在一代宿主上有名册枚举，缺席时只是查不了名字，不是运行时不可用。
    probe: (t) => {
      const getProvider = (t as { getProvider?: (name: string) => unknown }).getProvider
      if (typeof getProvider !== 'function') return '宿主子智能体运行时缺少 getProvider()'
      let found: unknown
      try { found = getProvider.call(t, '__dsh_plugin_probe_missing__') } catch (error) { return `subagents.getProvider() 抛错：${String((error as Error)?.message ?? error)}` }
      if (found !== undefined) return 'subagents.getProvider() 对不存在的 provider 返回了值：名册语义变了'
      return isAsyncFn((t as { startActivation?: unknown }).startActivation)
        ? undefined
        : 'startActivation 不是异步方法：派活调用会同步失败或返回非 Promise'
    },
    describe: (t) => {
      try {
        const getProvider = (t as { getProvider?: (name: string) => unknown }).getProvider
        const names = ['spawn', 'fork'].filter((name) => getProvider?.call(t, name) !== undefined)
        return names.length > 0 ? `已注册 provider：${names.join('、')}` : undefined
      } catch { return undefined }
    },
  },
  {
    id: 'llm.model-catalog',
    label: '模型目录（场景模型候选）',
    kind: 'read',
    owner: 'llm',
    fallback: 'inform-only',
    methods: ['listProviders', 'listModels', 'resolveModelInfo'],
    // listProviders() 是同步且只读的：能直接核对 LlmProviderInfo[] 的 id / name 形状。
    // listModels / resolveModelInfo 是异步（可能联网）的，只核对异步方法签名，不发起调用。
    probe: (t) => {
      const listProviders = (t as { listProviders?: () => unknown }).listProviders
      if (typeof listProviders !== 'function') return '宿主 llm 服务缺少 listProviders()'
      let providers: unknown
      try { providers = listProviders.call(t) } catch (error) { return `listProviders() 抛错：${String((error as Error)?.message ?? error)}` }
      if (!Array.isArray(providers)) return 'listProviders() 未返回数组：模型来源枚举失效'
      const invalid = providers.find((item) => item === null || typeof item !== 'object'
        || typeof (item as { id?: unknown }).id !== 'string'
        || typeof (item as { name?: unknown }).name !== 'string')
      if (invalid !== undefined) return 'listProviders() 的元素缺少字符串 id / name：模型来源形状变了'
      if (!isAsyncFn((t as { listModels?: unknown }).listModels)) return 'listModels 不是异步方法：来源下的模型枚举会失效'
      if (!isAsyncFn((t as { resolveModelInfo?: unknown }).resolveModelInfo)) return 'resolveModelInfo 不是异步方法：思考档位清单会失效'
      return undefined
    },
    describe: (t) => isFn((t as Record<string, unknown>).listModels) ? '支持 listModels（可枚举模型）' : '无 listModels（只列来源，模型需手填）',
  },
  {
    id: 'llm.prepare-call',
    label: '后台复习的模型调用（prepareCall / stream）',
    kind: 'read',
    owner: 'llm',
    fallback: 'inform-only',
    methods: ['prepareCall'],
    // 自主记忆的后台复习走这条路：`prepareCall(config)` 拿到 `{config, stream}`，再派发一次。
    // 两个形状缺一个，复习每次都失败（日志里只有一句 review-failed），而热路径的
    // `memory_note` 不受影响 —— 症状是「开了自主记忆但从来不学」，界面看起来一切正常。
    //
    // 官方实现是 **async**（`dsh-llm` 的 provider 门面）：返回的是 Promise，同步探测看不到
    // 里面的 config / stream。那种情况只核对签名，不判形状 —— 把 Promise 当"缺 config"报，
    // 会让一台完全正常的宿主永远亮一条红。也不真 await：探测是同步的，且可能联网。
    probe: (t) => {
      const prepareCall = (t as { prepareCall?: unknown }).prepareCall
      if (typeof prepareCall !== 'function') return '宿主 llm 服务缺少 prepareCall()：后台复习无法发起模型调用'
      if (prepareCall.length === 0) return 'prepareCall() 不再接收配置参数：复习无法指定模型与输出上限'
      let prepared: unknown
      try {
        prepared = (prepareCall as (...args: unknown[]) => unknown).call(t, { provider: '', model: '', temperature: 0, maxTokens: 1 })
      } catch (error) {
        // 抛错本身**不是**契约漂移的证据：这里传的是空 provider / model，被参数校验拒掉
        // 是预期行为。早先把 `TypeError` 当成形状不符上报 —— 而空参数恰好最常触发
        // `TypeError`（读 `undefined.foo`），于是每次「重新检测」都会凭空多一条降级。
        //
        // 真正的判据是**返回值形状**，而它在抛错路径上根本拿不到。所以这里一律放过：
        // 宁可漏报一次（宿主真变了的话，复习跑起来会自己报错），也不要把正常宿主标红。
        return undefined
      }
      if (prepared !== null && typeof prepared === 'object' && typeof (prepared as { then?: unknown }).then === 'function') {
        // 异步实现：同步看不到返回值形状，顺手吞掉可能的 rejection，别让它变成未处理的拒绝。
        const settled = prepared as { catch?: (onRejected: () => void) => unknown }
        if (typeof settled.catch === 'function') settled.catch(() => undefined)
        return undefined
      }
      if (prepared === null || typeof prepared !== 'object') return 'prepareCall() 没有返回对象：复习拿不到 config / stream'
      const shape = prepared as { config?: unknown; stream?: unknown }
      if (shape.config === null || typeof shape.config !== 'object') return 'prepareCall() 的返回值缺少 config：派发时无法回传同一份配置'
      if (typeof shape.stream !== 'function') return 'prepareCall() 的返回值缺少 stream()：复习无法派发'
      return undefined
    },
    describe: () => '支持 prepareCall（后台复习可用）',
  },
  {
    id: 'approval.effective-policy',
    label: '审批策略读取（完全权限判定）',
    kind: 'read',
    owner: 'approval',
    fallback: 'inform-only',
    methods: ['effectivePolicy'],
    // 私有实现细节：只核对接收一个 session 参数，返回值取决于会话（可能是 never / ask）；
    // 用哨兵真调会把「没有会话」误报成契约漂移，所以不调用。
    probe: (t) => (t as { effectivePolicy?: (...args: unknown[]) => unknown }).effectivePolicy?.length === 1
      ? undefined
      : 'effectivePolicy 的签名不再是单参数（session）：完全权限判定可能失真',
  },
  {
    id: 'tools.schema-list',
    label: '工具清单读取（schemas）',
    kind: 'read',
    owner: 'tools',
    fallback: 'inform-only',
    methods: ['schemas'],
    // 工具名从 `schemas()` 的元素上读；元素形状一变，MCP 工具计数会恒为 0，
    // 可见性摘除的名单也会跟着变空 —— 两处都静默。只查方法存在不够。
    probe: (t) => {
      const schemas = (t as { schemas?: () => unknown }).schemas
      if (typeof schemas !== 'function') return '宿主工具服务缺少 schemas()'
      let list: unknown
      try { list = schemas.call(t) } catch (error) { return `schemas() 抛错：${String((error as Error)?.message ?? error)}` }
      if (!Array.isArray(list)) return 'schemas() 没有返回数组：工具计数与可见性名单无法生成'
      const invalid = list.find((item) => item === null || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string')
      return invalid === undefined ? undefined : 'schemas() 的元素缺少字符串 name：工具名读不出来'
    },
  },
  // ---- 其余宿主服务的公开面：缺了不会让插件挂不上，但对应功能会静默少一块 ----
  {
    id: 'skills.register-provider',
    label: '技能 provider 注册（registerProvider）',
    kind: 'write',
    owner: 'skills',
    fallback: 'inform-only',
    methods: ['registerProvider'],
    // 真注册一个 provider 会进入技能目录并触发失效事件，所以只核对签名：
    // 官方若改成两参 / 返回不可调用对象，下面的注册逻辑会静默失效。
    probe: (t) => {
      const register = (t as { registerProvider?: (...args: unknown[]) => unknown }).registerProvider
      if (typeof register !== 'function') return '宿主技能服务缺少 registerProvider()：技能启停与官方内置技能接管失效'
      return register.length === 1
        ? undefined
        : 'registerProvider 的签名不再是单参数（create）：provider 注册可能静默失效'
    },
  },
  {
    id: 'agents.list',
    label: '活动 agent 清单（agents.list）',
    kind: 'read',
    owner: 'agents',
    fallback: 'inform-only',
    methods: ['list'],
    // 只读调用：返回活动 agent 数组。非空时核对 id / ctx；空数组时只能证明返回形状是数组。
    probe: (t) => {
      let agents: unknown
      try { agents = (t as { list: () => unknown }).list() } catch (error) { return `agents.list() 抛错：${String((error as Error)?.message ?? error)}` }
      if (!Array.isArray(agents)) return 'agents.list() 未返回数组：agent 作用域 provider 无法补装'
      const invalid = agents.find((agent) => agent === null || typeof agent !== 'object'
        || typeof (agent as { id?: unknown }).id !== 'string'
        || (agent as { ctx?: unknown }).ctx === null || typeof (agent as { ctx?: unknown }).ctx !== 'object')
      return invalid === undefined ? undefined : 'agents.list() 的元素缺少字符串 id 或 ctx：agent 作用域 provider 无法补装'
    },
  },
  {
    id: 'pluginInventory.list',
    label: 'Loader 插件条目清单（pluginInventory.list）',
    kind: 'read',
    owner: 'pluginInventory',
    fallback: 'inform-only',
    methods: ['list'],
    // 异步读取实时 Loader 树；探测不发起调用（会等宿主加载），只核对异步签名。
    probe: (t) => {
      const list = (t as { list?: unknown }).list
      if (!isAsyncFn(list)) return 'pluginInventory.list 不是异步方法：loader 条目清单读不出来'
      return (list as (...args: unknown[]) => unknown).length === 0
        ? undefined
        : 'pluginInventory.list 的签名不再是零参数：条目清单可能读不出来'
    },
  },
  {
    id: 'webServer.register',
    label: 'HTTP 路由注册（webServer.register）',
    kind: 'write',
    owner: 'webServer',
    fallback: 'refuse-operation',
    methods: ['register'],
    // 真注册一条路由会占用宿主路由表；只核对单参数签名。
    probe: (t) => {
      const register = (t as { register?: (...args: unknown[]) => unknown }).register
      if (typeof register !== 'function') return '宿主 webServer 缺少 register()：插件面板 API 无法挂载（整页 404）'
      return register.length === 1
        ? undefined
        : 'webServer.register 的签名不再是单参数（route）：面板 API 路由可能挂不上'
    },
    describe: (t) => isFn((t as Record<string, unknown>).registerUpgrade) ? '支持 registerUpgrade' : undefined,
  },
  {
    id: 'sandboxPolicy.resolve',
    label: '沙箱策略解析（sandboxPolicy.resolve）',
    kind: 'read',
    owner: 'sandboxPolicy',
    fallback: 'refuse-operation',
    methods: ['resolve'],
    // 零副作用真调：read-only 请求不涉及会话与文件，返回的 mode / workspaceRoot 是纯计算。
    probe: (t) => {
      let policy: unknown
      try { policy = (t as { resolve: (request?: unknown) => unknown }).resolve({ mode: 'read-only' }) }
      catch (error) { return `sandboxPolicy.resolve({ mode: "read-only" }) 抛错：${String((error as Error)?.message ?? error)}` }
      if (policy === null || typeof policy !== 'object') return 'sandboxPolicy.resolve() 未返回对象：补丁写入的授权策略读不出来'
      const value = policy as { mode?: unknown; workspaceRoot?: unknown }
      if (typeof value.mode !== 'string') return 'sandboxPolicy.resolve() 的返回值缺少字符串 mode'
      if (typeof value.workspaceRoot !== 'string' || value.workspaceRoot === '') return 'sandboxPolicy.resolve() 的返回值缺少 workspaceRoot'
      return undefined
    },
    describe: (t) => {
      try {
        const policy = (t as { resolve: (request?: unknown) => { mode?: unknown } }).resolve({ mode: 'read-only' })
        return typeof policy?.mode === 'string' ? `观测 read-only → ${policy.mode}` : undefined
      } catch { return undefined }
    },
  },
  {
    id: 'tools.get-method',
    label: '按名读取工具定义（get）',
    kind: 'read',
    owner: 'tools',
    fallback: 'inform-only',
    methods: ['get'],
    // `get` 是「这台服务器的共享资源工具此刻注册着没有」与装层前过滤未知名的唯一判据；
    // 缺了它，逐会话资源工具摘除会整段跳过，别的对话的服务器资源重新可见。
    probe: (t) => isFn(t?.get) ? undefined : '宿主工具服务缺少 get()：共享资源工具的逐会话摘除与装层前过滤会静默跳过',
  },
  {
    id: 'tools.guard-dispatch',
    label: '工具执行守卫分发（guard / checkGuards）',
    kind: 'write',
    owner: 'tools',
    fallback: 'inform-only',
    methods: ['guard', 'checkGuards'],
    // 只查 `guard` 不够：宿主可能保留注册入口、却不再在 pipeline 里调 checkGuards。
    // 那种情况下注册成功、零报错，停用表与逐会话开关全部失效。
    probe: (t) => isFn(t?.guard) && isFn(t?.checkGuards)
      ? undefined
      : '宿主工具服务缺少 guard() / checkGuards()：停用工具与逐会话开关的执行侧拦截不会生效',
  },
  {
    id: 'tools.mcp-resource-args',
    label: 'MCP 共享资源工具参数（server / uri）',
    kind: 'read',
    owner: 'tools',
    fallback: 'inform-only',
    // 只查工具名不够：守卫读的是 `execution.arguments.server`，参数名一改就变成空串，
    // 按「算不出来不拦」静默放行 —— 别的对话的服务器资源可被本对话列出 / 读取。
    probe: (t) => {
      const get = (t as { get?: (name: string) => unknown }).get
      if (typeof get !== 'function') return '宿主工具服务缺少 get()：无法核对共享资源工具的参数名'
      const requiredByTool: Record<string, readonly string[]> = {
        list_mcp_resources: ['server'],
        list_mcp_resource_templates: ['server'],
        read_mcp_resource: ['server', 'uri'],
      }
      for (const [name, required] of Object.entries(requiredByTool)) {
        let definition: unknown
        try { definition = get.call(t, name) } catch { definition = undefined }
        // 没有 MCP 服务器时官方不注册这三个工具；一台都没有不是故障。
        if (definition === undefined) continue
        const parameters = (definition as { parameters?: { properties?: unknown; required?: unknown } }).parameters
        const properties = parameters?.properties
        const list = Array.isArray(parameters?.required) ? parameters.required : []
        const missing = required.filter((param) => properties === null || typeof properties !== 'object'
          || !(param in (properties as Record<string, unknown>))
          || !list.includes(param))
        if (missing.length > 0) {
          return `${name} 的参数 ${missing.join('、')} 不在 properties/required 里：逐会话守卫读不到服务器名，会静默放行`
        }
      }
      return undefined
    },
  },
  {
    id: 'systemPrompt.mcp-section',
    label: '系统提示词 MCP 段（MCP_SERVERS）',
    kind: 'read',
    owner: 'systemPrompt',
    fallback: 'inform-only',
    methods: ['section', 'getSectionOrder'],
    // `MCP_SERVERS` 改名后 getSectionOrder 返回 undefined，prompt-shadow 直接放弃注册，
    // 别的对话的服务器名与 instructions 会静默进入本对话。
    probe: (t) => {
      const orderOf = (t as { getSectionOrder?: (name: string) => unknown }).getSectionOrder
      if (typeof orderOf !== 'function') return '宿主 systemPrompt 缺少 getSectionOrder()'
      let order: unknown
      try { order = orderOf.call(t, 'MCP_SERVERS') } catch (error) { return `getSectionOrder("MCP_SERVERS") 抛错：${String((error as Error)?.message ?? error)}` }
      return Number.isFinite(order)
        ? undefined
        : 'getSectionOrder("MCP_SERVERS") 没有返回数字：MCP 提示词段排序位变了，跨会话 prompt 隔离无法挂载'
    },
  },
]
