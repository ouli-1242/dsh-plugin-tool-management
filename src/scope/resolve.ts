// 会话身份解析：从 agent 反查 sessionId / cwd / 项目根 —— 全部"取不到就返回 null"。
//
// 为什么单独一个文件：三个域（注入、HTTP ops、模型工具）都要回答"这是哪个会话"，而
// 取法只有一份。抄进各处就会分叉，分叉的症状是"某一域按会话隔离生效、另一域不生效"。
//
// ## 取不到 = 按全局（风险表最后一条）
//
// 冷恢复出来的临时 agent、宿主契约变更 —— 这些情况 sessionId 拿不到。这时**一律按全局
// 处理**，不报错、不猜：猜错的代价是"A 的设置漏进 B"，而按全局最多是"这一处没隔离"，
// 用户看得见、也不串内容。
//
// 子代理 / 侧聊**有**自己的 session id，但它属于父会话这个"对话"：作用域一律向上找到
// 用户会话再查（`sessionScopeIdOf`），否则父会话里藏起来的服务器 / 技能 / 工具表，派一个
// 子代理就能重新看见。
//
// ## 为什么不用 workspaceId
//
// 会话头里没有它。要拿得走 `ctx.workspaceRegistry` 线性查一遍（每个 step 一次）。
// 「工作区隔离」因此以**会话头的 cwd** 为准（与下拉分组、工作区挂回同一口径），
// 派生出的作用域键见 `scope/workspace-key.ts`；仍然不需要 workspaceId。

import { nearestProjectRoot } from '../skills/skill-roots.js'
import { isWorkspaceScopeKey, workspaceScopeKeyOf } from './workspace-key.js'
import type { ScopeMode } from './scope-overrides.js'

/** 一个 agent 的会话身份（任何一项取不到就是 null / undefined）。 */
export interface SessionIdentity {
  sessionId: string
  /** 会话的工作目录（宿主的 `header.cwd`）；没设过就是 undefined。 */
  cwd?: string
}

/**
 * 见过的会话 cwd（工作区模式用）。
 *
 * 为什么另记一份：工作区作用域键要从**根会话**的 cwd 派生，而 `sessionScopeIdOf` 只沿着
 * `header.parentSession` 走 id，手里没有父会话的 header。父会话的 agent 先被看见时把 cwd
 * 记下来，子代理随后解析作用域就能拿到同一个工作区。上限与父链一致，满了丢最早的
 * （丢了最多退回会话隔离，不会串到别的工作区）。
 */
const SESSION_CWDS = new Map<string, string>()
const SESSION_CWDS_MAX = 4096

/** 记下某个会话的 cwd（宿主清单 / 注入侧看到时顺手调；空值忽略）。 */
export function rememberSessionCwd(sessionId: string, cwd: unknown): void {
  if (sessionId === '' || typeof cwd !== 'string' || cwd.trim() === '') return
  SESSION_CWDS.set(sessionId, cwd.trim())
  if (SESSION_CWDS.size > SESSION_CWDS_MAX) {
    const oldest = SESSION_CWDS.keys().next()
    if (!oldest.done) SESSION_CWDS.delete(oldest.value)
  }
}

/** 某个会话的 cwd（只在见过的会话上有效；没记过 = undefined）。 */
export function sessionCwdOfId(sessionId: string): string | undefined {
  return SESSION_CWDS.get(sessionId)
}

/**
 * 从 agent 取会话身份。取不到返回 null。
 *
 * 两条来源都认（与 `skills/service.ts` 的 `notifyChatCatalog` 同口径）：
 * `session.id` 与 `session.header.id`。前者是活会话对象上的直接字段，后者是持久化头；
 * 不同宿主路径给的是不同的那一个，只认一条会在某条路径上恒为 null。
 */
export function sessionIdentityOf(agent: unknown): SessionIdentity | null {
  const session = (agent as { session?: unknown } | null | undefined)?.session
  if (!session || typeof session !== 'object') return null
  const bag = session as { id?: unknown; header?: { id?: unknown; cwd?: unknown } }
  const rawId = typeof bag.id === 'string' && bag.id !== '' ? bag.id : bag.header?.id
  if (typeof rawId !== 'string' || rawId === '') return null
  const cwd = typeof bag.header?.cwd === 'string' && bag.header.cwd !== '' ? bag.header.cwd : undefined
  if (cwd !== undefined) rememberSessionCwd(rawId, cwd)
  return { sessionId: rawId, ...(cwd === undefined ? {} : { cwd }) }
}

/** 会话 id（取不到返回 null）。 */
export function sessionIdOf(agent: unknown): string | null {
  return sessionIdentityOf(agent)?.sessionId ?? null
}

/**
 * 子会话 → 父会话（官方在会话头 `header.parentSession` 里记）。
 *
 * 只记内存：它是**活 agent 对象**上的一手信息，恢复出来的子会话重建 agent 时会再记一次。
 * 上限 4096 条，超了丢最早的 —— 键只是会话 id 字符串，丢了最多让深处嵌套的子代理退回
 * "按全局"，不会残留错误映射。
 */
const SESSION_PARENTS = new Map<string, string>()
const SESSION_PARENTS_MAX = 4096

/** 一个 agent 的会话头里有没有 `parentSession`（子代理 / 侧聊派生）。 */
function parentOfSession(agent: unknown): string | null {
  try {
    const session = (agent as { session?: unknown } | null | undefined)?.session
    if (!session || typeof session !== 'object') return null
    const parent = (session as { header?: { parentSession?: unknown } }).header?.parentSession
    return typeof parent === 'string' && parent !== '' && parent !== '__proto__' ? parent : null
  } catch { return null }
}

/**
 * 用于**作用域解析**的会话 id：子代理 / 侧聊会话 → 它所属的用户会话。
 *
 * 为什么必须往上找：作用域是按"对话"记的，而子代理有**自己的** session id。直接用子会话
 * id 查侧车必然查不到，于是它在全局口径下拿到父会话已经关掉的服务器 / 技能 / 工具表 ——
 * 父会话里藏起来的东西，派一个子代理就能看见。子代理属于同一个对话，作用域跟着父会话走。
 *
 * 解析链靠活 agent 的会话头逐层登记；某一环没登记过就停在那一层（宁可少隔离，不串到
 * 别的会话）。取不到 id 时返回 null，与 `sessionIdOf` 同口径。
 */
export function sessionScopeIdOf(agent: unknown): string | null {
  const id = sessionIdOf(agent)
  if (id === null) return null
  const parent = parentOfSession(agent)
  if (parent !== null && parent !== id) {
    SESSION_PARENTS.set(id, parent)
    if (SESSION_PARENTS.size > SESSION_PARENTS_MAX) {
      const oldest = SESSION_PARENTS.keys().next()
      if (!oldest.done) SESSION_PARENTS.delete(oldest.value)
    }
  }
  let current = id
  const seen = new Set<string>()
  for (;;) {
    const up = SESSION_PARENTS.get(current)
    if (up === undefined || up === current || seen.has(up)) return current
    seen.add(current)
    current = up
  }
}

/**
 * 会话的项目根（判据与官方一致：向上找最近的 `.git`，找不到就没有项目根）。
 *
 * 与 `skills/skill-roots.ts` 的 `nearestProjectRoot` 是**同一个函数**，不另写一份 ——
 * 项目技能根与项目 AGENTS.md 必须认同一个目录，否则"技能按 A 项目隔离、指令按 B 项目读"。
 */
export async function projectRootOf(cwd: string | undefined): Promise<string | null> {
  if (cwd === undefined) return null
  try {
    const found = await nearestProjectRoot(cwd)
    return found && found.root ? found.root : null
  } catch {
    return null
  }
}

// ── 工作区模式：把一个会话折叠到工作区作用域键 ──────────────────────

/**
 * 一个**已知 cwd 的会话 id** → 当前模式下的作用域键（同步）。
 *
 *   · `global`    → `''`（没有会话层：调用方查不到任何记录，读侧自然落到各域全局）；
 *   · `session`   → 原样返回会话 id；
 *   · `workspace` → 有 cwd 且长度合法时返回 `ws:<归一化 cwd>`；否则原样返回会话 id。
 *
 * 已是工作区键的输入原样返回（面板选中的就是它）。冷会话 / 没见过 cwd 时退回会话隔离
 * ——宁可少共享一层，也不能猜到一个别的工作区上去。
 *
 * 空串是"没有键"的唯一表示，且它天然写不进去（`validRecordKey('')` 为 false）—— 所以
 * `global` 模式下任何试图写会话层的路径都会在 store 那一层被拒，不需要每个写入点自己记事。
 */
export function scopeKeyOfIdSync(sessionId: string, mode: ScopeMode): string {
  if (mode === 'global') return ''
  if (sessionId === '' || mode !== 'workspace' || isWorkspaceScopeKey(sessionId)) return sessionId
  const cwd = sessionCwdOfId(sessionId)
  return workspaceScopeKeyOf(cwd) ?? sessionId
}

/**
 * 从 agent 取**作用域键**（注入 / 守卫 / 目录 / 工具表用）。
 *
 * 粒度是"对话"：子代理 / 侧聊先向上找到所属用户会话；工作区模式下再用**根会话的 cwd**
 * 折叠到工作区。根会话 cwd 没见过时退回子会话自己的 cwd，再没有就退回会话 id
 * （与 `sessionScopeIdOf` 同一条"宁可少隔离，不串到别处"的取向）。
 *
 * `global` 模式返回 `null` = 这一处没有会话层。所有调用方已有的 `null → 按全局` 分支
 * 直接成立，不需要各自再判一次模式。注意仍然先走一遍 `sessionIdentityOf`：它顺手记下
 * 会话 cwd，切回工作区粒度时不必再等一次会话清单。
 */
export function scopeKeyOfAgent(agent: unknown, mode: ScopeMode): string | null {
  const identity = sessionIdentityOf(agent)
  if (identity === null) return null
  if (mode === 'global') return null
  const root = sessionScopeIdOf(agent)
  if (root === null) return null
  if (mode !== 'workspace') return root
  const cwd = sessionCwdOfId(root) ?? identity.cwd
  return workspaceScopeKeyOf(cwd) ?? root
}
