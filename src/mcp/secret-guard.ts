// 打码值不得入库 —— env / headers 与 URL 查询串两条形态的唯一口径。
//
// 为什么需要它（2026-09-18，本机真实事故）：MCP 列表默认把 env / headers 里的凭据打码成
// `••••••`，而「编辑」弹窗的密钥框**预填的就是这个打码值** —— 界面拿到的行本身就是打码的
// （列表视图走 `mcpmRowsWithNotes(false)`）。于是"打开编辑 → 改个别的字段 → 保存"这条
// 最普通的操作，会把打码值当成真值写回补丁文件，**真密钥永久丢失、且无法找回**
// （本机 `TAVILY_API_KEY` 就是这样变成 `••••••` 的）。
//
// URL 是**第二种形态**，别把它漏掉（2026-09-19 审计 T-23）：`maskUrlQuery` 不产出 `••••••`，
// 而是把承载凭据的那几段换成 `<redacted>` 哨兵（经 URL 序列化后是 `%3Credacted%3E`）。
// 打码值判据只认整串 `•` 时它永远命中不了，于是 `mcpmEdit` 会把 `?<redacted>` 当成真 URL
// 写回补丁 —— 一次普通「编辑保存」即把 URL 里的凭据**永久**改成占位串。所以本模块同时
// 提供 `isMaskedUrl` / `resolveMaskedUrl`，与下面的 env / headers 判据并列。
//
// 「那几段」= **userinfo / 查询串 / 片段**三处（2026-09-30 审查 F5）：`new URL()` 把 userinfo
// 与 fragment 存在 `username/password` 与 `hash` 里，`toString()` 原样带出。只换 `search`
// 的话，`https://user:pass@host/mcp`（Basic-Auth 形态）与 `https://host/mcp#access_token=…`
// 会整条原样返回 —— 而这两条路正是免令牌出口（`mcpm-list` / `mcpm-inspect` / 模型工具 /
// 快照导出）。路径与主机**不动**：它们是该服务的身份，算进来会把真 URL 误判成打码值。
//
// 判据为什么可以这么硬：打码值只可能表示"用户没改这一项"，绝不可能表示"用户想把它设成这个"。
// 所以三道闸的方向都是「往旧值收」：
//   ① 有旧真值   → 用旧真值顶替（用户意图 = 不改这一项）；
//   ② 没有旧真值 → **丢弃该键**（宁可少一个键，也不写一个假值进补丁）；
//   ③ 旧值本身已是打码值 → 额外报 `alreadyBroken`，界面据此提示"原值已丢失，请重新填写"。
//
// 为什么是"顶替 + warning"而不是"报错拒绝"：拒绝会让每一次编辑都失败（预填的本来就是打码值），
// 而用户的意图显然是改别的字段。顶替才是对意图的如实翻译；**报错只留给最后一道结构性兜底**
// （`buildInsertBlock` 出口的 `maskedKeysIn` 断言）—— 那里一旦命中就说明某个调用点漏过了本模块，
// 属于代码缺陷，必须吵。
//
// 与界面侧的关系：取消打码（点「显示密钥」+ 对的访问令牌）走 `mcpm-reveal`，那条路上
// 拿到的是**真值**，本模块不参与；本模块只处理"表单里出现打码值"这一种输入。

/** 打码占位符的字面值。宿主 `maskSecretValue()` 产出的就是它，两处必须同源。 */
export const MASK_PLACEHOLDER = '••••••'

/**
 * 一个值是不是打码占位符。
 *
 * 只认「去空白后全是 `•`」：`maskSecretValue` 是**整值替换**（不保留前缀），所以这条规则
 * 既不需要知道原值长度，也不会把真值误判进来 —— 真密钥恰好整串都是 `•` 的概率不存在。
 * 这正是"统一为整值替换"而不是"保留前 4 个字符"的理由：后者的判据得写成 `.+?\*{4}$`，
 * 真值以 `****` 结尾时就会误判成打码值，判错的方向是**丢掉真密钥**。
 */
export function isMaskedValue(value: unknown): boolean {
  const text = String(value == null ? '' : value).trim()
  return text.length > 0 && /^•+$/.test(text)
}

/** `map` 里值是打码占位符的键（原序）。空/非对象一律当"没有"。 */
export function maskedKeysIn(map: Record<string, string> | null | undefined): string[] {
  if (!map || typeof map !== 'object') return []
  return Object.keys(map).filter((key) => isMaskedValue(map[key]))
}

/**
 * 单个值的打码形态（env / headers 那一类键值对）。
 *
 * 为什么提到本模块（2026-09-30，审查 P0-4）：这个函数原先私有在 `mcp/manager.ts`，而整机迁移
 * 的导出侧（`ops/snapshot.ts`）自己另写了一份「所有键一律打成 `••••••`」的版本 —— 同一件事
 * 两套口径，于是 `$VAR` / `!!js` 这类**间接引用**在两条出口上的命运不同。本模块是两条打码
 * 形态（占位符 / URL）的唯一口径，键值对这条也归这里。
 *
 * `$VAR` 与 `!!js` 是**间接引用**而不是密钥，原样保留：把它们打成 `••••••` 再导回来，目标机
 * 既顶替不出真值（它没有这一项）、也没有原值可回退，`resolveMaskedKv` 只能把这个键丢掉 ——
 * 一次普通迁移就毁掉了配置里的间接引用。
 */
export function maskSecretValue(value: unknown): string {
  const text = String(value == null ? '' : value)
  if (text === '') return ''
  if (text.startsWith('$')) return text
  if (/^!!js\s/.test(text)) return text
  return MASK_PLACEHOLDER
}

/** `maskUrlQuery` 写进 URL 各段的哨兵（userinfo / 查询串 / 片段共用同一个字面值）。 */
const URL_REDACTED_QUERY = '<redacted>'

/**
 * 一段（userinfo / 查询串 / 片段）是不是哨兵。
 *
 * `<` `>` 会被 URL 序列化百分号编码（`%3Credacted%3E`），所以比较前先解码 ——
 * 手写补丁里直接写 `<redacted>` 也要认出来。`decodeURIComponent` 对残缺的 `%` 会抛，
 * 那种输入不是哨兵。
 */
function isRedactedPart(part: string): boolean {
  if (part === URL_REDACTED_QUERY) return true
  try {
    return decodeURIComponent(part) === URL_REDACTED_QUERY
  } catch {
    return false
  }
}

/**
 * 一个 URL 的**任一凭据段**是不是被 `maskUrlQuery` 打过码。
 *
 * 判据只覆盖 userinfo / 查询串 / 片段这三处：路径与主机是该服务的身份，打码不会碰它们，
 * 把它们算进来会把真 URL 误判成打码值（判错的方向是丢掉真配置）。
 *
 * 为什么三处各自独立判、命中一处即算（2026-09-30 审查 F5）：`resolveMaskedUrl` 的语义是
 * "这条 URL 是打码形态 ⇒ 不能写回盘"。只判查询串的话，`https://user:pass@host/mcp`
 * （userinfo 承载 Basic 凭据，MCP 托管服务真实存在的形态）与 `...#access_token=…`
 * 都会被判成真值原样落盘 —— 一次普通「编辑保存」即把凭据永久换成占位串。
 */
export function isMaskedUrl(value: unknown): boolean {
  const text = String(value == null ? '' : value).trim()
  if (!text) return false
  try {
    const parsed = new URL(text)
    if (isRedactedPart(parsed.username) || isRedactedPart(parsed.password)) return true
    if (parsed.search && isRedactedPart(parsed.search.replace(/^\?/, ''))) return true
    if (parsed.hash && isRedactedPart(parsed.hash.replace(/^#/, ''))) return true
    return false
  } catch {
    // 非绝对 URL（`new URL` 抛错）走字符串判据，与下面 `maskUrlQuery` 的兜底分支配对 ——
    // 少了这一半，兜底打码出来的相对 URL 在回写时认不出是打码值，会被当成用户新填的地址写回补丁。
    const userinfo = /^(?:[a-zA-Z][\w+.-]*:)?\/\/([^/?#]*)@/.exec(text)
    if (userinfo && isRedactedPart(userinfo[1])) return true
    const at = text.indexOf('?')
    if (at >= 0) {
      const hashAt = text.indexOf('#', at)
      if (isRedactedPart(text.slice(at + 1, hashAt < 0 ? undefined : hashAt))) return true
    }
    const hashAt = text.indexOf('#')
    if (hashAt >= 0 && isRedactedPart(text.slice(hashAt + 1))) return true
    return false
  }
}

/**
 * 字符串级兜底打码（`new URL` 认不下的相对地址 / 协议相对地址）：
 * 按 `[scheme:][//userinfo@host]/path[?query][#fragment]` 的形状，把 userinfo / 查询串 /
 * 片段三处各换成哨兵，路径与主机原样保留（它们是该服务的身份）。
 */
function maskUrlPartsByString(url: string): string {
  // ① userinfo：`scheme://` 或 `//` 之后、第一个 `/ ? #` 之前若有 `@`，把 `@` 之前那段换掉。
  //    正则里的 `[^/?#]*` 越不过路径分隔符，所以路径里的 `@`（`/user@example.com`）不会误伤。
  let out = url.replace(/^((?:[a-zA-Z][\w+.-]*:)?\/\/)([^/?#]*@)/, `$1${URL_REDACTED_QUERY}@`)
  // ② 查询串：第一个 `?` 到 `#` 之前整段换哨兵。
  const at = out.indexOf('?')
  if (at >= 0) {
    const hashAt = out.indexOf('#', at)
    out = out.slice(0, at + 1) + URL_REDACTED_QUERY + (hashAt < 0 ? '' : out.slice(hashAt))
  }
  // ③ 片段：第一个 `#` 之后整段换哨兵。
  const hashAt = out.indexOf('#')
  if (hashAt >= 0) out = out.slice(0, hashAt + 1) + URL_REDACTED_QUERY
  return out
}

/**
 * 把 URL 里承载凭据的三段（userinfo / 查询串 / 片段）换成 `<redacted>` 哨兵
 * —— 打码的**产出**侧，与上面的 `isMaskedUrl` 配对。
 *
 * 放在这里而不是 manager.ts 里：本模块是这两条打码形态的唯一口径，而使用方已经有三个
 * ——MCP 列表视图（`mcpmRowsWithNotes`）、模型调 `mcp_manager_save` 时的确认卡
 * （卡里要回显"新 URL"，但用户批准的是「跑这个地址」，查询串里的凭据不该明文进卡片）、
 * 以及整机迁移的导出（`ops/snapshot.ts`，那份目录是要拷去 U 盘 / 另一台机器的）。
 * 各处各写一份的话，改了一处就会漂成几种打码形态，而 `isMaskedUrl` 只认其中一种。
 *
 * 为什么是**三段**而不是只有查询串（2026-09-30 审查 F5）：`new URL()` 把 userinfo 与
 * fragment 存在 `username/password` 与 `hash` 里，`toString()` 会原样带出 ——
 * 只替换 `search` 的话，`https://user:pass@host/mcp` 与 `https://host/mcp#access_token=…`
 * 会**整条原样返回**（后者连 `?` 都没有），而这两条路正是免令牌出口
 * （`mcpm-list` / `mcpm-inspect` / 模型工具 / 快照导出）。Basic-Auth 形态的凭据就此明文可见。
 */
export function maskUrlQuery(url: string | null): string | null {
  if (!url) return url
  try {
    const parsed = new URL(url)
    if (parsed.search) parsed.search = '?' + URL_REDACTED_QUERY
    // userinfo 与片段分别置哨兵。`password = ''` 是为了不留下 `user:<redacted>@` 这种半截形态
    // —— 有 userinfo 时两段一起换，读回去就是一个整体。
    if (parsed.username || parsed.password) {
      parsed.username = URL_REDACTED_QUERY
      parsed.password = ''
    }
    if (parsed.hash) parsed.hash = '#' + URL_REDACTED_QUERY
    return parsed.toString()
  } catch {
    // 不是绝对 URL（`new URL` 抛错）—— 原来这里是 `return url`，即**完全不打码**。
    // 但凭据照样可以挂在这种地址上（`/api?token=…`、`//host/mcp?api_key=…`），而这条函数的
    // 调用方里有「要拷去另一台机器」的导出侧：原样返回等于承诺打码却留明文。
    return maskUrlPartsByString(url)
  }
}

export interface MaskedUrlOutcome {
  /** 可以直接写盘的 URL。 */
  value: string
  /** 用旧真值顶替回来了（用户没改这一项）。 */
  restored: boolean
  /** 打码且没有旧真值可顶替 —— URL 查询串可能是服务身份的一部分，不能静默丢，交调用方报错。 */
  unrecoverable: boolean
}

/**
 * 把表单来的 URL 收敛成"可以安全写盘"的一个（与 `resolveMaskedKv` 同方向：往旧值收）。
 *
 * 为什么"没有旧值"时不学 env / headers 那样丢弃键：URL 不是可选的键值对 —— 丢掉查询串
 * 等于写下一个**能连上但鉴权失败**的地址，界面与用户都会以为配置还完好。宁可整次保存失败
 * 并让用户重填，也不留一个假的可写值。
 *
 * @param incoming - 表单里的 URL。
 * @param current - 该条目**在补丁文件里的旧 URL**；新增条目传 `null`。
 */
export function resolveMaskedUrl(incoming: string | null | undefined, current: string | null | undefined): MaskedUrlOutcome {
  const value = String(incoming == null ? '' : incoming).trim()
  if (!isMaskedUrl(value)) return { value, restored: false, unrecoverable: false }
  const previous = String(current == null ? '' : current).trim()
  if (previous && !isMaskedUrl(previous)) return { value: previous, restored: true, unrecoverable: false }
  return { value, restored: false, unrecoverable: true }
}

/** 键值对输入（表单解析结果 / 补丁里的旧值），两者都可缺。 */
export type KvMap = Record<string, string> | null | undefined

export interface MaskedKvOutcome {
  /** 可以直接写盘的映射：打码值已被顶替或剔除。 */
  value: Record<string, string>
  /** 用旧真值顶替回来的键（用户没改，值保住了）。 */
  restored: string[]
  /** 打码且没有旧真值可顶替 → 被丢弃的键。 */
  dropped: string[]
  /** `dropped` 里那些"旧值本身就是打码值"的键 —— 原值已经找不回来，必须让用户知道。 */
  alreadyBroken: string[]
}

/**
 * 把表单来的键值对收敛成"可以安全写盘"的一份。
 *
 * @param incoming - 表单解析出来的映射（可能整体为空）。
 * @param current - 该条目**在补丁文件里的旧值**；新增条目传 `null`。
 * @returns 收敛后的映射 + 三类命中键，供调用方回一条 warning。
 */
export function resolveMaskedKv(incoming: KvMap, current: KvMap): MaskedKvOutcome {
  const out: Record<string, string> = {}
  const restored: string[] = []
  const dropped: string[] = []
  const alreadyBroken: string[] = []
  const incomingMap = incoming && typeof incoming === 'object' ? incoming : {}
  const currentMap = current && typeof current === 'object' ? current : {}
  for (const key of Object.keys(incomingMap)) {
    const value = String(incomingMap[key])
    if (!isMaskedValue(value)) { out[key] = value; continue }
    const previous = currentMap[key]
    // 旧值存在且不是打码值 ⇒ 只有一种可能：表单里的是打码值，用户的意图是「不改」。
    if (previous != null && previous !== '' && !isMaskedValue(previous)) {
      out[key] = String(previous)
      restored.push(key)
      continue
    }
    dropped.push(key)
    if (previous != null && isMaskedValue(previous)) alreadyBroken.push(key)
  }
  return { value: out, restored, dropped, alreadyBroken }
}

/**
 * 把命中情况拼成一句给用户看的中文说明；没命中返回 `''`。
 *
 * 措辞刻意区分三件事：`alreadyBroken` 是**已经发生的损失**（要重填），`restored` 是
 * **本次没造成损失**（值保持原样），`dropped` 是**本次丢弃了输入**（表单里凭空出现的打码值）。
 * 三者混成一句的话，用户无法判断自己要不要动手。
 */
export function describeMaskedOutcome(outcome: MaskedKvOutcome): string {
  const parts: string[] = []
  if (outcome.alreadyBroken.length) {
    parts.push('这些密钥在补丁文件里已经是打码占位符，真实值已丢失，请重新填写：' + outcome.alreadyBroken.join('、'))
  }
  if (outcome.restored.length) {
    parts.push('这些密钥未改动，已保留原值：' + outcome.restored.join('、'))
  }
  if (outcome.dropped.length > outcome.alreadyBroken.length) {
    const plain = outcome.dropped.filter((key) => !outcome.alreadyBroken.includes(key))
    if (plain.length) parts.push('这些键的值是打码占位符且没有原值可保留，已跳过：' + plain.join('、'))
  }
  return parts.join('；')
}
