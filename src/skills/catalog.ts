// src/skills/catalog.ts —— 技能目录段（注入通道的数据源）。
//
// 为什么需要它：技能目录本来是官方 `@deepseek-ai/dsh-tool-skill` 的活 —— 它随预设挂载，
// 极简这类预设没挂，模型连"有哪些技能"都不知道（网页版把宿主那两条行交给预设后尤其如此）。
// 本模块提供同一份信息的**兜底通道**：只在预设没挂官方那一行时注入（判定在
// src/context-inject.ts 的 `CARRIER_FACT_OF`），格式与官方目录同形（`- \`name\`: description`）。
//
// 数据源用**插件自己的技能清单**（技能服务的 `skill-state`）：它已经含启停 / 被同名覆盖 /
// 同名首选的判定 —— 那正是用户在技能页管的那些开关；官方注册表里的同一份策略也由本插件的
// provider 喂进去，所以两边看到的是同一批技能。
//
// 与官方目录的两处有意差别：
//   - 只列**当前启用且可被模型调用**的（官方只过滤可调用性，不管用户在插件页关掉了谁）。
//   - 「本预设没有官方 `skill` 加载工具，要正文先用 `skill_manager_list` 取源文件路径」那句
//     本段只排版清单，标题与"怎么用"一处一个出处。
//
// 同步性：`text()` 必须同步返回（注入通道每个 step 同步取文本），而技能清单是异步读盘 →
// 与子智能体目录同构的 stale-while-revalidate：`text()` 返回缓存值并在超龄时后台重算，
// `refresh()` 供技能写操作后立即重算。

/** 描述截断长度（与官方目录的 `catalogDescriptionMaxLength` 默认值一致）。 */
export const SKILL_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/** 目录最多列几条；超出只报数量（让模型去调 `skill_manager_list`）。 */
export const SKILL_CATALOG_MAX_ENTRIES = 50

/** 技能清单里的一行（`skill-state` 的 `roots[].skills[]` 子集）。 */
export interface SkillCatalogRow {
  name?: string
  declaredName?: string
  description?: string
  enabled?: boolean
  modelInvocable?: boolean
  userInvocable?: boolean
  invocationPolicyValid?: boolean
  managerEnabled?: boolean
  shadowedBy?: { root?: string; name?: string } | null
}

/** 描述归一化 + 截断（与官方 `catalogDescription` 同款：折叠空白、超出补省略号）。 */
function catalogDescription(value: unknown, maxLength: number): string {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

/** 与 `skill_manager_list` / 界面（`isSkillEnabled`）同一套启停推导。 */
function isEnabled(row: SkillCatalogRow): boolean {
  if (row.enabled !== undefined) return row.enabled === true
  return row.invocationPolicyValid === true && row.modelInvocable === true && row.userInvocable === true && row.managerEnabled !== false
}

/**
 * 会话层对某一格的并值解析：`false` / `true` = 本会话这一层有话要说
 * `undefined` = 落到这一层之外的全局值。技能一格给 `<rootKey>/<name>`，来源一格给 root key。
 */
export interface SkillCatalogLayer {
  skill?: (key: string, rootKey: string) => boolean | undefined
  source?: (rootKey: string) => boolean | undefined
}

/**
 * 渲染技能目录段（纯函数，便于单独推理）。
 *
 * 返回 `''` 表示没有可注入的技能 —— 没装技能的用户零 token 成本。
 * 名字按字典序排序：底层目录枚举顺序变化时文本仍逐字节稳定（前缀缓存契约）。
 */
export function renderSkillCatalog(
  data: unknown,
  maxEntries: number = SKILL_CATALOG_MAX_ENTRIES,
  maxDescription: number = SKILL_CATALOG_DESCRIPTION_MAX_LENGTH,
  listToolVisible: boolean = true,
  /**
   * 本会话的两格解析（技能 / 来源）。`undefined` = 没有会话层，全按全局。
   *
   * 为什么在**渲染阶段**过滤而不是在 `state()` 里：技能清单（`skill-state`）是磁盘扫描的
   * 结果，一次扫描服务所有会话；按会话过滤只是"这一份清单里哪些该出现"，纯字符串运算。
   * 反过来把会话塞进 `state()` 就得为每个会话各扫一遍磁盘。
   */
  layer?: SkillCatalogLayer,
): string {
  const roots = (data && typeof data === 'object' ? (data as { roots?: unknown }).roots : undefined) ?? []
  const byName = new Map<string, { name: string; description: string }>()
  if (Array.isArray(roots)) {
    for (const root of roots) {
      const skills = (root && typeof root === 'object' ? (root as { skills?: unknown }).skills : undefined) ?? []
      if (!Array.isArray(skills)) continue
      const rootKey = String((root as { key?: unknown }).key ?? '')
      // 来源级停用是**上层闸**：里面的单条技能默认一条都加载不了。
      // 这一格有会话层（skillSources）：场景勾中的来源为开、没勾的为关；全局意图
      // off 的来源对**没认领的**会话也是关（租约只把它拉起来，不把它变成全局开着）。
      // 装配层给的 `source` 是有效可见性（含意图），undefined = 没有意图，落到运行态。
      const srcLayer = layer?.source !== undefined && rootKey !== '' ? layer.source(rootKey) : undefined
      const rootEnabled = typeof srcLayer === 'boolean' ? srcLayer : (root as { enabled?: unknown }).enabled !== false
      for (const raw of skills) {
        if (!raw || typeof raw !== 'object') continue
        const row = raw as SkillCatalogRow
        // 影子里那份不可加载（同名只有胜出者生效），启停开关也管不到它 —— 不进目录。
        if (row.shadowedBy) continue
        const declared = String(row.declaredName || row.name || '').trim()
        // 会话层：本会话这一格有话就以它为准（关掉的照样不进目录）。
        const key = declared !== '' && rootKey !== '' ? rootKey + '/' + declared : ''
        const over = layer?.skill !== undefined && key !== '' ? layer.skill(key, rootKey) : undefined
        // 来源闸**始终生效**：显式开一条技能时写侧会一并认领它的来源（见 ops/scope.ts 的
        // `upperOf`），所以这里不需要也不应该让技能级覆盖越过一个**明确关掉的**来源
        // —— 用户在本会话把来源关掉、界面已经把整组画成"关"，注入却还列着里面某条技能，
        // 就是显示与上下文各说各话。来源开着时，显式覆盖才决定这一条。
        const enabledNow = rootEnabled && (typeof over === 'boolean' ? over : isEnabled(row))
        if (!enabledNow || row.modelInvocable === false) continue
        const name = declared
        if (name === '') continue
        // 同名（跨根）只留一份：胜出者由 core 标出，这里按出现顺序先到先得，避免重复行。
        if (byName.has(name)) continue
        byName.set(name, { name, description: catalogDescription(row.description, maxDescription) })
      }
    }
  }
  if (byName.size === 0) return ''
  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const shown = sorted.slice(0, Math.max(0, maxEntries))
  const lines = shown.map((row) => (row.description ? '- `' + row.name + '`: ' + row.description : '- `' + row.name + '`'))
  // 只有清单：标题、工具名与"只给摘要、读完再用"的纪律由注入通道的框架承担
  // （见 context-inject.ts 的 DOMAIN_FRAME 的 `how` 行）—— 一处内容一个出处。
  const out = [...lines]
  const hidden = sorted.length - shown.length
  // 查询工具被关掉（兼容页的模型工具表）时只说"还有几个"：点名一个模型手里没有的工具，
  // 它只会去猜名字。数量照报 —— 那是实话，与有没有出口无关。
  if (hidden > 0) {
    out.push('', listToolVisible
      ? `(${hidden} more not listed — see them with \`skill_manager_list\`.)`
      : `(${hidden} more not listed.)`)
  }
  return out.join('\n')
}

/**
 * 本会话与**官方那份目录**的差异（纯函数）。`''` = 没有差异。
 *
 * 用途有两处：
 *   1. **接管判据**：非空时注入侧拦下官方 `skill-catalog`（只限本会话）
 *      由 `renderSkillCatalog` 送会话版整份。用户真机发现「先注入官方清单、再补一行
 *      not available here」等于让模型先看到错的再被告知不可用 —— 有差异就不能让官方那份
 *      继续到达模型。官方更早那条仍在历史里，由首份会话版的取代声明压过。
 *   2. **兜底差异行**：接管判据尚未接上时（旧装配 / 测试），仍按一行差异补。
 *
 * 措辞刻意**不提"全局 / 机器"这一层**：模型不知道有"全局设置"和"会话设置"两回事，它只需要
 * 知道"在这个对话里哪几条算数"。两边同名的条目不算差异，不进正文。
 */
export function renderSkillCatalogDelta(data: unknown, layer?: SkillCatalogLayer): string {
  if (layer === undefined) return ''
  const roots = (data && typeof data === 'object' ? (data as { roots?: unknown }).roots : undefined) ?? []
  if (!Array.isArray(roots)) return ''
  const off: string[] = []
  const on: string[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const skills = (root && typeof root === 'object' ? (root as { skills?: unknown }).skills : undefined) ?? []
    if (!Array.isArray(skills)) continue
    const rootKey = String((root as { key?: unknown }).key ?? '')
    const globalRoot = (root as { enabled?: unknown }).enabled !== false
    const srcLayer = rootKey !== '' && layer.source !== undefined ? layer.source(rootKey) : undefined
    const hereRoot = typeof srcLayer === 'boolean' ? srcLayer : globalRoot
    for (const raw of skills) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as SkillCatalogRow
      // 影子副本与不可调用的条目两边都不算：它们在全局目录里也不存在。
      if (row.shadowedBy || row.modelInvocable === false) continue
      const name = String(row.declaredName || row.name || '').trim()
      if (name === '' || seen.has(name)) continue
      const key = rootKey !== '' ? rootKey + '/' + name : ''
      const over = key !== '' && layer.skill !== undefined ? layer.skill(key, rootKey) : undefined
      const globalOn = globalRoot && isEnabled(row)
      // 与 `renderSkillCatalog` 同一条：来源闸始终生效，显式覆盖只决定来源开着时的这一条。
      const hereOn = hereRoot && (typeof over === 'boolean' ? over : isEnabled(row))
      if (globalOn === hereOn) continue
      seen.add(name)
      ;(hereOn ? on : off).push(name)
    }
  }
  if (off.length === 0 && on.length === 0) return ''
  const cap = 20
  const list = (names: string[]): string => {
    const head = names.slice(0, cap).map((n) => '`' + n + '`').join(', ')
    return names.length > cap ? head + ` (+${names.length - cap} more)` : head
  }
  const lines = ['For this conversation, these override any earlier skill list:']
  if (off.length > 0) lines.push('- not available here: ' + list(off.sort()))
  if (on.length > 0) lines.push('- available here: ' + list(on.sort()))
  return lines.join('\n')
}

/**
 * 本会话是否需要**整份接管**技能目录：差异行非空就是需要。
 *
 * 纯函数只为把"什么算有差异"钉在测试里：空串与纯空白都不算，其余一个字就算。
 * 判据只服务注入层（同步的 SWR 缓存），不进 `sessionMcpContextOf` 那套同步守卫路径。
 */
export function skillCatalogNeedsTakeover(delta: unknown): boolean {
  return String(delta ?? '').trim() !== ''
}

/** 技能目录的依赖：管理状态、来源扫描与首选表。 */
export interface SkillCatalogDeps {
  /**
   * 取技能清单（插件技能服务的 `skill-state` op）。
   *
   * `sessionId`：项目技能根按**这个会话的 cwd** 推导。省略 = 全局口径
   * （全部活动会话的 cwd 并集）。
   */
  state: (sessionId?: string) => Promise<any>
  /** 某个 agent 的会话 id；取不到 = 全局口径。 */
  sessionIdFor?: (agent?: unknown) => string | undefined
  /**
   * `skill_manager_list` **在这个 agent 手里**吗（截断提示里那句话的前提）。默认在。
   *
   * 为什么收 `agent` 而不是零参：只读全局开关时，某个人设用
   * `toolsDeny` 把这条工具砍掉之后，目录照注、尾句照样说「用 `skill_manager_list` 查」
   * —— 指向一条它手里没有的工具。判据与注入框架 `how` 行同一份（index.ts 的
   * `injectHiddenToolsFor`），不再定义第二份。
   */
  listToolVisible?: (agent?: unknown) => boolean
  /**
   * 本会话的两格解析：技能（`skills` 域）与来源（`skillSources` 域）。
   * 按 agent 取，不在目录里自己算 —— 判据只有一份（`scope-overrides.json` + 场景档案），
   * 目录只是消费者。`undefined` = 没有会话层，全按全局。
   */
  layerFor?: (agent?: unknown) => SkillCatalogLayer | undefined
  /**
   * 本会话的**层指纹**（覆盖 + 进入的场景档案）。渲染缓存键吃它 —— 少了它，A 会话拨过的
   * 开关不会让 B 会话的缓存失效（键里只有 sessionId 是不够的：同一个会话拨开关也要重算）。
   */
  layerKeyFor?: (agent?: unknown) => string
}

/** 技能目录的对外面：快照、单条详情与同名分组。 */
export interface SkillCatalog {
  /**
   * 同步返回段文本（可能比磁盘状态滞后一个 TTL）。
   *
   * `agent` 决定三件事：**本会话的 cwd**（项目技能根）、**本会话的覆盖**（列不列）、
   * 以及尾句点不点名那个查询工具。不传按全局口径。
   */
  text: (agent?: unknown) => string
  /**
   * 本会话相对官方口径的**差异行**：注入侧用它判断要不要整份接管
   * （`skillCatalogNeedsTakeover`）；接管判据未接上时才真的把这一行发出去。
   * `''` = 没有差异 / 没有会话层 / 这一会话的清单还没取到。
   */
  delta: (agent?: unknown) => string
  /**
   * 本会话的清单数据**是否已经在手里**。
   *
   * `false` 说的是"还没读到"，不是"没有技能" —— 两者在下游的含义完全相反：前者应当
   * 这一轮什么都不说（上一轮那份仍然有效），后者才是"这一域真的空了"。冷缓存
   * （首轮 / LRU 顶掉 / 写后重算还没回来）时 `text()` 只能返回 `''`，注入侧据此会
   * 误判成后者并发一条「已清空」—— 而模型会据此认为那份目录已经作废。
   */
  ready: (agent?: unknown) => boolean
  /** 立即重算（技能写操作后调用；重算所有会话的缓存，旧值留到新值回来为止）。 */
  refresh: () => Promise<void>
  /** 预热：插件加载时调一次，避免首个请求落到空值。 */
  warm: () => Promise<void>
  /**
   * 预热某个会话的清单。`agent/created` 时调一次：否则该会话的第一轮注入
   * 会因为"会话缓存还没加载"而少掉整段技能目录。
   */
  warmSession: (sessionId: string) => Promise<void>
}

/** 技能目录的选项：工作区路径与是否含被覆盖的副本。 */
export interface SkillCatalogOptions {
  maxEntries?: number
  maxDescription?: number
  /** 缓存新鲜度；与子智能体目录同量级。 */
  ttlMs?: number
  now?: () => number
}

/**
 * 创建 SWR 的技能目录。计算失败时保留上一次的值（不把段清空），首次失败维持 `''`。
 * 并发调用共享同一次计算（inflight 折叠）。
 *
 * ⚠️ 缓存**按会话分桶**：`skill-state` 带 sessionId 时项目技能根只取该会话的
 * cwd，两个会话能算出两份不同的清单。单槽缓存下 A 算完 B 直接用 —— 症状是「B 的对话里
 * 列出了 A 项目的技能」。键 = sessionId（全局口径用空串），上限 16 条 LRU。
 */
export function createSkillCatalog(deps: SkillCatalogDeps, opts: SkillCatalogOptions = {}): SkillCatalog {
  const ttlMs = opts.ttlMs ?? 30_000
  const now = opts.now ?? (() => Date.now())
  // 缓存的是**清单数据**而不是渲染结果：清单本体只依赖磁盘 + 会话 cwd，而尾句要不要点名
  // 那个查询工具 / 本会话关了哪几条取决于 agent。渲染是纯字符串操作，代价可忽略。
  const SESSION_CACHE_MAX = 16
  const dataByKey = new Map<string, { at: number; data: unknown }>()
  const inflight = new Map<string, Promise<void>>()
  /** 写操作后自增：旧的 inflight 回来时据此作废，不能拿旧磁盘状态盖掉新缓存。 */
  let generation = 0
  // 渲染结果的缓存键 = (会话 id, 尾句要不要点名查询工具, 本会话的覆盖指纹)。
  // 少任何一个都会让 A 的目录出现在 B 里（与人设目录的按深度缓存同一手法）。
  let rendered: { key: string; text: string } | null = null

  /** 某条缓存移到队尾（Map 保序 ⇒ 头部就是最久没用的那条）。 */
  const touch = (key: string): void => {
    const hit = dataByKey.get(key)
    if (hit === undefined) return
    dataByKey.delete(key)
    dataByKey.set(key, hit)
  }

  // `force`：写操作后调用的那次**不许并到在飞的那一次上**。并过去的话
  // 拿回的是刷新前的旧任务 —— 它带着旧的 generation，结果会被作废，于是缓存停在旧数据，
  // 而调用方以为已经重算完了（症状：刚拨开的技能这一轮仍不出现）。
  const revalidate = (key: string, force = false): Promise<void> => {
    const running = inflight.get(key)
    if (running !== undefined && !force) return running
    const gen = generation
    let p: Promise<void>
    p = (async () => {
      try {
        const result = await deps.state(key === '' ? undefined : key)
        if (gen !== generation) return
        if (result && result.ok !== false) {
          dataByKey.delete(key)
          dataByKey.set(key, { at: now(), data: result.data ?? result })
          while (dataByKey.size > SESSION_CACHE_MAX) {
            const oldest = dataByKey.keys().next()
            if (oldest.done === true) break
            dataByKey.delete(oldest.value)
          }
          rendered = null
        }
      } catch { /* 保留上一次的值；首次失败则维持空 */ }
    })().finally(() => {
      // 只有自己还是当前那一条时才删：refresh 会清空 inflight，不能让旧任务删掉新任务。
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  }

  return {
    text: (agent?: unknown) => {
      const key = deps.sessionIdFor ? (deps.sessionIdFor(agent) ?? '') : ''
      const hit = dataByKey.get(key)
      if (hit === undefined) {
        // 首次遇到这个会话：先起一次取数，这一轮没有目录（下一轮就有了）。
        // 不拿别的会话 / 全局并集那份顶替 —— 那正是"B 里列出 A 项目技能"的来源。
        void revalidate(key)
        return ''
      }
      if (now() - hit.at > ttlMs) void revalidate(key)
      touch(key)
      const visible = deps.listToolVisible ? deps.listToolVisible(agent) : true
      const layer = deps.layerFor ? deps.layerFor(agent) : undefined
      // 有会话层但装配层没给指纹（老装配 / 测试）时不走渲染缓存：宁可多算一次，
      // 也不拿 A 的目录糊弄 B。
      const layerKey = deps.layerKeyFor ? deps.layerKeyFor(agent) : ''
      const cacheable = layer === undefined || deps.layerKeyFor !== undefined
      const keyOfRender = key + '\u0000' + (visible ? '1' : '0') + '\u0000' + layerKey
      if (cacheable && rendered && rendered.key === keyOfRender) return rendered.text
      const out = renderSkillCatalog(hit.data, opts.maxEntries, opts.maxDescription, visible, layer)
      if (cacheable) rendered = { key: keyOfRender, text: out }
      return out
    },
    delta: (agent?: unknown) => {
      // 全局口径没有"本会话差异"这回事（差异就是相对全局算的）。
      const key = deps.sessionIdFor ? (deps.sessionIdFor(agent) ?? '') : ''
      if (key === '') return ''
      const layer = deps.layerFor ? deps.layerFor(agent) : undefined
      if (layer === undefined) return ''
      const hit = dataByKey.get(key)
      if (hit === undefined) {
        void revalidate(key)
        return ''
      }
      return renderSkillCatalogDelta(hit.data, layer)
    },
    ready: (agent?: unknown) => {
      const key = deps.sessionIdFor ? (deps.sessionIdFor(agent) ?? '') : ''
      return dataByKey.has(key)
    },
    refresh: () => {
      // 写操作改变的是磁盘事实，对每个会话都可能不同 → 全部重算，并把已知会话各拉一次。
      generation += 1
      const keys = [...new Set([...dataByKey.keys(), ''])]
      inflight.clear()
      // **不先清空 `dataByKey`**（用户实测修正）：清空之后、新数据回来之前的那一拍，
      // `text()` / `delta()` 一律读到空 → 注入侧按"这一域没内容"发一条「已清空」，于是
      // 「对话中途拨开一条技能」的那一轮，模型收到的是「Cleared — 不再有效」，下一轮才看到
      // 真正的清单。留着上一份：最坏是这一拍仍是上一份（`ready()` 仍为真，不会误报清空）。
      rendered = null
      return Promise.all(keys.map((key) => revalidate(key, true))).then(() => {})
    },
    warm: () => revalidate(''),
    warmSession: (sessionId: string) => revalidate(String(sessionId)),
  }
}
