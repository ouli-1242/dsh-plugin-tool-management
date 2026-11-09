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
import type { WriteTarget } from './config.js'
import { checkQuote } from './evidence.js'
import { DEGRADE_NOTE, routeLayer, type DegradeReason } from './route.js'
import { BASE_CONFIDENCE, confidenceOf, textHashOf, tombstoneActive, type EvidenceRef, type EvidenceSource, type Tombstone } from './state.js'

export type AutoKind = 'preference' | 'fact' | 'correction' | 'procedure'

export const AUTO_KINDS: readonly AutoKind[] = ['preference', 'fact', 'correction', 'procedure']

export type GateName = 'source' | 'novelty' | 'durability' | 'safety' | 'scope' | 'conflict' | 'quota' | 'evidence' | 'layer'

/** 每道门拒绝时给模型的一句话（英文：与其余五个域的工具回执同语言，且它要读得懂）。 */
export interface GateReject {
  ok: false
  gate: GateName
  /** 进模型上下文的回执。 */
  error: string
  /** 进日志 / 界面的中文说明。 */
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
  confidence: number
  /** 被降级的原因（路由压窄 / 模糊时降级）。 */
  degraded?: DegradeReason
  /** 需要人工裁决的原因：有值 = 不注入，等用户确认。 */
  needsReview?: string
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
  locked?: boolean
}

export interface GateContext {
  sessionId?: string
  workspaceHash?: string
  scene?: string
  writeTarget: WriteTarget
  existing: ExistingEntry[]
  /** 各层现有自动条目数。 */
  countByLayer: Partial<Record<MemoryLayer, number>>
  /** 每层条数上限；0 = 用常量默认。 */
  maxEntries: number
  knownWorkspaces: Set<string>
  knownScenes: Set<string>
  tombstones: Tombstone[]
  /** 单条正文长度上限（字符）。 */
  maxTextLength: number
}

export interface GateInput {
  text: string
  kind?: AutoKind
  key?: string
  source: EvidenceSource
  quote?: string
  /** 模型强制指定的层；仍受 `writeTarget` 上限与环境压窄。 */
  layer?: MemoryLayer
  boundary?: string
  ttlDays?: number
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

/** 从正文推 kind。推不准时给 `fact`（最保守：fact 不改变行为，只是信息）。 */
export function inferKind(text: string): AutoKind {
  const t = String(text ?? '')
  if (/不要|别|禁止|不能|必须|一律|绝(?:不|对)|never\b|do not\b|don't\b|must not\b/i.test(t)) return 'correction'
  if (/步骤|流程|先.{0,12}再|然后.{0,12}最后|\bthen\b.*\bsteps?\b|run .* then /i.test(t)) return 'procedure'
  if (/用|使用|偏好|喜欢|倾向|习惯|统一|prefer\b|use\b|always\b/i.test(t)) return 'preference'
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

/** 一次性标记：只对本次任务成立的表述。 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /这次/, /今天/, /今晚/, /暂时/, /临时/, /先这样/, /下一步/, /接下来/, /先试/,
  /本次/, /这一轮/, /回头再说/,
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
  { code: 'password-assign', re: /\b(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i, why: '明文口令赋值' },
  { code: 'apikey-assign', re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S{12,}/i, why: '密钥赋值' },
]

const INJECTION_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }> = [
  { code: 'ignore-instructions', re: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)/i, why: '指令覆盖（ignore previous instructions）' },
  { code: 'disregard-rules', re: /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:instructions?|rules?|guidelines?)/i, why: '指令覆盖（disregard rules）' },
  { code: 'role-hijack', re: /\byou\s+are\s+now\s+(?:a|an|the)\b/i, why: '角色劫持（you are now …）' },
  { code: 'system-prompt', re: /\bsystem\s+prompt\b/i, why: '提及系统提示词' },
  { code: 'zh-ignore', re: /(?:忽略|无视|跳过).{0,8}(?:之前|以上|上述|前面|先前)/, why: '指令覆盖（中文）' },
  { code: 'zh-new-rules', re: /新的?(?:系统)?(?:指令|规则)[:：]/, why: '伪造新指令' },
]

const DANGEROUS_PATTERNS: ReadonlyArray<{ code: string; re: RegExp; why: string }> = [
  { code: 'pipe-to-shell', re: /\b(?:curl|wget)\b[^|]{0,200}\|\s*(?:ba|z|fi)?sh\b/i, why: '管道进 shell' },
  { code: 'rm-root', re: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$|\*)/, why: 'rm -rf /' },
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

// ── 门 2：新颖（只对 model_inference 生效）──────────────────────────────────

/** "查一下就知道"的形态：依赖版本、配置文件内容、目录树。 */
const DERIVABLE_PATTERNS: readonly RegExp[] = [
  // 键名后允许一个闭合引号：`"version": "1.2.3"` 里 `version` 与 `:` 之间隔着 `"`，
  // 不收这个引号就只认得出 `react@18.2.0`，认不出 JSON 形态 —— 而后者恰恰是最常被
  // 模型当成"值得记住的事实"抄下来的东西。
  /\b[\w@/-]+["']?\s*[:：@]\s*["']?[\^~]?\d+\.\d+\.\d+/, // react@18.2.0 / "version": "1.2.3"
  /"(?:scripts|dependencies|devDependencies)"\s*:/,
  /\b(?:src|lib|dist|node_modules|\.git)\//,
  /\b\w+\.(?:json|ya?ml|toml|lock|ini|env)\b.*\b(?:里|中)\b/,
]

export const looksDerivable = (text: string): boolean => DERIVABLE_PATTERNS.some((re) => re.test(text))

// ── 配额 ───────────────────────────────────────────────────────────────────

/** 每层的自动条目软上限。超了拒绝并提示整理（不静默丢新的）。 */
export const LAYER_QUOTA: Record<MemoryLayer, number> = {
  [LAYER_SESSION]: 50,
  [LAYER_SCENE]: 100,
  [LAYER_WORKSPACE]: 200,
  [LAYER_GLOBAL]: 100,
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const reject = (gate: GateName, error: string, detail: string): GateReject => ({ ok: false, gate, error, detail })

/**
 * 跑完九道门。纯函数（证据门要查会话缓存，那是本进程内的 Map，仍可测）。
 *
 * 返回值三种：拒绝、通过（可能带 `status='candidate'` 与 `needsReview`）、通过且要合并。
 */
export function runGates(input: GateInput, ctx: GateContext): GateOutcome {
  const rawText = String(input.text ?? '').trim()

  // ── 门 1：来源 ──
  // "声明完整性"：说这是用户明说的，就必须带引句。没带就**降级**为模型推断 ——
  // 直接拒绝会让模型学会"随便编一句引句"，降级让它诚实（candidate 不注入，不影响用户）。
  let source: EvidenceSource = input.source
  let downgraded: string | undefined
  const quote = String(input.quote ?? '').trim()
  if ((source === 'user_explicit' || source === 'user_correction') && quote === '') {
    source = 'model_inference'
    downgraded = '没有给出用户原话，按模型推断处理'
  }
  if (rawText === '') return reject('source', 'nothing to learn: text is empty', '正文为空')

  // ── 门 4 先跑（安全）──
  // 顺序上安全门排在后面，但它**必须**在一切处理之前：安全问题不该等配额判完才发现。
  // 这里提前扫一遍只为"越早拒绝越好"，正式顺序仍是第 4 道（见下方）。
  const earlyHits = securityScan(rawText)
  if (earlyHits.length > 0) {
    return reject(
      'safety',
      `refused: this looks like ${earlyHits.map((h) => h.why).join(', ')} — secrets and instruction-override text are never recorded (not even sanitized)`,
      `安全门拒绝：${earlyHits.map((h) => h.code).join(', ')}`,
    )
  }

  // ── 门 2：新颖 ──
  if (source === 'model_inference' && looksDerivable(rawText)) {
    return reject(
      'novelty',
      'not recorded: this can be re-derived from the code or config (dependency versions, file lists, config contents). Read the file instead — if it is a preference rather than a fact, say so as one.',
      '新颖门拒绝：可从代码/配置推导',
    )
  }

  // ── 门 3：持久 ──
  const durability = durabilityOf(rawText)
  if (durability === 'transient') {
    return reject(
      'durability',
      'not recorded: this reads as a one-off ("this time", "for now", "next step"). Only record things that should still be true in the next conversation.',
      '持久门拒绝：一次性表述',
    )
  }
  const ambiguousDurability = durability === 'ambiguous'

  // ── 门 5：范围（路由）──
  const kind = input.kind && AUTO_KINDS.includes(input.kind) ? input.kind : inferKind(rawText)
  const key = (input.key ?? '').trim() !== '' ? String(input.key).trim() : deriveKey(rawText)
  const routedBy = routeLayer({
    text: rawText,
    source,
    writeTarget: ctx.writeTarget,
    ...(ctx.workspaceHash !== undefined ? { workspaceHash: ctx.workspaceHash } : {}),
    ...(ctx.scene !== undefined ? { scene: ctx.scene } : {}),
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(input.layer !== undefined ? { forcedLayer: input.layer } : {}),
  })
  let layer = routedBy.layer
  let group = routedBy.group
  let degraded = routedBy.degraded

  // ── 门 9：层 ──
  if (layer === LAYER_SESSION && (!ctx.sessionId || group !== `_session/${ctx.sessionId}`)) {
    return reject('layer', 'refused: a conversation-scoped note needs a conversation id', '层门拒绝：会话层缺 sid')
  }
  if (layer === LAYER_SCENE && (!ctx.scene || !ctx.knownScenes.has(ctx.scene))) {
    // 场景没了（改名 / 删除）：降级到工作区，别让这条记忆凭空消失。
    if (ctx.workspaceHash) {
      layer = LAYER_WORKSPACE
      group = `_ws/${ctx.workspaceHash}`
      degraded = 'no-scene'
    } else {
      layer = LAYER_SESSION
      group = ctx.sessionId ? `_session/${ctx.sessionId}` : 'global'
      degraded = 'no-scene'
    }
  }

  // ── 门 8：证据 ──
  const evidence: EvidenceRef[] = []
  let status: 'active' | 'candidate' = 'candidate'
  let review: string | undefined
  if (source === 'user_explicit' || source === 'user_correction') {
    const checked = ctx.sessionId ? checkQuote(ctx.sessionId, quote) : { ok: false as const, reason: 'no-cache' as const }
    if (checked.ok) {
      evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote, at: new Date().toISOString() })
      status = 'active'
    } else if (checked.reason === 'no-cache') {
      // 缓存没到手（插件刚加载 / pre-step 没跑）：不拒，降 candidate 并说明。
      // 直接拒会让"第一次打开开关就试"永远失败，那个体验比降级差得多。
      evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source: 'model_inference', quote, at: new Date().toISOString() })
      review = '没有可核对的用户原文（本会话还没记录到），先按候选保存'
    } else {
      return reject(
        'evidence',
        'refused: the quote is not a verbatim substring of anything the user said in this conversation. Quote their exact words, or pass source="model_inference" if it is your own inference.',
        `证据门拒绝：引句不是用户原文（${checked.reason}）`,
      )
    }
  } else if (source === 'tool_verified') {
    evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source, quote: quote || rawText, at: new Date().toISOString() })
    status = 'active'
  } else {
    evidence.push({ session: ctx.sessionId ?? '', turn: 0, seq: -1, source: 'model_inference', quote: quote || rawText, at: new Date().toISOString() })
    status = 'candidate'
    // 候选一定要说清"为什么还得等确认"：界面上只有标签没有理由时，用户只能全信或全删。
    review = '这是模型自己的推断（不是你的原话），确认后才进上下文'
  }

  // ── 门 6：冲突 ──
  const ownKey = ctx.existing.filter((e) => e.key !== '' && e.key === key)
  const sameText = ctx.existing.filter((e) => e.key === '' && similarity(e.text, rawText) >= MERGE_SIMILARITY)
  let mergeInto: string | undefined
  const supersedes: string[] = []

  const userConflict = ownKey.find((e) => e.origin === 'user') ??
    ctx.existing.find((e) => e.origin === 'user' && similarity(e.text, rawText) >= MERGE_SIMILARITY)
  if (userConflict) {
    // 用户写的记忆永远赢：不覆盖、不取代，只排队等用户裁决。
    status = 'candidate'
    review = `与你自己写的记忆「${userConflict.id}」冲突，等你在记忆页确认`
  } else {
    const autoSame = [...ownKey, ...sameText].filter((e) => e.origin === 'auto' && e.id !== mergeInto)
    for (const e of autoSame) {
      // 同一件事的两种说法（高相似）→ 合并；同 key 但说法不同 → 取代旧的。
      if (e.key !== '' && e.key === key && similarity(e.text, rawText) >= MERGE_SIMILARITY) {
        mergeInto = e.id
      } else if (e.status === 'active' || e.status === 'core') {
        supersedes.push(e.id)
      }
    }
    if (mergeInto) {
      status = 'active'
      supersedes.length = 0
    }
  }

  // ── 门 7：配额 ──
  const used = ctx.countByLayer[layer] ?? 0
  const cap = ctx.maxEntries > 0 ? ctx.maxEntries : LAYER_QUOTA[layer]
  // 合并与取代不新增条目，不占配额。
  if (!mergeInto && supersedes.length === 0 && used >= cap) {
    return reject(
      'quota',
      `not recorded: this layer already holds ${used} learned notes (limit ${cap}). Merge or archive some first — the Memory page has a cleanup view.`,
      `配额门拒绝：${layer} 层已满（${used}/${cap}）`,
    )
  }

  // ── 收尾：信心与状态 ──
  let confidence = confidenceOf(evidence)
  const notes: string[] = []
  if (downgraded) notes.push(downgraded)
  if (ambiguousDurability) {
    // 同时有"这次"和"以后"：不猜，降级。这比猜错安全一个数量级。
    status = 'candidate'
    review = review ?? '表述里同时有一次性与长期两种说法，先按候选保存'
    confidence = Math.min(confidence, BASE_CONFIDENCE.user_explicit - 0.15)
    notes.push('表述有歧义（一次性 vs 长期），先按候选保存')
  }
  if (degraded) notes.push(DEGRADE_NOTE[degraded])
  if (kind === 'procedure') {
    // 程序性记忆影响"怎么做"，一律先候选：成功两次之后由 dream 提名进 playbook。
    if (status === 'active') {
      status = 'candidate'
      review = review ?? '做法类记忆先按候选保存，验证通过后再启用'
    }
  }

  const note = notes.length > 0 ? notes.join('；') : undefined
  return {
    ok: true,
    text: rawText.slice(0, ctx.maxTextLength),
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
    confidence,
    ...(degraded !== undefined ? { degraded } : {}),
    ...(review !== undefined ? { needsReview: review } : {}),
    supersedes,
    ...(mergeInto !== undefined ? { mergeInto } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

/** 墓碑拦截：删过的条目不能复活（`key` 或文本指纹任一命中）。 */
export function tombstoneBlocked(ctx: GateContext, key: string, text: string): Tombstone | undefined {
  const hash = textHashOf(text)
  return ctx.tombstones.find((t) => tombstoneActive(t) && ((key !== '' && t.key === key) || (hash !== '' && t.textHash === hash)))
}
