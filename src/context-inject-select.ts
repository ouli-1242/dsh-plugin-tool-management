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
}

/**
 * 纯函数：按设置 + 预设事实 + 目标 agent 挑出本次要注入的域。
 *
 * 规则（设计 2026-09-16；目录注入深度 2026-09-17）：
 *   - 域开关关掉的、文本为空的，都不进；
 *   - **压制型预设**且没开「仍然注入」→ 一个都不进（跟随预设）；
 *   - 域声明 `applicableTo` 说不成立的域不进（**深度判据逐域写**：场景与记忆只在顶层
 *     —— 它们说的是父会话的处境；人设目录则看会话深度有没有超出人设的 `catalogDepth`，
 *     默认 1 = 只在顶层注入。**这都不是"子会话不能委派"** —— 委派由官方决定，
 *     见 service.ts 里 `catalogDepth` 的注释）；
 *   - 有官方载体的两个域（提示词 / 技能目录）：预设挂得到官方那条行时不进
 *     —— 官方自己会送，再注入一遍只会重复；预设事实读不到（`undefined`）时按"已承载"处理
 *     （宁可与现状一致，也不制造重复）；
 *   - 同一段文本出现两次只保留前一个（跨域保险）。
 *
 * `onError`（2026-09-30 审查 P1-8）：某个域的 `text()` **取数失败**时回调一次，并跳过该域。
 * 为什么不能像原来那样静默吞成空串：调用方据此判定"该域这一轮没内容"，而下游还有一条
 * 「上一轮可见、这一轮没内容 → 发一条『已清空』」的通知 —— 于是一次取数失败会让模型收到
 * **假的"已清空"**，据此认为那份内容已失效，下一轮内容恢复后又重发一次。
 *
 * ⚠️ 这条通道**只认抛异常**，所以域的 `text()` 实现必须把"读失败"与"真的空"分开：
 * 返回空串一律被当成后者（2026-09-30 审查 F7 —— 修复第一版只覆盖了抛异常那一半，
 * 而真实世界里 IO 失败走的是 `catch → return ''` 那条路）。`src/memories/service.ts`
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
    // 开关只控制得了其中一道。留一个点了没反应的勾选框比没有更糟，所以删掉（2026-09-17）。
    if (domain.applicableTo !== undefined && !domain.applicableTo(agent)) continue
    const carrier = CARRIER_FACT_OF[domain.key]
    // 官方载体已挂（或读不到预设、只能按已挂算）→ 不重复送；只有明确"没挂"才兜底。
    if (carrier !== undefined && facts?.[carrier] !== false) continue
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
 * 纯函数：算出某一步每个域的原因（`selectInjections` 的镜像，供「注入实况」解释状态）。
 *
 * 与 `selectInjections` 分开写是为了让两边各自可读：一个是"发什么"，一个是"为什么"。
 * 口径必须一致 —— 否则界面会把"子会话抑制"报成"未投递"，而界面的既有口径是
 * 「琥珀只留给'该投却没投'」（把用户自己的选择读成故障，正是这条口径要避免的事）。
 *
 * ⚠️ 这里**故意不镜像** `selectInjections` 开头那条"压制型预设一个都不进"的提前返回：
 * 该分支下本函数仍按各域自身的原因作答，于是压制型预设 + 没开「仍然注入」时，
 * 界面看到的是"未投递"（琥珀）而不是"已关闭"（灰）。这是 0.9.1 的既有行为，本次未改，
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
    if (carrier !== undefined && facts?.[carrier] !== false) { reasons[domain.key] = 'official'; continue }
    // 取数失败过 → 报 `error` 而不是 `empty`：两者在界面上的含义完全不同（一个是故障、
    // 一个是"本来就没内容"），而原来这条路上永远只能看到后者（审查 P1-8）。`failed` 由调用方
    // 从 `selectInjections` 的 `onError` 收集；**只认抛异常**，返回空串仍算 `empty`（F7）。
    if (failed?.has(domain.key)) { reasons[domain.key] = 'error'; continue }
    let text = ''
    try { text = String(domain.text(agent) ?? '') } catch { text = '' }
    reasons[domain.key] = text.trim() === '' ? 'empty' : 'sent'
  }
  return reasons
}
