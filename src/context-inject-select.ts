// 注入的决策层：把域状态归一成合法设置，再算出「这一轮该发哪几条、不该发的为什么」。
//
// 从 context-inject.ts 整段搬来，一行未改。这里只出结论（选中的段 + 每个未选中的原因），
// 一句面向模型的话都不拼 —— 拼话在 context-inject-frame.ts，发消息在 context-inject.ts。
import type { PresetInjectionFacts } from './compat/preset-reach.js'
import {
  CARRIER_FACT_OF,
  DEFAULT_INJECT_SETTINGS,
  INJECT_DOMAIN_KEYS,
  type InjectDomain,
  type InjectDomainKey,
  type InjectForm,
  type InjectSettings,
} from './context-inject-contract.js'

/** 把任意输入夹成合法设置（缺项/类型不对一律退回默认；默认从不阻止注入）。 */
export function normalizeInjectSettings(raw: unknown): InjectSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const domainsRaw = (obj.domains && typeof obj.domains === 'object' ? obj.domains : {}) as Record<string, unknown>
  const domains = {} as Record<InjectDomainKey, boolean>
  for (const key of INJECT_DOMAIN_KEYS) {
    domains[key] = typeof domainsRaw[key] === 'boolean' ? (domainsRaw[key] as boolean) : DEFAULT_INJECT_SETTINGS.domains[key]
  }
  return {
    underSuppressingPresets: typeof obj.underSuppressingPresets === 'boolean'
      ? obj.underSuppressingPresets
      : DEFAULT_INJECT_SETTINGS.underSuppressingPresets,
    domains,
  }
}

/** 一条待注入的域（纯数据，便于测试）。 */
export interface InjectSection {
  key: InjectDomainKey
  name: string
  label: string
  form: InjectForm
  text: string
  /**
   * 这一条是**差异行**而不是整份正文（见 `InjectDomain.delta`）：
   * 框架层据此不套 `how` / 边界句 —— 那两句是整份目录的说明，配在一行差异上是假话。
   */
  delta?: boolean
}

/**
 * 纯函数：按设置 + 预设事实 + 目标 agent 挑出本次要注入的域。
 *
 * 规则（域开关 × 预设压制 × 注入深度）：
 *   - 域开关关掉的、文本为空的，都不进；
 *   - **压制型预设**且没开「仍然注入」→ 一个都不进（跟随预设）；
 *   - 域声明 `applicableTo` 说不成立的域不进（**深度判据逐域写**：场景与记忆只在顶层
 *     —— 它们说的是父会话的处境；人设目录则看会话深度有没有超出人设的 `catalogDepth`，
 *     默认 1 = 只在顶层注入。**这都不是"子会话不能委派"** —— 委派由官方决定，
 *     见 service.ts 里 `catalogDepth` 的注释）；
 *   - 有官方载体的两个域（提示词 / 技能目录）：预设挂得到官方那条行时不进
 *     —— 官方自己会送，再注入一遍只会重复；预设事实读不到（`undefined`）时按"已承载"处理
 *     （宁可与现状一致，也不制造重复）。**例外**：域给了 `delta` 时，官方在送整份
 *     这一轮只补一行本会话的差异 —— 接管整份会和官方第 1 轮那份并存，而那条已在历史里收不回；
 *   - 同一段文本出现两次只保留前一个（跨域保险）。
 *
 * `onError`：某个域的 `text()` **取数失败**时回调一次，并跳过该域。
 * 为什么不能像原来那样静默吞成空串：调用方据此判定"该域这一轮没内容"，而下游还有一条
 * 「上一轮可见、这一轮没内容 → 发一条『已清空』」的通知 —— 于是一次取数失败会让模型收到
 * **假的"已清空"**，据此认为那份内容已失效，下一轮内容恢复后又重发一次。
 *
 * ⚠️ 这条通道**只认抛异常**，所以域的 `text()` 实现必须把"读失败"与"真的空"分开：
 * 返回空串一律被当成后者 —— 而真实世界里 IO 失败走的正是 `catch → return ''` 那条路，
 * 只防抛异常挡不住它。`src/memories/service.ts`
 * 的 `requireSceneMemory` / `sceneCatalog` / `readPresetTextSync` 已按此改。
 */
export function selectInjections(
  domains: readonly InjectDomain[],
  settings: InjectSettings,
  facts: PresetInjectionFacts | undefined,
  agent?: unknown,
  onError?: (key: InjectDomainKey, error: unknown) => void,
): InjectSection[] {
  const suppressing = facts !== undefined && facts.suppressing
  if (suppressing && !settings.underSuppressingPresets) return []
  const out: InjectSection[] = []
  const seen = new Set<string>()
  for (const domain of domains) {
    if (settings.domains[domain.key] !== true) continue
    // 域自己不成立就不发（如人设目录的 catalogDepth 没覆盖到本会话的深度）。**这里没有开关，是刻意的**：
    // 曾经有个 `suppressInSubagentSessions` 想让这一步可选，但它是个空开关 —— 域不成立时
    // 正文自己也被过滤成空的（见 `subagents/catalog.ts` 的按深度过滤），两道闸条件相同，
    // 开关只控制得了其中一道。留一个点了没反应的勾选框比没有更糟，所以删掉。
    if (domain.applicableTo !== undefined && !domain.applicableTo(agent)) continue
    const carrier = CARRIER_FACT_OF[domain.key]
    // 官方载体已挂（或读不到预设、只能按已挂算）→ 不重复送整份。
    // 但域给了 `delta` 时补一行本会话的差异——**兜底路径**：正常装配下注入器
    // 已经在有差异时把官方载体从 `facts` 里摘掉（`carriesSkillCatalog: false`），于是这里
    // 走下面的整份分支；只有在接管判据未接上的旧装配 / 测试里才会走到这条差异行。
    if (carrier !== undefined && facts?.[carrier] !== false) {
      if (domain.delta === undefined) continue
      let delta = ''
      try { delta = String(domain.delta(agent) ?? '') } catch { delta = '' /* 差异行读不到 = 没有差异 */ }
      if (delta.trim() === '') continue
      if (seen.has(delta.trim())) continue
      seen.add(delta.trim())
      out.push({ key: domain.key, name: domain.name, label: domain.label, form: domain.form, text: delta, delta: true })
      continue
    }
    let text = ''
    try { text = String(domain.text(agent) ?? '') } catch (error) {
      // 取数失败 ≠ 没有内容：交给调用方（上报 + 这一轮不发"已清空"），本域这一轮不发。
      try { onError?.(domain.key, error) } catch { /* 上报本身绝不能影响注入 */ }
      continue
    }
    if (text.trim() === '') continue
    const fingerprint = text.trim()
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ key: domain.key, name: domain.name, label: domain.label, form: domain.form, text })
  }
  return out
}

/**
 * 某一步「为什么发 / 为什么不发」。
 *
 * `child` = 该域对本会话不成立（人设目录：会话深度超出了人设的 `catalogDepth`）；`official` = 官方载体在送；
 * `off` = 开关关了；`empty` = 本插件负责但没内容；`sent` = 本插件负责且有内容；
 * `error` = 本插件负责、但这一轮**取数失败**（故障，不是"没内容"）。
 */
export type InjectReason = 'off' | 'official' | 'empty' | 'sent' | 'child' | 'error'

/**
 * 纯函数：某一步某域**该不该发一条「已清空」**（从注入器抽出来，便于测试）。
 *
 * 通知的字面意思是"这份内容已失效，别再用"。所以只有当"上一轮确有一条内容、这一轮确实
 * 一条都没有"时才发 —— 下面四种情形下那句话是假话，一条都不能发：
 *
 *   · 从没注入过这个域（没有旧内容要作废）；
 *   · 最新一条已经是通知了（再发就是每轮刷屏，用户实测）；
 *   · 这一轮取数失败（"没读到"≠"没有了"）；
 *   · 这一轮数据还没到手（`pending`：首轮 / LRU 顶掉 / 写操作后正在重算 ——
 */
export function shouldAnnounceCleared(input: {
  published: boolean
  failed: boolean
  pending: boolean
  /** 表面上这一域最近一条的状态；`undefined` = 这个会话从没注入过它。 */
  previous: { cleared?: boolean } | undefined
  /**
   * 技能目录接管但会话版为空（本对话一条都用不了）时的特例：官方那份已被拦下，
   * 不补一条的话模型手里只剩历史里那份已经不对的清单。
   */
  takeoverEmpty?: boolean
}): boolean {
  if (input.published) return false
  if (input.failed) return false
  if (input.pending) return false
  if (input.previous !== undefined && input.previous.cleared) return false
  return input.previous !== undefined || input.takeoverEmpty === true
}

/**
 * 纯函数：算出某一步每个域的原因（`selectInjections` 的镜像，供「注入实况」解释状态）。
 *
 * 与 `selectInjections` 分开写是为了让两边各自可读：一个是"发什么"，一个是"为什么"。
 * 口径必须一致 —— 否则界面会把"子会话抑制"报成"未投递"，而界面的既有口径是
 * 「琥珀只留给'该投却没投'」（把用户自己的选择读成故障，正是这条口径要避免的事）。
 *
 * ⚠️ 这里**故意不镜像** `selectInjections` 开头那条"压制型预设一个都不进"的提前返回：
 * 该分支下本函数仍按各域自身的原因作答，于是压制型预设 + 没开「仍然注入」时，
 * 界面看到的是"未投递"（琥珀）而不是"已关闭"（灰）。这是既有行为，本次未改，
 * 改动它属于另一个话题（"跟随预设"到底该报成故障还是报成选择）。
 */
export function explainInjections(
  domains: readonly InjectDomain[],
  settings: InjectSettings,
  facts: PresetInjectionFacts | undefined,
  agent?: unknown,
  failed?: ReadonlySet<InjectDomainKey>,
): Partial<Record<InjectDomainKey, InjectReason>> {
  const reasons: Partial<Record<InjectDomainKey, InjectReason>> = {}
  for (const domain of domains) {
    if (settings.domains[domain.key] !== true) { reasons[domain.key] = 'off'; continue }
    if (domain.applicableTo !== undefined && !domain.applicableTo(agent)) { reasons[domain.key] = 'child'; continue }
    const carrier = CARRIER_FACT_OF[domain.key]
    if (carrier !== undefined && facts?.[carrier] !== false) {
      // 与 `selectInjections` 同一条：官方在送整份，但本会话有差异行要补 → 这一轮确实送了一条。
      // 正常情况下技能目录接管会把 `carriesSkillCatalog` 置 false（走下面的整份读数），
      // 这里的 `sent` 只对应旧装配的兜底差异行。
      let delta = ''
      if (domain.delta !== undefined) { try { delta = String(domain.delta(agent) ?? '') } catch { delta = '' } }
      reasons[domain.key] = delta.trim() === '' ? 'official' : 'sent'
      continue
    }
    // 取数失败过 → 报 `error` 而不是 `empty`：两者在界面上的含义完全不同（一个是故障、
    // 一个是"本来就没内容"），而原来这条路上永远只能看到后者。`failed` 由调用方
    // 从 `selectInjections` 的 `onError` 收集；**只认抛异常**，返回空串仍算 `empty`。
    if (failed?.has(domain.key)) { reasons[domain.key] = 'error'; continue }
    let text = ''
    try { text = String(domain.text(agent) ?? '') } catch { text = '' }
    reasons[domain.key] = text.trim() === '' ? 'empty' : 'sent'
  }
  return reasons
}
