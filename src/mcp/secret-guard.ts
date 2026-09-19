// 打码值不得入库 —— env / headers 与 URL 查询串两条形态的唯一口径。
//
// 为什么需要它（2026-09-18，本机真实事故）：MCP 列表默认把 env / headers 里的凭据打码成
// `••••••`，而「编辑」弹窗的密钥框**预填的就是这个打码值** —— 界面拿到的行本身就是打码的
// （列表视图走 `mcpmRowsWithNotes(false)`）。于是"打开编辑 → 改个别的字段 → 保存"这条
// 最普通的操作，会把打码值当成真值写回补丁文件，**真密钥永久丢失、且无法找回**
// （本机 `TAVILY_API_KEY` 就是这样变成 `••••••` 的）。
//
// URL 是**第二种形态**，别把它漏掉（2026-09-19 审计 T-23）：`maskUrlQuery` 不产出 `••••••`，
// 而是把整个查询串换成 `<redacted>`（经 URL 序列化后是 `?<redacted>` 的百分号编码）。
// 打码值判据只认整串 `•` 时它永远命中不了，于是 `mcpmEdit` 会把 `?<redacted>` 当成真 URL
// 写回补丁 —— 一次普通「编辑保存」即把 URL 里的凭据**永久**改成占位串。所以本模块同时
// 提供 `isMaskedUrl` / `resolveMaskedUrl`，与下面的 env / headers 判据并列。
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

/** `maskUrlQuery` 写进查询串的哨兵（去掉 `?` 之后那一段）。 */
const URL_REDACTED_QUERY = '<redacted>'

/**
 * 一个 URL 的查询串是不是被 `maskUrlQuery` 打过码。
 *
 * 只判**查询串**：路径与主机是该服务的身份，打码不会碰它们，把它们算进来会把真 URL 误判成
 * 打码值（判错的方向是丢掉真配置）。经 `new URL()` 一过，`<` `>` 会被百分号编码，
 * 所以比较前先解码 —— 手写补丁里直接写了 `?<redacted>` 也能认出来。
 */
export function isMaskedUrl(value: unknown): boolean {
  const text = String(value == null ? '' : value).trim()
  if (!text) return false
  try {
    const parsed = new URL(text)
    if (!parsed.search) return false
    const query = parsed.search.replace(/^\?/, '')
    return query === URL_REDACTED_QUERY || decodeURIComponent(query) === URL_REDACTED_QUERY
  } catch {
    return false
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
