// 「最近改动」流水（0.15.0 B2）—— 写类 op 成功之后追加一条 JSONL，兼容页倒序显示。
//
// 为什么要有它：启用态被三方动过 —— 面板点击、模型的 `_switch` 工具、场景引擎 ——
// 事后回答不了「这个开关是谁、什么时候关的」。所有写动作的收口点都在 op 层，包一层就能
// 同时拿到「谁」（调用方）与「改了什么」（对象名）。
//
// 三条硬规矩（改这个文件前先读）：
//   ① **只记对象名，绝不记参数全文** —— env / headers 里可能是凭据，记忆与档案是用户内容，
//      写进一份常驻磁盘的流水等于把它们再复制一份到没人看守的地方。
//   ② 写失败一律静默 —— 先例见 index.ts 的 confirm-bypass 留痕（`.catch(() => {})`）：
//      流水是附属能力，任何情况下都不能挡着真正的写操作，也不能把界面点成红的。
//   ③ readonly 与失败/抛错的调用不记 —— 记的是「变更成功」，不是「有人试过」。

import { appendFile, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { hubPath } from './hub.js'
import { OP_REGISTRY } from './op-registry.js'

const AUDIT_FILE = 'audit.jsonl'
/** 轮转阈值：超过 512KB 保留最近 500 条。这页的本意是「最近改动」，不是无限期审计。 */
const ROTATE_OVER_BYTES = 512 * 1024
const ROTATE_KEEP_LINES = 500
/** 读上限：界面上限 500 条，再多没有意义（列表本身也只渲染最近这些）。 */
const READ_MAX_LIMIT = 500

export type AuditSource = 'panel' | 'model' | 'engine'

export interface AuditEntry {
  ts: number
  op: string
  target: string
  source: AuditSource
}

/**
 * 门禁按写、实质是「往外拷 / 只读枚举」的 op 不记：
 * 它们不改任何状态，记下来只会把真变更淹没（导出/查表点了多少次不是"最近改动"）。
 */
const AUDIT_SKIP = new Set(['mcpm-reveal', 'mcpm-export', 'bundle-export', 'preset-tools', 'skill-open'])

/** 摘要拿不到具体对象时的占位（界面按 `audit.target.*` 翻成「配置」，词典不跟着数据走）。 */
export const AUDIT_TARGET_CONFIG = '@config'

/** 这条 op 属不属于「写类」：判据从登记表来，不再手抄一份名单（登记改了这里自动跟上）。 */
export function isWriteClassOp(op: string): boolean {
  const cls = (OP_REGISTRY as Record<string, { readonly?: boolean; write?: boolean; serviceWrite?: boolean; frozen?: boolean }>)[op]
  if (!cls || cls.readonly === true) return false
  return cls.write === true || cls.serviceWrite === true || cls.frozen === true
}

const str = (v: unknown) => String(v == null ? '' : v).trim()

/**
 * op + args → 对象名摘要。按 op 前缀取那一域「名字字段」的第一个非空值，取不到就归「配置」。
 * 参数全文一律不碰（见文件头第 ① 条）。
 */
export function auditTargetOf(op: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (op.startsWith('mcpm-')) return str(a.serverName) || str(a.id) || AUDIT_TARGET_CONFIG
  if (op.startsWith('skill-')) return str(a.name) || str(a.key) || str(a.skill) || str(a.root) || AUDIT_TARGET_CONFIG
  if (op.startsWith('subagent-')) return str(a.name) || str(a.agent) || AUDIT_TARGET_CONFIG
  if (op.startsWith('agentsmd-')) return str(a.id) || str(a.nextId) || AUDIT_TARGET_CONFIG
  if (op.startsWith('scene-')) return str(a.scene) || AUDIT_TARGET_CONFIG
  // rules-* 既管记忆也管场景：先按记忆 id，再按场景名（`rules-set-active` 传的是 scene）。
  if (op.startsWith('rules-')) return str(a.id) || str(a.scene) || AUDIT_TARGET_CONFIG
  if (op.startsWith('history-')) return str(a.sessionId) || str(a.id) || AUDIT_TARGET_CONFIG
  return AUDIT_TARGET_CONFIG
}

/** 一条流水（同步发起、异步落盘，失败静默）。 */
export function recordAudit(entry: AuditEntry): void {
  appendAudit(entry).catch(() => { /* 流水写不进去不影响任何真动作 */ })
}

/**
 * 一次 op 结果要不要记：写类 + 本次成功（`ok !== false`，与服务端「成功返回扁平 {ok:true,…}」
 * 的口径一致；不返回 ok 的按成功处理）。
 */
export function recordOpAudit(op: string, args: unknown, source: AuditSource, result: unknown): void {
  if (!isWriteClassOp(op) || AUDIT_SKIP.has(op)) return
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) return
  recordAudit({ ts: Date.now(), op, target: auditTargetOf(op, args), source })
}

async function appendAudit(entry: AuditEntry): Promise<void> {
  const abs = hubPath(AUDIT_FILE)
  let size = 0
  try { size = (await stat(abs)).size } catch { /* 还没有这个文件 */ }
  if (size > ROTATE_OVER_BYTES) {
    const kept = await tailLines(abs, ROTATE_KEEP_LINES)
    await writeFile(abs, kept.length ? kept.join('\n') + '\n' : '', 'utf8')
  }
  await appendFile(abs, JSON.stringify(entry) + '\n', 'utf8')
}

/** 读末尾 n 行（文件不存在 = 空）。整份读入：这份流水被轮转压在 512KB 以内，不会失控。 */
async function tailLines(abs: string, n: number): Promise<string[]> {
  let raw = ''
  try { raw = await readFile(abs, 'utf8') } catch { return [] }
  const lines = raw.split('\n').filter((l) => l.trim())
  return lines.slice(Math.max(0, lines.length - n))
}

/**
 * 清空流水（界面上的「清除记录」）。**只删文件、自己不补记** —— 调用它的 op 是写类，
 * 成功后由通用包装层记一条 `audit-clear`，于是"谁清过流水"本身也留在流水里，
 * 而不是留下一段无声的空白。
 */
export async function clearAudit(): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const abs = hubPath(AUDIT_FILE)
  let lines = 0
  try { lines = (await readFile(abs, 'utf8')).split('\n').filter((l) => l.trim()).length } catch { lines = 0 }
  try {
    await unlink(abs)
    return { ok: true, removed: lines }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err && err.code === 'ENOENT') return { ok: true, removed: 0 }   // 本来就没有 = 已经是空的
    return { ok: false, error: String((err && err.message) || e) }
  }
}

/**
 * 读流水（倒序）。`domain` 是 op 前缀（`mcpm` / `skill` / `rules` …），省略 = 全部。
 * 坏行直接跳过：手改过的流水文件不该让兼容页报错。
 */
export async function readAudit(args: { limit?: unknown; domain?: unknown }): Promise<AuditEntry[]> {
  const wanted = Number(args && args.limit)
  const limit = Math.min(READ_MAX_LIMIT, Math.max(1, Number.isFinite(wanted) && wanted > 0 ? wanted : 100))
  const domain = str(args && args.domain)
  const lines = await tailLines(hubPath(AUDIT_FILE), Math.max(limit * 4, 600))
  const out: AuditEntry[] = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let e: any
    try { e = JSON.parse(lines[i]) } catch { continue }
    if (!e || typeof e.op !== 'string' || typeof e.ts !== 'number') continue
    if (domain && e.op.indexOf(domain + '-') !== 0 && e.op !== domain) continue
    out.push({
      ts: e.ts,
      op: e.op,
      target: str(e.target),
      source: e.source === 'model' || e.source === 'engine' ? e.source : 'panel',
    })
    if (out.length >= limit) break
  }
  return out
}
