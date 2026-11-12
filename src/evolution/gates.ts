// 写入的九道门（docs 03-flows §6）。任何一道拒绝就停；有一道降级就带着原因继续。
//
// 为什么是"门"而不是一段 if：每道门拒绝的理由不同，对应的补救也不同 ——
// 安全门拒绝是"永远别记这个"，配额门拒绝是"先整理"，证据门不过则是"降级等确认"。
// 混成一段 if 就只能回一句"记不下来"，用户既不知道该改什么，也不知道该不该改。
//
// 三条贯穿全文件的原则：
//
//   ① **模糊时降级，不二选一**。文本里同时出现"这次"和"永远不要"时，猜哪边都可能错；
//      降为 candidate（不注入、等更多证据）比猜对更重要 —— 猜错的代价是"记住了错的东西
//      并且每轮都在用"，而降级的代价只是"这一条现在还不起作用"。
//   ② **可推导的不记，但用户明说的例外**。新颖门只对 `model_inference` 生效：模型看到
//      `package.json` 就抄一条"这个项目用 pnpm"是懒惰；用户说"以后都用 pnpm"是偏好，
//      即使它恰好也能从 lockfile 读出来，那也说明用户在意。
//   ③ **安全门没有例外、不清洗**。`curl … | sh` 不会因为"用户确实这么说了"就变成无害；
//      清洗后保存更糟 —— 用户会以为系统记住的是他说的那句。

import { LAYER_GLOBAL, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, type MemoryLayer } from '../memories/constants.js'
import { truncateToWidth } from '../text-width.js'
import { checkQuote } from './evidence.js'
import { NOTE_RATE_DEFAULTS } from './limits.js'
import { DEGRADE_NOTE, routeLayer, type DegradeReason, type RouteAllowed } from './route.js'
import { textHashOf, tierOf, tombstoneActive, type EvidenceRef, type EvidenceSource, type EvidenceTier, type Tombstone } from './state.js'

export type AutoKind = 'preference' | 'fact' | 'correction' | 'procedure'

export const AUTO_KINDS: readonly AutoKind[] = ['preference', 'fact', 'correction', 'procedure']

export type GateName = 'source' | 'novelty' | 'durability' | 'safety' | 'scope' | 'conflict' | 'quota' | 'evidence' | 'layer'

/**
 * 待确认的理由代码。`pendingReason` 是给人看的一句话，这个是给调用方判断「要不要弹卡」的稳定标识：
 * 只有 `user-conflict` 是卡片批准或自动确认也解不开的（用户手写的记忆永远优先），
 * 其余都能被用户批准 / 自动确认清掉。
 */
export type ReviewCode = 'inference' | 'no-cache' | 'ambiguous' | 'procedure' | 'active-conflict' | 'user-conflict'

/** 每道门拒绝时给模型的一句话（英文：与其余五个域的工具回执同语言，且它要读得懂）。 */
export interface GateReject {
  ok: false
  gate: GateName
  /** 进模型上下文的回执。 */
  error: string
  /** 进日志 / 界面的中文说明。 */
  detail: string
  /**
   * 同一轮里命中的**其余**拒绝点。
   *
   * 门禁原本串行短路：撞一道、改、再撞下一道，每撞一次一轮往返。热路径上那是纯浪费 ——
   * 模型不知道后面还挡着什么，只能逐道试。现在跑完能跑的门，把能判的一次判完。
   * 首条仍在 `gate` / `error` / `detail` 里（保持既有调用方不变），这里只放追加项。
   */
  also?: GateRejectExtra[]
}

/** 追加的拒绝点：与首条同形，但只用于回执拼接。 */
export interface GateRejectExtra {
  gate: GateName
  error: string
  detail: string
}

export interface GatePass {
  ok: true
  text: string
  kind: AutoKind
  key: string
  source: EvidenceSource
  quote: string
  layer: MemoryLayer
  group: string
  status: 'active' | 'candidate'
  /** 证据档位（由系统按引句核对 / 用户确认推导，模型无法声明）。 */
  tier: EvidenceTier
  /** 用户在对话卡片上批准过这条原文（不等于最终一定 active：与用户记忆冲突时仍是 candidate）。 */
  approved: boolean
  /** 按自动生效策略直接落 active（没有用户确认，不改变证据来源）。 */
  autoActive?: boolean
  /** 被降级的原因（路由压窄 / 模糊时降级）。 */
  degraded?: DegradeReason
  /** 需要人工裁决的原因：有值 = 不注入，等用户确认。 */
  pendingReason?: string
  /** `pendingReason` 的稳定代码；有它才有 `pendingReason`。 */
  reviewCode?: ReviewCode
  /** 同 key 的旧条目：本次写入后应标 superseded。 */
  supersedes: string[]
  /** 已存在同 key 且是同一件事：合并到它，不新建。 */
  mergeInto?: string
  /** 给用户看的一句话（工具回执里带）。 */
  note?: string
}

export type GateOutcome = GatePass | GateReject

/** 冲突门与合并需要的现有条目视图。 */
export interface ExistingEntry {
  id: string
  layer: MemoryLayer
  key: string
  /** 归一化正文（比对相似度用）。 */
  text: string
  status: string
  origin: 'user' | 'auto'
  /** 索引里的单条开关；缺省 = 开。停用的条目不能当合并目标。 */
  enabled?: boolean
  /** workspace 层的所属工作区；其它层没有。 */
  workspace?: string
  /** session 层的所属会话；其它层没有。 */
  session?: string
  /** scene 层的场景名；用户记忆没有这个字段（对所有场景可见）。 */
  scene?: string
  /**
   * 记忆类型。`merge` 只合并同类型的两条 —— 类型决定保质期（事实 / 做法 30 天后提醒
   * 复核，偏好 / 纠正不过期），把一条做法并进一条偏好会让它的过期时间凭空消失。
   * 缺省 = 旧数据没写，按「未知」处理：不拦合并（那时两边都没有可丢的类型信息）。
   */
  kind?: string
  locked?: boolean
}

export interface GateContext {
  sessionId?: string
  workspaceHash?: string
  scene?: string
  /** 两个自主记忆开关给出的允许层。 */
  allowed: RouteAllowed
  existing: ExistingEntry[]
  /** 各层在最近一个频率窗口内**新增**了多少条（合并 / 更新不算）。 */
  recentByLayer?: Partial<Record<MemoryLayer, number>>
  /**
   * 全局 / 工作区共用的学习频率。缺项时用出厂值。
   * 同一份设置，两层各自计数：一层到量不影响另一层。
   */
  rate?: { notes: number; windowMinutes: number }
  knownWorkspaces: Set<string>
  knownScenes: Set<string>
  tombstones: Tombstone[]
  /** 单条正文长度上限（显示宽度）。 */
  maxTextWidth: number
}

/** `boundary` 的显示宽度上限（与写入侧 `MAX_BOUNDARY` 同档：一句话说得完）。 */
export const MAX_BOUNDARY_WIDTH = 500
/** `key`（slot）的长度上限：它是一个稳定句柄，不是一句话。 */
export const MAX_KEY_WIDTH = 120
/** `quote` 的长度上限：一段用户原话，通常一两句。超长引句会撑爆证据链与注入行。 */
export const MAX_QUOTE_WIDTH = 2000

export interface GateInput {
  text: string
  kind?: AutoKind
  key?: string
  /**
   * 模型声称的「用户原话」。**它是一份待核对的声明，不是一个证据档位** ——
   * 系统拿它跟本会话真实的用户消息做子串核对，核不上直接拒。
   *
   * 不再有 `source` 参数：来源由这份核对的结果决定（命中 → `user_explicit`，
   * 没给 → `model_inference`，卡片批准 → `user_approved`）。
   */
  quote?: string
  /** 模型 / 用户在卡片上指定的层；仍受两个开关与环境压窄。 */
  layer?: MemoryLayer
  boundary?: string
  ttlDays?: number
  /**
   * 用户在对话卡片上看过这条原文并批准了它。批准把「等确认」变成「直接生效」，
   * 但**不越过**与用户手写记忆的冲突：那条仍然只进 candidate，等用户在记忆页裁决。
   */
  approved?: boolean
  /**
   * 自动确认：调用方已获授权，不弹卡直接落 active。与 `approved` 的区别：
   * 没有用户看过原文，所以不把证据升成 `user_approved`；用户手写记忆冲突仍候选。
   */
  autoActive?: boolean
}

// ── 文本归一化与相似度 ─────────────────────────────────────────────────────

/** 归一化：小写、压空白、去首尾标点。比对与去重共用一份口径。 */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/[。！？；：,.;:!?"'“”‘’（）()【】[\]、]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

/** 字符二元组集合（中文没有词边界，bigram 是稳的最小粒度）。 */
function bigrams(text: string): Set<string> {
  const s = normalizeText(text).replaceAll(' ', '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Jaccard 相似度。0 = 完全不像，1 = 一样。 */
export function similarity(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / (A.size + B.size - hit)
}

/** 同一条的判定阈值：0.82 是「说法的两种版本」，不是「两件事」。 */
export const MERGE_SIMILARITY = 0.82

/** `covers` 判据里短边至少要有这么多个实义字符，否则一句话能覆盖任何东西。 */
const COVERS_MIN_CHARS = 12

/**
 * 短的那条是不是被长的那条**整段包含**。
 *
 * `similarity` 是 Jaccard，对长度差异大的两段天然不命中：用户手写一条 200 字的偏好，
 * 模型记下其中一句 30 字的话，交集除以并集只有零点几 —— 于是一条已经被用户写下的内容
 * 又被记了一遍。这里补一条包含判据：短边的实义内容整段出现在长边里就算同一条。
 *
 * 短边不足 `COVERS_MIN_CHARS` 个实义字符时**不判**："用 pnpm" 这类短语会命中任何提到
 * pnpm 的长文，那不是重复而是巧合。
 *
 * @param a - 一段正文。
 * @param b - 另一段正文。
 * @returns 任一方整段包含另一方时为 true。
 */
export function covers(a: string, b: string): boolean {
  return textContains(a, b, COVERS_MIN_CHARS)
}

/**
 * 包含判据的唯一实现：任一方剥掉标点后的实义内容整段出现在另一方里。
 *
 * `minChars` 由调用方给 —— 不同用途对"短到多少就不算同一件事"的要求不同：
 * 冲突 / 墓碑 / 合并要严（默认 `COVERS_MIN_CHARS`），而"这条是否已在用户记忆里"要更宽松，
 * 否则模型永远学不到用户没写全的那半句。实现只留一份，策略各自声明。
 *
 * @param a - 一段正文。
 * @param b - 另一段正文。
 * @param minChars - 短边至少要有的实义字符数；不足时一律返回 false。
 * @returns 任一方整段包含另一方时为 true。
 */
export function textContains(a: string, b: string, minChars: number): boolean {
  const A = meaningfulOf(a)
  const B = meaningfulOf(b)
  if (A.length < minChars || B.length < minChars) return false
  const [short, long] = A.length <= B.length ? [A, B] : [B, A]
  return long.includes(short)
}

/**
 * 否定极性：这条正文是不是在**禁止**某件事。
 *
 * 只认句首或紧挨动词的否定词 —— 「不要用 emoji」是否定，「这不要紧」不是（`不要紧` 是词）。
 */
function negationPolarity(text: string): boolean {
  const s = normalizeText(text)
  return /(?:^|[^不])不(?:要|能|可|许|得|应|准)|禁止|不允许|别再|切勿|never\b|do not\b|don't\b|must not\b|stop doing/i.test(s)
}

/**
 * 正文里的数字（含小数与版本号段）。用于判断两条说的是不是**同一个取值**。
 */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of normalizeText(text).matchAll(/\d+(?:\.\d+)*/g)) out.add(m[0])
  return out
}

/**
 * 「说的是同一件事」：相似度到阈值，或短边被长边整段包含。
 *
 * 冲突门、墓碑拦截、合并判定共用这一份 —— 三处各判一套时，会出现"合并了但墓碑没拦住"
 * 或"墓碑拦住了但冲突门没看见"这类自相矛盾。
 *
 * **两条否决先于相似度**，因为字符二元组看不见它们：
 *
 * - **否定相反**：「不要用 emoji」与「要用 emoji」只差一个 `不`，Jaccard 到 0.86，
 *   但它们说的是相反的事 —— 合并会让后一条**静默取代**前一条，用户禁止的东西又回来了。
 * - **数字冲突**：「端口是 8080」与「端口是 8081」共享前三位，二元组到 0.83，
 *   但它们指的是不同取值 —— 合并等于把其中一个配置丢掉。
 *
 * 两处否决都只在**极性 / 数字集合真的不同**时生效，不参与「像不像」的连续打分。
 *
 * @param a - 一段正文。
 * @param b - 另一段正文。
 * @returns 同一件事时为 true。
 */
export function sameThingText(a: string, b: string): boolean {
  const base = similarity(a, b) >= MERGE_SIMILARITY || covers(a, b)
  if (!base) return false
  // 包含关系下极性 / 数字差异是正常的：短边只是长边的一部分，
  // 「这个仓库用 pnpm」本来就是「…用 pnpm，不要用 npm」的一段。
  // 两处否决只用于**相似度**判同的那条路 —— 那里两条是各自独立的表述，
  // 差一个 `不` 或一位数字就是相反 / 不同的两件事。
  if (covers(a, b)) return true
  if (negationPolarity(a) !== negationPolarity(b)) return false
  const na = numbersIn(a)
  const nb = numbersIn(b)
  if (na.size > 0 && nb.size > 0) {
    for (const n of na) if (nb.has(n)) return true
    return false
  }
  return true
}

// ── 门 1 的一部分：正文里有没有值得记的东西 ───────────────────────────────

/** 至少要有几个实义字符（字母 / 数字 / 汉字）。一个字符的"笔记"只可能是残片。 */
const MIN_MEANINGFUL_CHARS = 2

/**
 * 去掉 HTML 标签与标点后剩下的实义字符。
 *
 * 为什么要剥标签：真实测试里模型把 `</text>` 当成一条笔记学了进去 —— 它看起来"有内容"，
 * 实际只是它上一次输出的闭合标签。标签剥掉后没有字母数字，就说明整段都是残片。
 */
function meaningfulOf(text: string): string {
  return String(text ?? '')
    .replaceAll(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replaceAll(/[^\p{L}\p{N}]/gu, '')
}

/**
 * 从正文推 kind。推不准时给 `fact`（最保守：fact 不改变行为，只是信息）。
 *
 * `kind` 决定保质期（见 `ttlDaysOf`）：`fact` / `procedure` 30 天后提醒复核，
 * `preference` / `correction` 不过期。所以这里错判的代价是「一条会过期的做法永久驻留」。
 *
 * **先判做法再判纠正**：早先把「不要 / 必须 / 一律」这类约束词直接当 `correction`，
 * 而中文里几乎任何偏好或做法都会带一个这样的词 —— 「提交信息一律用中文」「改完源码必须
 * 跑完整 build」全被判成 `correction`，拿到不过期的保质期。
 * `correction` 的判据是「用户在纠正你已经做过的事」，它通常带第一人称或明确的「刚才 /
 * 之前 / 别再」，而不只是「必须」。带做法形状的句子即使有约束词也归 `procedure`。
 */
export function inferKind(text: string): AutoKind {
  const t = String(text ?? '')
  // 做法先判：有先后顺序、有可复用的步骤，就是 procedure，哪怕句子里带「必须」。
  // 「先 X 再 Y」是有序步骤；「遇到 A 时先 B」也是 —— 后者没有「再」，但同样是「什么时候
  // 做什么」，早先只认前一种，于是「遇到冲突时先问我」被判成 `fact`（30 天后过期）。
  // 「改完源码必须跑完整 build」：没有「先 / 再 / 步骤」，但「必须 + 动作」就是要求你去做
  // 一件事 —— 那是做法，不是偏好。偏好说的是「怎么答 / 用什么」，做法说的是「去执行什么」。
  // 动作词要挑明确是「跑 / 执行 / 提交 / 部署」这一类的，否则「不要用 emoji」也会被吞进来。
  if (/步骤|流程|先.{0,12}再|然后.{0,12}最后|(?:时|前|之前|的话).{0,6}先|\bthen\b.*\bsteps?\b|run .* then /i.test(t)) return 'procedure'
  if (/(?:必须|务必|一定要|记得|别忘|不要忘).{0,20}(?:跑|执行|运行|提交|部署|推送|打包|构建|看|读|检查|打开|build|test|push|commit|deploy|read|check|open)/i.test(t)) return 'procedure'
  // 「必须把 X 写进 Y」「发布前必须把版本号改掉」：`把 / 将` 引出一个**宾语**，后面的动作
  // 作用在它身上 —— 这是操作序列，不是「该怎么答」。早先只认固定动作词表，于是这类全判成
  // 偏好而拿到永久保质期。注意不能吞掉「必须用中文回复」：那句说的是怎么答，不是去做什么。
  if (/(?:必须|务必|一定要).{0,16}[把将].{1,24}(?:写|改|放|加|删|移|换|填|设|写进|改成|改成)/.test(t)) return 'procedure'
  // 「这个字段必须是字符串」「版本号必须是三段」：`必须` 后面跟**系动词**（是 / 为 / 有 / 由）
  // 再跟一个名词或类型，讲的是代码本身的性质，不是「该怎么答」也不是「去执行什么」。
  // 缺这一条时它们落到下面的偏好分支（那里把 `必须` 当约束词），拿到不过期的保质期 ——
  // 一条技术约束从此永久驻留，而项目一改就不成立。系动词后面若紧跟动作词（「必须先跑测试」）
  // 仍按做法算，所以这一条排在那两条之后。
  // `保留 / 加锁 / 保持不变 / 不能并发` 这类也是「代码或接口的性质」，不是「该怎么答」。
  // 缺这几个词时它们落到下面的偏好分支（`必须` 被当约束词），拿到不过期 —— 而项目一改
  // 就不成立。它们没有动作序列（不满足上面的 procedure 判据），所以只能在这里接。
  if (/(?:必须|务必|一定要)(?:是|为|有|由|保持|等于|包含|支持|属于|唯一|一致|相同|不同|非空|为空|存在|有效|保留|加锁|不变|锁住|幂等|串行|兼容)[^。；;]{0,24}$/u.test(t)
    && !/(?:跑|执行|运行|提交|部署|推送|打包|构建|检查|build|test|push|commit|deploy)/i.test(t)) return 'fact'
  // 否定形式同理：「这个字段不能为空」「lib 目录禁止手改」讲的是这条代码 / 这份目录的性质。
  // `不能 / 禁止` 后面跟**系动词或状态词**时按事实算；跟动作词（「禁止提交 lib 目录」）
  // 仍是行为约束，留给下面的偏好分支。两者都会过期，区别只在 30 天还是永不过期。
  if (/(?:不能|不可|禁止|不允许)(?:是|为|有|被|包含|含有|为空|为空值|重复|并存|手改|手动改)[^。；;]{0,20}$/u.test(t)
    && !/(?:跑|执行|运行|提交|部署|推送|打包|构建|检查|提交|build|test|push|commit|deploy)/i.test(t)) return 'fact'
  // 「这个接口不能并发调用」「这个库不能在浏览器里跑」：`这个 / 该` + 代码构件作主语时，
  // `不能` 讲的是**技术能力**（做不到），不是「不许这样做」。裸 `不能改 lib 目录` 没有主语，
  // 仍是行为约束 —— 两者都会过期，区别只在 30 天还是永不过期。
  // 主语可能是「上次的接口」「之前的配置」这类带时间指代的形态：时间词只是限定语，
  // 句子讲的仍是构件性质。缺这一支时它们落到偏好分支，拿到不过期的保质期。
  if (/(?:这个|该|此|上次的|之前的|原来的|现有的)(?:接口|库|函数|方法|组件|方案|类|模块|配置|参数|字段|实现|服务|端点|脚本|工具)[^。；;]{0,8}(?:不能|不可|无法|改成|改成了|已改|变成了)/u.test(t)) return 'fact'
  // `correction` 只在「纠正已发生的事」时成立：指向你刚才做错的动作，或明说「别再 / 以后不要」。
  //
  // ⚠️ 这里的判据与 `blamesYou` 是同一条防线，都要求「指向**对话里发生的事**」。
  // 原判据把 `之前` / `改成` 当时间指代，而它们在技术陈述里到处都是 ——
  // 「这个字段之前是必填的」「上次的接口改成不能并发了」全被判成 correction，
  // 于是一条 30 天后就该复核的项目事实永久驻留。
  // 现在：`改成` 单独不算（它是最常见的动词），必须有明确的**还原 / 否定**意图；
  // 时间词也要求同句出现对话性指代（你 / 刚才那个 / 我让你）。
  // `以后不要用 emoji` 是**通用规则**（preference），不是纠正 —— 它不指向任何已发生的事。
  // 只有「以后不要**再**这样」这种带回指的才是指向过去；`别再` 同理，要求后接动作回指
  // （「别再改 lib 目录」是回指刚才那次改动，「别再犹豫」不是）。
  // 纯规则形态（`以后不要 + 动作`）交给下面的偏好分支。
  // 关键区分在**时间指向**，不在有没有约束词：
  //   · `别再 X` —— `别` 隐含「你刚才在做 X」，指向过去，是纠正（「别再动 lib」）；
  //   · `以后不要 X` / `别用 X` —— 面向未来的通用规则，是偏好（「以后不要用 emoji」）；
  //   · `以后不要**这样**` —— 回指词把句子锚回刚才那件事，是纠正。
  // 早先两种形态混在一个正则里，把通用规则也判成纠正，于是它拿到不过期的保质期。
  const correctsPrior = /别再/i.test(t)
    || /(?:以后|下次)(?:不要|别|不能)(?:再)?(?:这样|这么|那样)/i.test(t)
    || /我(?:让|叫)你/i.test(t)
    || (/(?:刚才|刚刚|上次)/.test(t) && /不对|错了|有问题|不行|不该|不好|改回|重做|还原|不是我要/i.test(t))
    || /\b(?:you (?:just|again|always)|instead of|stop doing)\b/i.test(t)
  // 「刚才那个改动不对」：指向刚才发生的事 + 一句否定评价，就是在纠正 —— 它没点名「你」，
  // 但那个动作只可能是这个 agent 做的。缺这一条时它被判成 `fact`（30 天后过期），
  // 于是一条纠正会在一个月后自己消失。
  const judgesPast = /刚才|刚刚|上次|之前/.test(t) && /不对|错了|有问题|不行|不该|不好/.test(t)
  if (judgesPast) return 'correction'
  // 「改回来」「这不是我要的」「不对，重做」：没有时间词，但指向的仍是**已经做出来的东西** ——
  // 要求还原、或直接否定当前结果，就是在纠正。缺这一条时它们被判成 `fact`（30 天后过期），
  // 于是一条「不要这样做」的纠正会在一个月后自己消失，agent 重新犯同样的错。
  if (/改回来|改回去|还原成|还原到|退回(?:到|原)|这不是我要|不是我想要|不是我要的|不对[，,].{0,8}(?:重做|重来|改)|重做一遍/iu.test(t)) return 'correction'
  // 「你总是忘记跑 lint」是纠正，但它不带约束词 —— 早先要求「指向过去」**且**「有约束词」
  // 两条都成立，于是一句明确的指责被判成 `fact`（30 天后过期）。指向「你」的过去动作本身
  // 就够判纠正了：那不是关于项目的事实，是在说这个 agent 做错了什么。
  //
  // ⚠️ 这一条最容易误判，判错的代价是「一条会过期的信息永久驻留」（correction 不过期）。
  // 原判据是 `你(?:又|总是|一直|老是|忘了|忘记|漏了|没|之前|上次|刚才)`，把三种不同的句子
  // 混成了一种：
  //   · 「你没有权限访问这个目录」—— 陈述权限，`你没有` 后面跟的是**状态**，不是过错；
  //   · 「你之前提到的那个方案已废弃」—— `你之前` 只是时间指代，全句在讲方案的状态；
  //   · 「你忘了跑 lint」—— 这才是指责。
  // 现在按「过错本身」判：`忘了 / 忘记 / 漏了` 自带过错语义，单独成立；
  // `没` 必须后面紧跟**动作词**（没跑 / 没改 / 没看），`没有权限` 这类状态词不算；
  // 纯时间词（之前 / 刚才 / 上次）单独不够，要配否定评价（见上面的 `judgesPast`）。
  const blameVerb = /你(?:又|总是|一直|老是)?(?:忘了|忘记|漏了|漏掉)/i.test(t)
  // `没 / 没有` + 动作词：动作词表与上面 procedure 判据同源，避免把「没有权限」吞进来。
  const blameMissed = /你(?:又|总是|一直|老是)?(?:没|没有)(?:跑|执行|运行|提交|部署|推送|打包|构建|检查|改|写|加|删|移|换|填|设|看|读|打开|更新|同步|build|test|push|commit|deploy|read|check|open)/i.test(t)
  // 「你总是……」「你又……」：强调频率的指责本身带负面语气，但仍要求后面跟动作，
  // 否则「你总是很忙」这种陈述也会被判成纠正。
  const blameAlways = /你(?:又|总是|一直|老是)(?:在)?(?:不|没|忘|漏|搞|弄|把|写|改|用|跑)/i.test(t)
  // 「你之前**用的**那个命令不存在了」：`用的` 回指的是 agent 实际执行过的动作，
  // 是在评价它做过的事 —— 与「你之前**提到的**那个方案」不同，后者只是提及。
  // 差别在动词：用的 / 选的 / 写的 / 改的 / 跑的是动作，提到的 / 问的 / 说的只是言语。
  const blameDid = /你(?:之前|上次|刚才)(?:用|选|写|改|跑|执行|加|删|动|提交)的/i.test(t)
  const blamesYou = blameVerb || blameMissed || blameAlways || blameDid
    || /\b(?:you (?:just|again|always|keep|forgot|missed)|instead of|stop doing)\b/i.test(t)
  if (blamesYou) return 'correction'
  if (correctsPrior && /不要|别|禁止|不能|必须|一律|绝(?:不|对)|never\b|do not\b|don't\b|must not\b/i.test(t)) return 'correction'
  // 回复风格：`回答 / 回复 / 输出 / 说话 / 语气 / 措辞` + 一个形容词或要求 —— 说的是
  // 「该怎么答」。早先只认「不要 / 必须 / 偏好」这类显式约束词，于是「回答要简洁」
  // 「回复要详细」「语气正式一点」全被判成 `fact`（30 天后过期），而它们是最基础、
  // 最不该过期的一类偏好。
  // 口语形态没有连接词：「说话直接点」「答案要简短」「语气正式一点」。判据放宽成
  // 「输出行为词 + 短距离内出现风格形容词 / 程度词」，不再要求必须有个「要」。
  // 这些词既可作动词也可作名词：「回复队列的实现用 Redis」讲的是队列，不是「该怎么回复」。
  // 要求风格词出现在**输出行为词之后 12 字内**，把技术名词组合排除在外。
  if (/(?:回答|回复|输出|答复|响应|说话|语气|措辞|表述|表达|文案|答案)[^。；;]{0,12}(?:简洁|简短|简单|详细|具体|完整|直接|正式|随意|口语|啰嗦|废话|一点|些)/.test(t)) return 'preference'
  // 代码风格：`注释 / 缩进 / 命名 / 格式 / 风格` 这类**风格对象** + 一个取值或形容词，
  // 说的是「代码该怎么写」，与「该怎么答」同类 —— 都不该过期。
  // 早先只认输出行为词，于是「保持中文注释」「缩进保持 2 空格」被判成 `fact`（30 天后过期），
  // 而它们正是最基础、最不该丢的一类偏好。
  // 语序两种都认：「缩进保持 2 空格」（对象在前）与「保持中文注释」（动词在前）。
  // 判据要求风格对象与取值 / 风格词同现，把「配置保持在 config 目录」这类位置陈述排除在外。
  const styleObject = /注释|缩进|命名|格式|风格|排版|换行|引号|分号|空格|大小写|文件名|变量名|函数名/u.test(t)
  const styleValue = /中文|英文|小写|大写|驼峰|camel|snake|kebab|2 空格|4 空格|两个空格|四个空格|tab|prettier|eslint|统一|一致|保持/u.test(t)
  if (styleObject && styleValue && !/(?:配置文件|配置项|目录|路径|这个值|该值)[^。；;]{0,6}(?:保持|放在|位于)/u.test(t)) return 'preference'
  // 产出物 + `要 / 别 / 写` + 形容词：「错误信息要具体」「日志别太啰嗦」「提交信息写清楚」——
  // 说的是产出该长什么样，与「该怎么答」同类，不该过期。
  // 要求形容词而非具体取值：`错误码要是 400`「日志写在 logs 目录」是陈述，仍按事实算。
  if (/(?:错误信息|日志|回复|测试|提交信息|PR|描述|文档|注释|命名|文案|提示|报错)[^。；;]{0,8}(?:要|别|写|保持|用)[^。；;]{0,8}(?:具体|详细|清楚|简洁|简短|简短|啰嗦|长|短|清晰|完整|覆盖|规范|一致)/u.test(t)) return 'preference'
  // 偏好：说的是「该怎么答 / 用什么」，不是某个可复用的操作序列。
  // `别` 只算祈使用法：单字匹配会把「级别 / 类别 / 区别 / 分别 / 性别 / 派别 / 另一个」
  // 这些名词里的 `别` 一起吞掉，于是「日志级别是 info」这种配置事实拿到不过期的保质期。
  // 判据两条：前面不能是名词构词成分（级 / 类 / 区 / 分 / 性 / 派 / 特 / 个），
  // 且后面要紧跟动作词（加 / 用 / 动 / 改 / 写 / 跑…）或「再 / 人」，才算「别这样做」。
  if (/不要|禁止|不能|必须|一律|绝(?:不|对)|(?<![级类区性派特个分])别(?=[再人加用改动写跑删提推装放看读查试问我])|never\b|do not\b|don't\b|must not\b/i.test(t)) return 'preference'
  if (/偏好|喜欢|倾向|习惯|统一|一律|prefer\b|always\b/i.test(t)) return 'preference'
  // `用` 是动词还是别的成分，看**后面跟什么**：
  //   · `用户 / 用途 / 用于` 是名词或介词 —— 早先单字匹配把「用户叫 ouli」判成了偏好；
  //   · `用的 / 用了 / 用过` 是**过去式的动词**，整句在陈述一件事（「之前用的那个库已经废弃
  //     了」），不是「请用某个东西」的偏好；
  //   · `用 pnpm` / `用中文` 才是「用某个东西」。
  if (/用(?![户途于的了过])/u.test(t)) return 'preference'
  if (/\buse\b|\bprefer\b/i.test(t)) return 'preference'
  return 'fact'
}

/** key 缺省时从正文派生：取前 3 个词的 slug（同 key 的机会小，靠相似度兜）。 */
export function deriveKey(text: string): string {
  const norm = normalizeText(text)
  const head = norm.split(' ').slice(0, 3).join('-').replaceAll(/[^\w\u4e00-\u9fa5-]/g, '')
  if (head !== '') return head.slice(0, 48)
  const hash = textHashOf(text).replace('djb2:', '')
  return 'k' + hash
}

// ── 门 3：持久 ─────────────────────────────────────────────────────────────

/**
 * 一次性标记：只对本次任务成立的表述。
 *
 * **排除引子与修饰语**：`今天学到的`、`这次的经验`、`暂时性文件` 里的时间词修饰的是名词，
 * 整句讲的仍是持久的事。早先一律按标记处理，于是「这次修改的经验：改完必须跑 build」
 * 「暂时性文件放 /tmp」「今天学到的：这个仓库用 pnpm」全被判成一次性而**拒绝入库** ——
 * 误拒比误存更糟：用户会觉得这个功能根本没用。
 * 判据：时间词后面紧跟 `的` / `性` / `学到` / `经验` / `教训` / `总结` 时不算时间状语。
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /这次(?!的|经验|教训|学到|总结|修改|变更|改动|学习|任务|会话)/, /今天(?!的|学到|学|发现)/, /今晚/, /暂时(?!性)/, /临时(?!性)/,
  /先这样/, /下一步/, /接下来/, /先试/, /本次(?!的|经验|教训|学到|总结)/, /这一轮/, /回头再说/,
  /\bfor now\b/i, /\bthis time\b/i, /\btemporarily\b/i, /\bnext step\b/i, /\bjust this once\b/i,
]

/** 持久标记：跨会话成立的表述。与一次性标记同时出现时**不猜**，降级。 */
const PERSISTENT_PATTERNS: readonly RegExp[] = [
  /以后/, /今后/, /总是/, /永远/, /一律/, /每次/, /都要/, /都不要/, /别再/, /不再/,
  /始终/, /一贯/, /习惯于/,
  /\balways\b/i, /\bnever\b/i, /\bfrom now on\b/i, /\bevery time\b/i, /\bgoing forward\b/i,
]

export type Durability = 'persistent' | 'transient' | 'ambiguous' | 'neutral'

export function durabilityOf(text: string): Durability {
  const t = String(text ?? '')
  const persistent = PERSISTENT_PATTERNS.some((re) => re.test(t))
  const transient = TRANSIENT_PATTERNS.some((re) => re.test(t))
  if (persistent && transient) return 'ambiguous'
  if (persistent) return 'persistent'
  if (transient) return 'transient'
  // 命令式否定（"不要自动 commit"）本身是持久规则：没有时间限定就不是一次性的。
  if (/^(?:不要|别|禁止|never\b|do not\b|don't\b)/i.test(t.trim())) return 'persistent'
  return 'neutral'
}

// ── 门 4：安全 ─────────────────────────────────────────────────────────────

interface SecurityHit { code: string; why: string }

const SECRET_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }> = [
  { code: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}/, why: 'API key 形态（sk-…）' },
  { code: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/, why: 'GitHub token' },
  { code: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key id' },
  { code: 'private-key', re: /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----/, why: '私钥' },
  { code: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, why: 'JWT' },
  { code: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, why: 'Slack token' },
  { code: 'password-assign', re: /(?<![A-Za-z0-9])(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i, why: '明文口令赋值' },
  // 中文表述：这是中文插件，用户与模型写「密码是 xxx」比写 `password: xxx` 常见得多。
  // 只认「密码 / 口令 / 密钥 + 是 / 为 / : + 一串像密钥的东西」，避免「密码要定期更换」误伤。
  { code: 'zh-secret', re: /(?:密码|口令|密钥|秘钥)\s*(?:是|为|[:：=])\s*[A-Za-z0-9_\-+/=]{8,}/, why: '中文明文口令' },
  // `\b` 在 `_` 前不成立（下划线是词字符），于是 `OPENAI_API_KEY=…` 这种最典型的 `.env` 写法
  // 整条漏过去 —— 只有裸 `API_KEY=…` 才拦得住。改用 `(?<![A-Za-z0-9])`：允许前面是下划线，
  // 但不许嵌在更长的单词里（`MYAPIKEY` 这种连写不算赋值形态）。
  { code: 'apikey-assign', re: /(?<![A-Za-z0-9])(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S{12,}/i, why: '密钥赋值' },
  // URL 内嵌凭据：`postgres://user:secret@host/db` 这类连接串是最常见的泄漏形态 ——
  // 用户排障时整条贴进对话，模型又会把它当成「项目配置」记下来。
  // 判据要求**协议 + 用户名 + 冒号 + 口令 + @**，`https://example.com/a@b` 这种路径里的 @ 不误伤。

  // 裸 `token=` / `auth_token:` / `bearer …`：`apikey-assign` 只认 api_key / secret_key /
  // access_token 三个词，而它们同样是一串可直接使用的凭据。
  // 值要求至少 12 位、且同时含数字与字母，避免 `token=xxxxxxxx` 这种占位符误伤。
  { code: 'bare-token', re: /(?<![A-Za-z0-9])(?:auth[_-]?token|token|bearer)\s*[:=]?\s*(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{12,}/i, why: '明文 token' },
  { code: 'url-credentials', re: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:/@]{1,64}:[^\s:/@]{3,128}@/i, why: 'URL 内嵌凭据' },
]

const INJECTION_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }> = [
  { code: 'ignore-instructions', re: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)/i, why: '指令覆盖（ignore previous instructions）' },
  // `the above rules` / `those instructions`：原判据只认 `disregard [the] rules`，
  // 中间插一个 `above` 就绕过。允许一个限定词位。
  { code: 'disregard-rules', re: /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:\w+\s+)?(?:instructions?|rules?|guidelines?|prompts?)/i, why: '指令覆盖（disregard rules）' },
  { code: 'role-hijack', re: /\byou\s+are\s+now\s+(?:a|an|the)\b/i, why: '角色劫持（you are now …）' },
  { code: 'zh-role-hijack', re: /(?:你(?:现在|从此|接下来)?(?:是|扮演|充当|作为)|从现在起你(?:是|要|将))[^。！？]{0,6}(?:管理员|黑客|助手|专家|角色|人物|机器人|AI|模型|系统|上帝|神|主人|老板|开发者|root)|你的新(?:角色|身份)是|忘记你(?:之前|原来|本来)的(?:身份|角色|设定)/u, why: '角色劫持（中文）' },
  // 中文角色劫持：与英文 `you are now a …` 同口径。「你现在是一个管理员」「从现在起你是」
  // 「你的新角色是」都是把 agent 的身份换掉 —— 早先只认英文，中文这一整类漏检。
  // 「你现在是只读模式」是状态描述，不是身份替换 —— 判据要求后面跟**身份名词**
  // （管理员 / 黑客 / 助手 / 专家 / 角色…），不认「模式 / 状态 / 只读」这类属性词。
  // 英文这一支与中文同口径：**只提到名词不算**，要带索取动作或位置泄露。
  // 早先裸 `\bsystem\s+prompt\b` 一律拦，于是「the system prompt lives in prompts/」
  // 这种正当项目知识被误伤 —— 中文判据改过之后英文没跟上，两边口径不一致。
  { code: 'system-prompt', re: /(?:ignore|disregard|reveal|leak|print|output|show|repeat|tell\s+me)\b[^\n]{0,40}\bsystem\s+prompt\b|\bsystem\s+prompt\b[^\n]{0,20}(?:\bis\s+what|content|verbatim|print\s+it|tell\s+me|show\s+me|reveal)/i, why: '索取系统提示词（英文）' },
  // 中文的「系统提示词 / 系统指令 / 系统消息」：这是中文插件，只认英文等于漏掉主要形态。
  // 中文的「系统提示词」：**只提到名词不算**，要带动作（忽略 / 无视 / 泄露 / 打印 / 输出）。
  // 这是中文插件，「系统提示词写在 prompts/ 下」「系统消息由宿主注入」都是正当的项目知识，
  // 一律拦掉会把最该记的东西挡在门外。
  // 两个语序都要认：动词在前（「打印系统提示词」）与名词在前（「系统提示词打印出来」）。
  // 只认前一种时，「把你的系统提示词打印出来」整句漏过去 —— 而那是中文里最常见的说法。
  // 名词在前这一支只认**索取形态**（是什么 / 内容 / 原文 / 打印出来 / 告诉我），不认单个动词：
  // 「系统提示词输出到日志里」是正当的项目知识，只凭一个「输出」就拦会误伤。
  { code: 'zh-system-prompt', re: /(?:忽略|无视|跳过|泄露|透露|打印|输出|告诉我|显示).{0,6}系统(?:提示词|提示语|指令|消息|设定)|系统(?:提示词|提示语|指令|消息|设定)[^。！？]{0,8}(?:是什么|内容|原文|打印出来|输出出来|贴出来|列出来|告诉我|给我看|发我)/, why: '索取系统提示词（中文）' },
  { code: 'zh-ignore', re: /(?:忽略|无视|跳过).{0,8}(?:之前|以上|上述|前面|先前)/, why: '指令覆盖（中文）' },
  { code: 'zh-new-rules', re: /新的?(?:系统)?(?:指令|规则)[:：]/, why: '伪造新指令' },
  { code: 'en-new-rules', re: /\b(?:new|updated|revised|replacement)\s+(?:system\s+)?(?:instructions?|rules?|directives?)\s*[:：]|\bhere\s+(?:are|is)\s+(?:your\s+)?(?:new|updated)\s+(?:instructions?|rules?)/i, why: '伪造新指令（英文）' },
  // 英文同一支：`new instructions:` / `updated rules:` / `here are your new instructions:`。
  // 中文这一条早就有了，英文一直缺 —— 同一类攻击在两种语言下待遇不同。
]

const DANGEROUS_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }> = [
  // 管道进 shell 的变体：`| sudo bash`、`| /bin/bash`、`| sh -s`。原判据要求 `|` 后紧跟
  // `sh` 类名字，于是 `sudo` / 绝对路径 / 前导空白都能绕过 —— 而这道门是记忆内容进上下文
  // 前的最后一道检查，漏检等于把危险指令当成经验存下来。
  // 允许跨越中间管道段（`| tee /tmp/a | bash`）：`[^|]` 会在第一个 `|` 停住，于是插一个
  // `tee` 就能绕过。放宽成 `[^\n]` 后仍要求末尾确实是 shell 名字，正常管道不会误伤。
  { code: 'pipe-to-shell', re: /\b(?:curl|wget)\b[^\n]{0,200}\|\s*(?:\S+\s+){0,2}(?:\/(?:usr\/)?bin\/)?(?:ba|z|fi|k)?sh\b/i, why: '管道进 shell' },
  // 破坏性删除：根目录之外，家目录与顶层目录同样是灾难（`rm -rf ~`、`rm -rf /home`）。
  // 只认 `-rf` 类组合，且要求目标是根 / 家目录 / 顶层路径 —— 正常的 `rm -rf node_modules` 不拦。
  { code: 'rm-root', re: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|~\/?\s*$|\/(?:home|usr|etc|var|opt|root)(?:\s|$|\/))/i, why: 'rm -rf 根 / 家目录' },
  { code: 'fork-bomb', re: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
]

/** 不可见控制字符：零宽、方向覆盖、词连接符、BOM。它们在界面上看不见，却能改变模型读到的东西。 */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/

export function securityScan(text: string): SecurityHit[] {
  const hits: SecurityHit[] = []
  for (const { code, re, why } of SECRET_PATTERNS) if (re.test(text)) hits.push({ code, why })
  for (const { code, re, why } of INJECTION_PATTERNS) if (re.test(text)) hits.push({ code, why })
  for (const { code, re, why } of DANGEROUS_PATTERNS) if (re.test(text)) hits.push({ code, why })
  if (INVISIBLE_RE.test(text)) hits.push({ code: 'invisible-chars', why: '不可见字符' })
  return hits
}

// ── 门 2：新颖（对**所有**写入生效）────────────────────────────────────────

/**
 * "查一下就知道"的形态：依赖版本、配置文件内容、目录树。
 *
 * 判据是**整句就是那个东西**，不是"句子里出现了那个词"。早先的 `\b(?:src|lib|dist)\//`
 * 只要正文提到 `src/` 就拒 —— 「构建产物在 lib 目录，别手改」这种真正值得记的约定会被
 * 误杀，而它恰恰是模型最该记住、最不可能从代码里读出来的那类知识。
 */
const DERIVABLE_PATTERNS: readonly RegExp[] = [
  // 键名后允许一个闭合引号：`"version": "1.2.3"` 里 `version` 与 `:` 之间隔着 `"`，
  // 不收这个引号就只认得出 `react@18.2.0`，认不出 JSON 形态 —— 而后者恰恰是最常被
  // 模型当成"值得记住的事实"抄下来的东西。
  /\b[\w@/-]+["']?\s*[:：@]\s*["']?[\^~]?\d+\.\d+\.\d+/,
  /"(?:scripts|dependencies|devDependencies)"\s*:/,
]

/** 纯路径清单形态：整句只是若干个路径 / 文件名，没有任何判断或约定。 */
const PATH_LIST_RE = /^(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}(?:\s*[,，、]\s*(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})*$/

/**
 * 这条正文能不能从代码 / 配置里直接读出来。
 *
 * 只认两种形态：**版本号形态**与**纯路径清单**。曾经还有一条"出现 `src/` / `lib/` 就拒"，
 * 误伤面远大于收益 —— 一句"构建产物在 lib 目录"是约定，不是抄写。
 */
export const looksDerivable = (text: string): boolean => {
  const t = String(text ?? '').trim()
  if (t === '') return false
  if (PATH_LIST_RE.test(t)) return true
  return DERIVABLE_PATTERNS.some((re) => re.test(t))
}

// ── 配额 ───────────────────────────────────────────────────────────────────

/**
 * 维护扫描使用的每层软上限（`maintenance.ts` 读它判断健康度与清理）。
 *
 * 全局 / 工作区**没有总条数上限**：记忆多了只影响注入预算，不拒绝写入。这两层放
 * `Infinity` —— 维护扫描不会因总数触发清理；写入速度由门 7 的频率限制。
 */
export const LAYER_QUOTA: Record<MemoryLayer, number> = {
  [LAYER_SESSION]: 50,
  [LAYER_SCENE]: 100,
  [LAYER_WORKSPACE]: Number.POSITIVE_INFINITY,
  [LAYER_GLOBAL]: Number.POSITIVE_INFINITY,
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const reject = (gate: GateName, error: string, detail: string): GateReject => ({ ok: false, gate, error, detail })

/**
 * 一次回执多条拒绝点：首条照旧走 `gate` / `error` / `detail`，其余进 `also`。
 *
 * 回执文本由调用方拼接（见 `tools/memory.ts` 的 `gateErrorText`）—— 这里只负责分组，
 * 不在数据层决定措辞。
 */
const rejectMany = (list: GateRejectExtra[]): GateReject => {
  const [first, ...rest] = list
  const head = first ?? { gate: 'source' as GateName, error: 'nothing to learn', detail: '空输入' }
  return {
    ok: false,
    gate: head.gate,
    error: head.error,
    detail: head.detail,
    ...(rest.length > 0 ? { also: rest } : {}),
  }
}

/**
 * 跑完九道门。纯函数（证据门要查会话缓存，那是本进程内的 Map，仍可测）。
 *
 * 返回值三种：拒绝、通过（可能带 `status='candidate'` 与 `pendingReason`）、通过且要合并。
 */
export function runGates(input: GateInput, ctx: GateContext): GateOutcome {
  const rawText = String(input.text ?? '').trim()

  // ── 前置门汇总 ──
  //
  // 这一组门**只看输入本身**，彼此独立：内容质量、安全、边界长度、slot 长度、引句长度、
  // 新颖、持久。它们原来串行短路，于是模型撞一道改一道 —— 改完再撞下一道，每撞一次
  // 一轮往返，而热路径上每一轮都是实打实的 token 与延迟。
  //
  // 现在一次判完：全部命中就一起回执，模型一轮就知道这条到底哪里不行。
  // 顺序仍按原来的优先级（安全最先），只是不再提前返回。
  const pre: GateRejectExtra[] = []

  // ── 门 1：证据来源（**系统判定**，不由模型声明）──
  //
  // 模型不再有 `source` 参数。它只能给一句 `quote`，而这句话要不要算证据由系统核对：
  //   · 逐字命中本会话真实的用户消息 → `user_explicit`；
  //   · 核不上 → 降级为 `model_inference`（伪造原话的风险由**证据档位**消掉，不是拒整条）；
  //   · 没给引句 → `model_inference`（诚实的最弱档）。
  //
  // 为什么删掉自报：旧的 `tool_verified` 是模型自己说"我验证过"，系统无法核对，却给了
  // 高权重并顺手豁免了新颖门 —— 于是把 `package.json` 里的版本号抄成一条笔记、
  // 标上"已验证"就能绕过唯一那道防抄代码的闸。让它自评"我有多确定"和让它自评
  // "我验证过"是同一类问题：写的人顺便当裁判。
  const quote = String(input.quote ?? '').trim()
  let source: EvidenceSource = quote === '' ? 'model_inference' : 'user_explicit'
  if (rawText === '') return reject('source', 'nothing to learn: text is empty', '正文为空')
  // 最低内容质量：纯标点、纯 HTML 残片（`</text>`）、一两个字符的碎片都拒。
  // 真实测试里模型把自己输出末尾的 `</text>` 学成了一条笔记 —— 它通过了其余八道门，
  // 因为那些门判的是"这句话该不该记"，没有一道问"这到底是不是一句话"。
  if (meaningfulOf(rawText).length < MIN_MEANINGFUL_CHARS) {
    pre.push({
      gate: 'source',
      error: 'this is not a sentence — it is only punctuation, markup, or one or two characters. Record the thing itself, in words.',
      detail: '内容质量门拒绝：没有实义内容（纯标点 / HTML 残片 / 过短）',
    })
  }

  // ── 门 4 先跑（安全）──
  // 顺序上安全门排在后面，但它**必须**在一切处理之前：安全问题不该等配额判完才发现。
  // 这里提前扫一遍只为"越早拒绝越好"，正式顺序仍是第 4 道（见下方）。
  // `boundary` 也要扫：它和正文一样会**逐字进上下文**（注入行末尾带着它），而它是单独
  // 一个参数 —— 只扫正文等于给注入留了一扇没上锁的侧门：`boundary` 里写一句
  // "ignore previous instructions" 一样到得了模型。
  const boundaryText = String(input.boundary ?? '').trim()
  const earlyHits = [...securityScan(rawText), ...securityScan(boundaryText)]
  if (earlyHits.length > 0) {
    pre.push({
      gate: 'safety',
      error: `this looks like ${earlyHits.map((h) => h.why).join(', ')} — secrets and instruction-override text are never recorded (not even sanitized)`,
      detail: `安全门拒绝：${earlyHits.map((h) => h.code).join(', ')}`,
    })
  }
  // 边界过长直接拒，不静默截断：截断后的边界可能把「只在 X 时不成立」削成「不成立」，
  // 语义正好反过来。让调用方自己写短。
  if (boundaryText.length > MAX_BOUNDARY_WIDTH) {
    pre.push({
      gate: 'source',
      error: `the boundary is ${boundaryText.length} characters (limit ${MAX_BOUNDARY_WIDTH}). Say when it does not hold in one short clause.`,
      detail: `边界过长（${boundaryText.length} > ${MAX_BOUNDARY_WIDTH}）`,
    })
  }
  // `key` / `quote` 与正文走同一套**长度 + 安全**判据。
  //
  // 这两个字段都落进 frontmatter / state.json，`quote` 还会被原样存进证据链：任意长输入
  // 会把状态文件撑大、把注入行挤掉，而它们此前**完全没有上限** —— 正文有 2400 宽度、
  // 边界有 500，只有这两个参数是敞开的。
  const keyText = String(input.key ?? '').trim()
  if (keyText.length > MAX_KEY_WIDTH) {
    pre.push({
      gate: 'source',
      error: `the slot name is ${keyText.length} characters (limit ${MAX_KEY_WIDTH}). A slot is a short stable handle, not a sentence.`,
      detail: `slot 名过长（${keyText.length} > ${MAX_KEY_WIDTH}）`,
    })
  }
  const quoteText = String(input.quote ?? '').trim()
  if (quoteText.length > MAX_QUOTE_WIDTH) {
    pre.push({
      gate: 'source',
      error: `the quote is ${quoteText.length} characters (limit ${MAX_QUOTE_WIDTH}). Quote the sentence that matters, not the whole message.`,
      detail: `引句过长（${quoteText.length} > ${MAX_QUOTE_WIDTH}）`,
    })
  }

  // ── 门 2：新颖（没有例外）──
  // 早先只对 model_inference 生效，于是模型声明一个「我验证过」就能豁免 —— 那正是
  // 抄 package.json 版本号最省事的路径。现在来源由系统判定，不再有可声明的豁免档。
  if (looksDerivable(rawText)) {
    pre.push({
      gate: 'novelty',
      error: 'this can be re-derived from the code or config (dependency versions, file lists, config contents). Read the file instead — if it is a preference rather than a fact, say so as one.',
      detail: '新颖门拒绝：可从代码/配置推导',
    })
  }

  // ── 门 3：持久 ──
  const durability = durabilityOf(rawText)
  if (durability === 'transient') {
    pre.push({
      gate: 'durability',
      error: 'this reads as a one-off ("this time", "for now", "next step"). Only record things that should still be true in the next conversation.',
      detail: '持久门拒绝：一次性表述',
    })
  }
  const ambiguousDurability = durability === 'ambiguous'

  // 前置门收集完了：有一条就整条拒，但把**全部**命中点一起回执。
  // 模型一轮就知道这条到底哪里不行，不必改一道撞一道。
  if (pre.length > 0) return rejectMany(pre)

  // ── 门 5：范围（路由）──
  const kind = input.kind && AUTO_KINDS.includes(input.kind) ? input.kind : inferKind(rawText)
  const key = (input.key ?? '').trim() !== '' ? String(input.key).trim() : deriveKey(rawText)
  const routedBy = routeLayer({
    text: rawText,
    // 有核对过的原话依据才可能升全局层：没有依据的推断只属于当前项目。
    quoted: quote !== '' && source !== 'model_inference',
    allowed: ctx.allowed,
    ...(ctx.workspaceHash !== undefined ? { workspaceHash: ctx.workspaceHash } : {}),
    ...(ctx.scene !== undefined ? { scene: ctx.scene } : {}),
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(input.layer !== undefined ? { forcedLayer: input.layer } : {}),
  })
  if (routedBy.blocked === true) {
    return reject(
      'scope',
      'not recorded: no autonomous-memory layer is available here. Global memory is off and this conversation has no workspace path — turn on a layer in the autonomous-memory settings, or open the project from a folder.',
      '范围门拒绝：没有可用的自主记忆层',
    )
  }
  let layer = routedBy.layer
  let group = routedBy.group
  let degraded = routedBy.degraded

  // ── 门 9：层 ──
  // 只剩全局 / 本项目两种。routeLayer 已经收窄过；这里再兜一道，防止旧调用带 session /
  // scene 的 forcedLayer、或将来有人改了路由却忘了这里 —— 一律按本项目落，不再产生
  // `_session/` 与场景目录（那两套和用户记忆的场景单选绑在一起）。
  if (layer !== LAYER_GLOBAL && layer !== LAYER_WORKSPACE) {
    if (ctx.allowed.workspace && ctx.workspaceHash) {
      layer = LAYER_WORKSPACE
      group = `_ws/${ctx.workspaceHash}`
    } else {
      layer = LAYER_GLOBAL
      group = 'global'
    }
    degraded = degraded ?? 'layer-off'
  }

  // ── 门 8：证据 ──
  // 没有卡片批准时一律先落候选：证据只决定信心与排序，不决定「是否直接生效」。
  // 卡片批准（approved）把「等确认」变成「直接生效」，并让推断证据升为 user_approved ——
  // 用户看过这条原文点了同意，那本身就是一份比推断强得多的证据。
  const approved = input.approved === true
  /**
   * 自动确认：agent 已获授权，不再弹卡。
   *
   * 与 `approved` 一样能清掉待确认理由，但**不冒充用户看过原文** —— 证据来源不会升成
   * `user_approved`。唯一不能越过的是用户手写记忆冲突：那条永远等用户裁决。
   */
  const autoActive = input.autoActive === true
  const decided = approved || autoActive
  const evidence: EvidenceRef[] = []
  const nowIso = new Date().toISOString()
  let review: string | undefined
  let reviewCode: ReviewCode | undefined
  /** 第一条理由胜出；`user-conflict` 是唯一会覆盖已有理由的（用户手写记忆永远优先）。 */
  const setReview = (code: ReviewCode, text: string): void => {
    // 自动确认下由 agent 承担判断；用户手写记忆冲突仍然必须由用户裁决。
    if (autoActive && code !== 'user-conflict') return
    if (reviewCode === 'user-conflict') return
    if (reviewCode === undefined || code === 'user-conflict') {
      review = text
      reviewCode = code
    }
  }
  if (quote !== '') {
    const checked = ctx.sessionId ? checkQuote(ctx.sessionId, quote) : { ok: false as const, reason: 'no-cache' as const }
    if (checked.ok) {
      evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote, at: nowIso })
      if (approved) {
        // 用户批准过同一条原文：两份证据都记上，档位取更强的那份（confirmed）。
        source = 'user_approved'
        evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote: rawText, at: nowIso })
      }
    } else if (checked.reason === 'no-cache') {
      // 缓存没到手（插件刚加载 / pre-step 没跑）：**不拒**。没有缓存不等于用户在撒谎，
      // 而拒掉会让「刚开一个新会话就记东西」整片失效。降级为推断并说明，等用户确认。
      source = approved ? 'user_approved' : 'model_inference'
      evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote: approved ? rawText : quote, at: nowIso })
      if (!decided) setReview('no-cache', '没有可核对的用户原文（本会话还没记录到），先按候选保存')
    } else {
      // 引句核不上：**降级为推断，不拒整条**。
      //
      // 原来这里是硬拒，理由是「伪造用户原话是唯一一种事后无法纠正的错误」。那个理由
      // 仍然成立，但它指向的是**证据链**，不是这条记忆本身 —— 把来源降成
      // `model_inference` 就已经消掉了「把没说过的话记成用户说的」这个风险，没有必要
      // 连记忆一起扔掉。
      //
      // 实际代价很大：模型对措辞的一次记忆偏差（少一个逗号 / 换了同义词）就让整条失败，
      // 它于是反复核对、改写、重试 —— 热路径上那是最贵的一段。而不开自动确认时用户本来
      // 就会在卡片上看到正文，判断该不该留。
      source = approved ? 'user_approved' : 'model_inference'
      evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote: approved ? rawText : quote, at: nowIso })
      if (!decided) setReview('inference', '引句与用户原话对不上（可能记错了措辞），已按模型推断保存，确认后才进上下文')
    }
  } else {
    if (approved) source = 'user_approved'
    evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote: rawText, at: nowIso })
    if (!decided) setReview('inference', '这是模型自己的推断（不是你的原话），确认后才进上下文')
  }

  // ── 门 6：冲突 ──
  const ownKey = ctx.existing.filter((e) => e.key !== '' && e.key === key)
  // 相似度不按 key 分组：同一句话换了个 key 也是同一件事（模型常把同一条记忆
  // 记成 `package-manager` / `pkg-manager` 两个槽）。跨 key 不合并的话，收件箱里
  // 会并排出现两条几乎一样的候选，用户只能二选一删掉一条。
  const similar = ctx.existing.filter((e) => sameThingText(e.text, rawText))
  let mergeInto: string | undefined
  const supersedes: string[] = []
  const injectableStatus = (s: string): boolean => s === 'active' || s === 'core' || s === 'playbook'
  const mergeableStatus = (s: string): boolean => s === 'candidate' || injectableStatus(s)

  const userConflict = ownKey.find((e) => e.origin === 'user') ?? similar.find((e) => e.origin === 'user')
  if (userConflict) {
    // 用户写的记忆永远赢：不覆盖、不取代，只排队等用户裁决。卡片批准也不越过这一条 ——
    // 用户选的是「记不记、记在哪层」，不是「覆盖我手写的那条」。
    setReview('user-conflict', `与你自己写的记忆「${userConflict.id}」冲突，等你在记忆页确认`)
  } else {
    const autoSame = [...ownKey, ...similar].filter((e) => e.origin === 'auto')
    const seen = new Set<string>()
    for (const e of autoSame) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      const sameThing = sameThingText(e.text, rawText)
      // 批准后层是用户选的：跨层目标不合并，改为取代 —— 否则用户选了工作区，
      // 这条却被并进全局那条，选择等于没生效。
      // 停用的条目也不能当合并目标：并进去仍是停用，新说法等于没记下来。
      if (sameThing && e.enabled !== false && mergeableStatus(e.status) && (!decided || e.layer === layer)) {
        mergeInto = e.id
      } else if (e.status === 'candidate') {
        // 候选之间同 key 不同说法：直接取代旧的，收件箱里只留最新说法。
        supersedes.push(e.id)
      } else if (injectableStatus(e.status)) {
        if (decided) {
          // 用户批准 / 自动确认的新说法直接取代旧的（同层 / 跨层都算），
          // 不能两条矛盾的事实同时注入。
          supersedes.push(e.id)
        } else {
          // 生效中的旧说法不能因为一条还没确认的候选就被静默拿下；等用户在记忆页确认
          // 新条目时再由 approve 取代（write.ts）。
          setReview('active-conflict', `与现有生效记忆「${e.id}」同 key 但说法不同，确认后会取代它`)
        }
      }
      // archived / superseded 不合并、不取代：用户已经把它收起来或换掉了，
      // 重新学到时应该是一条新条目，而不是悄悄并进一条不注入的历史。
    }
    // 合并保留目标条目自己的状态（write.ts 的 mergeInto 负责）；批准 / 自动确认时目标会被激活。
    if (mergeInto) {
      if (!decided) supersedes.length = 0
      const target = ctx.existing.find((e) => e.id === mergeInto)
      if (target?.locked) {
        return reject(
          'conflict',
          `not recorded: the matching note "${mergeInto}" was edited by the user and is locked. Ask them whether to update it.`,
          `冲突门拒绝：合并目标「${mergeInto}」被用户锁定`,
        )
      }
    }
  }

  // ── 门 7：频率 ──
  // 合并不新增条目；同层取代也不新增。跨层取代会在本层新建一条，仍要占名额。
  const supersedesHere = supersedes.some((id) => ctx.existing.find((e) => e.id === id)?.layer === layer)
  const createsEntry = !mergeInto && !supersedesHere
  if (createsEntry) {
    const rate = ctx.rate ?? { notes: NOTE_RATE_DEFAULTS.notes, windowMinutes: NOTE_RATE_DEFAULTS.minutes }
    const recent = ctx.recentByLayer?.[layer] ?? 0
    if (recent >= rate.notes) {
      return reject(
        'quota',
        `not recorded: this layer already learned ${recent} new notes in the last ${rate.windowMinutes} minutes (limit ${rate.notes}). Merge or update existing notes instead, or wait for the window to pass.`,
        `配额门拒绝：${layer} 层近 ${rate.windowMinutes} 分钟已新增 ${recent} 条（上限 ${rate.notes}）`,
      )
    }
  }

  // ── 收尾：档位与状态 ──
  const tier = tierOf(evidence)
  const notes: string[] = []
  if (ambiguousDurability && !decided) {
    // 同时有"这次"和"以后"：不猜，降级。这比猜错安全一个数量级。
    setReview('ambiguous', '表述里同时有一次性与长期两种说法，先按候选保存')
    notes.push('表述有歧义（一次性 vs 长期），先按候选保存')
  }
  if (degraded) notes.push(DEGRADE_NOTE[degraded])
  if (kind === 'procedure' && !decided) {
    // 做法类记忆影响"怎么做"，确认时更该让用户看一眼；卡片批准本身就是那一眼。
    setReview('procedure', '做法类记忆先按候选保存，确认后再启用')
  }

  // 有理由就不生效：卡片批准或自动确认授权，且一条待确认理由都不剩时才 active。
  const status: 'active' | 'candidate' = decided && review === undefined ? 'active' : 'candidate'
  const note = notes.length > 0 ? notes.join('；') : undefined
  return {
    ok: true,
    // 正常路径走不到截断：`learn` 与 `preview` 都在调用门禁前按 `MAX_AUTO_TEXT_WIDTH`
    // 拒绝超长文本（`too-long`），静默截断会让用户以为整条都存下了。
    // 保留它是因为 `runGates` 是导出函数 —— 测试与将来的调用方可能不经过那两道前置检查，
    // 那时宁可截断也不要把一条超长正文写进每一次对话的上下文。
    text: truncateToWidth(rawText, ctx.maxTextWidth),
    kind,
    key,
    source,
    // `quote` 入参可以为空（tool_verified / model_inference 不需要引句），但回执里的
    // `quote` 是**证据链上的那一句**，不能是空串：
    //   · `collectEvidence` 拿它当 evidence.quote，空了这条证据就没法回答"凭什么"；
    //   · 合并去重按 `session + quote` 判重，两条空 quote 会被当成同一条，
    //     症状是"合并只并了状态、证据没并过来"，置信度凭空掉一截。
    quote: quote || rawText,
    layer,
    group,
    status,
    tier,
    approved,
    ...(autoActive ? { autoActive: true } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
    ...(review !== undefined ? { pendingReason: review } : {}),
    ...(reviewCode !== undefined ? { reviewCode } : {}),
    supersedes,
    ...(mergeInto !== undefined ? { mergeInto } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

/**
 * 墓碑拦截：删过的条目不能复活。
 *
 * 三条判据任一命中：同 key、同文本指纹、或与墓碑原文说的是同一件事（`sameThingText`）。
 * 第三条是必要的：用户删了一条，模型**几乎照抄**地再写一遍时，精确哈希拦不住，
 * 而这条恰好是最伤信任的「删了又回来」。
 *
 * 它的边界要说清：`sameThingText` 的相似度阈值是 `MERGE_SIMILARITY`（0.82），
 * 只有措辞几乎一致才算同一件事。「以后都用 pnpm」被删后改写成「包管理器统一 pnpm」
 * 相似度只有 0.23，**拦不住** —— 那是改阈值到 0.2 才能覆盖的范围，而 0.82 是为了不误合并
 * 才定在这里的。真正兜住这种情况的是同 key 判据：同一个 slot 反复记同一件事时 key 相同。
 */
export function tombstoneBlocked(ctx: GateContext, key: string, text: string): Tombstone | undefined {
  const hash = textHashOf(text)
  return ctx.tombstones.find((t) => tombstoneActive(t) && (
    (key !== '' && t.key === key) ||
    (hash !== '' && t.textHash === hash) ||
    (t.text !== '' && sameThingText(t.text, text))
  ))
}
