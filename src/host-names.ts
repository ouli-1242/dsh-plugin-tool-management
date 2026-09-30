/**
 * 宿主身份常量：插件在文件里认的这几个名字只在这里写一次。
 *
 * 以前 `@deepseek-ai/dsh-mcp-client` 在 `index.ts` 里有 6 份副本（2 份写给补丁的 YAML、
 * 2 份解析补丁时的比对、2 份运行时清单匹配），`preset-reach.ts` 里还有第 7 份 —— 官方改包名时
 * 少改一处就是「开关点了没反应」或「列表凭空少一行」。档案目录名同理。
 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/**
 * MCP 工具在模型工具表里的**命名前缀**：`mcp__<serverName>__<toolName>`。
 *
 * 这是宿主侧（MCP client 注册工具时）定的字符串契约，插件里十余处按它拼、按它解析
 * （生成侧 `disabledToolNames`、执行侧 `isToolDisabledIn`、列表侧 `liveNames`、工具计数）。
 * 抽到这里是为了"官方改了前缀"只需改一处 —— 但**改一处不够**：前缀一漂，停用表 / 门禁 /
 * 工具计数会一起**静默**失明（守卫以为"这工具不在我的表里"于是放行）。
 *
 * 前向兼容的诚实边界（2026-09-30 审查 §5 F6）：这个契约**没有能力探测可做** ——
 * `tools.schemas()` 只回 `name`/`description`（官方源码明确它「NEVER sent to the model」
 * 的其余字段不暴露），拿不到"这条工具属于哪个模块"，所以无法独立判定一条 schema 是不是
 * MCP 工具。唯一的可用线索是"工具名以 `mcp` 开头但不是本前缀"（官方改前缀多半会保留
 * `mcp` 词根），据此在 `mcpmListView` 里做一次 inform-only 上报；换成完全不同的词根就
 * 只能靠宿主升级清单人工核对。真要靠探测兜住，得先有官方暴露工具归属的接口。
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 一个工具名算不算「MCP 前缀漂移」的**证据**：以 `mcp` 开头，但词根后面**不是** `_`。
 *
 * 为什么要这么窄（2026-09-30 审查 §5 F6 实现时的自查）：本插件自己的工具就叫
 * `mcp_manager_list` / `mcp_manager_…` —— 它们同样「以 mcp 开头但不是 `mcp__`」，把它们
 * 算成证据会让这条上报在**每台机器上**误报（只要当前没有 MCP 服务器在跑）。而真正的前缀
 * 漂移（`mcp:` / `mcp-` / `mcpX`）恰恰表现为「词根后面的分隔符变了」这一种形态。
 * `mcp___` 这类改法会落进「没有证据」—— 宁可不报，也不给用户一个错的诊断。
 */
export function looksLikeMcpPrefixDrift(name: string): boolean {
  return /^mcp[^_]/.test(String(name == null ? '' : name))
}

/** `splitMcpToolName` 的结果。 */
export interface McpToolNameParts {
  /** 界面与场景档案里的键：`<server>/<tool>`。 */
  key: string
  server: string
  tool: string
  /**
   * 切法**是否有据可依**：命中了候选集合里的某一个 serverName。
   *
   * `false` = 一个候选都没命中，按最后一个 `__` 兜底猜的。调用方据此决定要不要出声（N2）——
   * 猜出来的 `(server, tool)` 可能把「server 含 `__`」的名字切错。
   */
  certain: boolean
}

/**
 * MCP 工具全名 `mcp__<server>__<tool>` 的**唯一切分口径**。
 *
 * 为什么必须只有一个：同一个全名在插件里有两处要还原成 `(server, tool)` —— 执行侧守卫
 * （`mcp/manager.ts` 的 `isToolDisabledIn`，决定「这个工具还能不能调」）与显示侧
 * （`index.ts` 的 `toolKeyParts`，决定界面上的勾选键 `server/tool`）。它们此前**各写一套规则**：
 * 守卫取「最长已知 serverName 前缀」，显示侧取「最后一个 `__`」。规则不同 = 同一份数据两边
 * 结论不同；而 `serverName` 的校验（`/^[A-Za-z0-9_-]{1,32}$/`）**允许含 `__`**，所以这个歧义
 * 真的能踩到（2026-09-30 审查 N1）。现在两处都走本函数。
 *
 * **残余歧义（如实标注）**：`mcp__a__b__t` 既可能是「server=a, tool=b__t」也可能是
 * 「server=a__b, tool=t」—— 光看全名无法判定，必须有候选 serverName 集合才谈得上「切对」。
 * 所以集合是**必填参数**，且两个调用点的集合**天然不同**，这不是漏改：
 *
 *   * 守卫问的是「这个工具被停用了吗」，权威依据就是**停用表**，集合 = 停用表的键。
 *     把集合放宽到「全部已配置服务器」会**漏拦**：设 `a` 的 `b__c` 被停用、而 `a__b` 只是
 *     配置了、没停用任何工具，全名 `mcp__a__b__c` 放宽后最长匹配取 `a__b`（tool 只剩 `c`）
 *     → 查 `a__b` 未命中 → 放行一个真的被停用的工具（fail-open）。歧义时「偏向停用表里有的
 *     那个服务器」才是守卫该有的 fail-closed 方向。
 *   * 显示侧问的是「这个键该显示成哪个服务器下的哪个工具」，依据是**全部已知的真实服务器名**
 *     ——补丁文件里的 `serverName`（权威、与切分结果无关）+ 停用表键 + 已知工具缓存键，
 *     集合 = 三者并集（见 `serverNameCandidates`）。补丁那份必须在内：另外两份都是插件自己
 *     写出来的（勾选键 / 上次切分的产物），单靠它们会在「首次遇到含 `__` 的名字」时切错，
 *     而错键一旦进集合就会**锁死**错误结论（不自愈）。
 *
 * 两者在「服务器名含 `__`」时仍可能给出不同答案 —— 这是 `__` 当分隔符的固有歧义，靠集合
 * 无法根除；根除要从入口拒绝含 `__` 的 serverName（契约层收紧，本轮明确不做）。`certain`
 * 就是给这件事留的出口。
 *
 * 候选里取**最长**的那个（短候选会把 tool 截断成 `b__c`）—— 真实服务器名比「按分隔符猜」可信，
 * 这也是 0.16.7 那版守卫选「最长已知前缀」的同一个理由。
 * @param fullName - 形如 `mcp__<server>__<tool>` 的工具全名。
 * @param serverNames - 候选 serverName 集合（见上；传空集合等于只走兜底）。
 * @returns 切分结果；不是 MCP 工具名、或切不出非空 server/tool 时返回 null。
 */
export function splitMcpToolName(
  fullName: unknown,
  serverNames: Iterable<string> | null | undefined,
): McpToolNameParts | null {
  const name = String(fullName == null ? '' : fullName)
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  let matched: string | null = null
  if (serverNames) {
    for (const candidate of serverNames) {
      if (typeof candidate !== 'string' || candidate === '') continue
      // tool 必须非空，否则 `mcp__a__` 会被切出空 tool
      if (rest.length <= candidate.length + 2) continue
      if (!rest.startsWith(candidate + '__')) continue
      if (matched === null || candidate.length > matched.length) matched = candidate
    }
  }
  if (matched !== null)
    return { key: matched + '/' + rest.slice(matched.length + 2), server: matched, tool: rest.slice(matched.length + 2), certain: true }
  // 一个候选都没命中 → 按最后一个 `__` 兜底（显示侧原先的口径），并如实标注「不确定」。
  // 守卫侧不需要特别处理：猜出来的 server 不在停用表里，查表结果与「没有候选命中」一致。
  const i = rest.lastIndexOf('__')
  if (i <= 0) return null
  const server = rest.slice(0, i)
  const tool = rest.slice(i + 2)
  return server && tool ? { key: server + '/' + tool, server, tool, certain: false } : null
}

/**
 * 显示侧切分的候选 serverName 集合：若干张「serverName → 任意」的表取键并集，
 * 或直接给一份名字清单（`Iterable<string>`）。
 *
 * 为什么要这个函数：显示侧有多个调用点（`mcpmList` / `serverKnownTools` / 场景档案的
 * `toolStates`），各自手写一遍 `Object.keys(...)` 迟早又会分叉 —— 而「集合不同」正是切分
 * 结论不同的原因之一。集合的来源必须是**同一批**：补丁文件里的真实 serverName（唯一与切分
 * 结果无关的来源）+ 停用表 + 已知工具缓存。前两者是插件自己写出来的，单靠它们会**循环论证**
 * （见 `configuredServerNames` 的文档）。
 */
export function serverNameCandidates(
  ...sources: Array<Record<string, unknown> | Iterable<string> | null | undefined>
): Set<string> {
  const out = new Set<string>()
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    // 名字清单（数组 / Set）优先按可迭代处理；`Record` 不可迭代，走下面的键枚举。
    if (typeof (source as Iterable<string>)[Symbol.iterator] === 'function') {
      for (const name of source as Iterable<string>) if (typeof name === 'string' && name) out.add(name)
      continue
    }
    for (const name of Object.keys(source as Record<string, unknown>)) if (name) out.add(name)
  }
  return out
}

/** `ambiguousServerNames` 的结果。 */
export interface AmbiguousServerNames {
  /** 名字**自己**含 `__` 的那些（`mcp__a__b__c` 里的 `a__b` 就是这种）。 */
  withSeparator: string[]
  /** 互为 `__` 前缀关系的对（`a` 与 `a__b`）：全名 `mcp__a__b__c` 两种归属都讲得通。 */
  prefixPairs: Array<[string, string]>
}

/**
 * 候选 serverName 里有没有「`__` 说不清」的形状 —— N2 的判据（2026-09-30 审查）。
 *
 * 为什么要有它：`splitMcpToolName` 能在一批名字里选出**最长**的那个，但"选对"这件事本身
 * 无法自证 —— 名字一旦含 `__`，「server 是 `a`、tool 是 `b__c`」与「server 是 `a__b`、tool 是
 * `c`」在全名上完全同形。宿主自己的解析口径（取第一个 `__`）与展示口径（取最后一个）也不一致，
 * 所以这不是"谁写错了"，是分隔符选得不合适。既不能改（改 serverName 校验会把存量服务器从
 * "能管"变成"管不了"，见计划 §4 未决 1），那就**出声**：这两种形状一出现就上报，让用户知道
 * 界面上的勾选可能落不到停用表里那条键上。
 *
 * **判据必须一条都不误报** —— 与 `looksLikeMcpPrefixDrift` 同一条纪律：没有这两种形状时
 * 必须返回空，否则这条上报会变成每台机器都亮的噪声，等于没有。
 * 名字不含 `__` 时，切分结果与"取第一个 `__`"、"取最后一个 `__`"三者一致，歧义不存在。
 */
export function ambiguousServerNames(names: Iterable<string>): AmbiguousServerNames {
  const all = [...new Set(names)].filter((n) => typeof n === 'string' && n !== '')
  const withSeparator = all.filter((n) => n.includes('__')).sort()
  const prefixPairs: Array<[string, string]> = []
  for (const short of all) {
    for (const long of all) {
      // `short` 是 `long` 的 `__` 前缀：`mcp__<short>__<long.slice(...)>` 与
      // `mcp__<long>__<剩下的>` 同形。`all` 已去重，所以每对只会出现一次。
      if (short !== long && long.startsWith(short + '__')) prefixPairs.push([short, long])
    }
  }
  prefixPairs.sort((a, b) => (a[0] + ' ' + a[1] < b[0] + ' ' + b[1] ? -1 : a[0] + ' ' + a[1] > b[0] + ' ' + b[1] ? 1 : 0))
  return { withSeparator, prefixPairs }
}

/** `ensurePaths()` 的档案探测顺序（先 web 后 headless）；都不在才退到「任意带 patch 的档案」。 */
export const PROFILE_CANDIDATES = ['web', 'headless'] as const

/** 探测不到任何档案时的兜底目录名（历史上的默认档案）。 */
export const DEFAULT_PROFILE_NAME = 'web'
