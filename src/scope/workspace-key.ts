// 工作区作用域键：把「同一个工作区」的会话折成同一份覆盖。
//
// 为什么需要这一层：侧车 `scope-overrides.json` 的键原本就是会话 id。工作区模式不能改成
// "让某个会话当代表"——代表被删 / 归档之后键就断了，而且新开的会话必须立刻加入同一个作用域。
// 用一个从 **cwd** 派生的合成键（`ws:<归一化路径>`）最稳：会话头里就有 cwd，注入热路径
// （同步）不需要再去问宿主「这台机器的工作区登记表」。
//
// 键里带完整路径而不是哈希：技能页拿这个键当 `sessionId` 传过来时，服务端要还原出 cwd
// 去推导项目技能根；哈希会把这条路堵死。Windows 的盘符大小写 / 分隔符由 `workspacePathKey`
// 归一（与工作区挂回、下拉分组同一口径）。超长路径不生成工作区键，调用方退回会话隔离
// ——宁可少共享一层，也不截断一个路径键导致两个工作区撞在一起。
//
// 前缀 `ws:` 只用于本侧车；宿主会话 id 不会以它开头，真实会话 id 仍原样存在。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workspaceBaseName, workspacePathKey } from '../sessions/path-key.js'

/** 工作区作用域键的前缀。 */
export const WORKSPACE_SCOPE_PREFIX = 'ws:'

/** 键的最大长度：与 `scope-overrides.ts` 的侧车记录键上限一致（见那边的 `validRecordKey`）。 */
export const WORKSPACE_SCOPE_KEY_MAX = 900

/**
 * 一个 cwd 对应的工作区作用域键；空路径 / 超长路径返回 `undefined`
 * （调用方退回会话隔离，不猜、不截断）。
 */
export function workspaceScopeKeyOf(cwd: unknown): string | undefined {
  const key = workspacePathKey(cwd)
  if (key === '') return undefined
  const id = WORKSPACE_SCOPE_PREFIX + key
  return id.length <= WORKSPACE_SCOPE_KEY_MAX ? id : undefined
}

/** 这个作用域键是不是工作区键。 */
export function isWorkspaceScopeKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(WORKSPACE_SCOPE_PREFIX) && key.length > WORKSPACE_SCOPE_PREFIX.length
}

/**
 * 工作区键里的 cwd（归一化后的拼写）。不是工作区键返回 `undefined`。
 *
 * 归一化在 Windows 上会小写盘符与路径；把它当项目技能根仍然成立（文件系统大小写不敏感）。
 */
export function workspaceCwdOfScopeKey(key: unknown): string | undefined {
  return isWorkspaceScopeKey(key) ? String(key).slice(WORKSPACE_SCOPE_PREFIX.length) : undefined
}

/** 作用域键的人话名字：会话键原样；工作区键取目录名（取不到退回完整键）。 */
export function scopeKeyLabel(key: string): string {
  const cwd = workspaceCwdOfScopeKey(key)
  if (cwd === undefined) return key
  return workspaceBaseName(cwd) || key
}

/**
 * 一个会话行 → 它的作用域键（工作区模式按 cwd，其余按会话 id）。
 *
 * `global` 粒度返回 `''`：那一档没有"每个会话一行"这种东西，`''` 也不会匹配侧车里的
 * 任何记录（调用方据此得到空桶）。
 */
export function scopeKeyOfRow(
  row: { id: string; cwd?: string },
  mode: 'global' | 'session' | 'workspace',
): string {
  if (mode === 'global') return ''
  if (mode === 'workspace') {
    const workspace = workspaceScopeKeyOf(row.cwd)
    if (workspace !== undefined) return workspace
  }
  return row.id
}

// ── 记忆层用的工作区身份 ───────────────────────────────────────────────────

/** cwd → 项目根：向上找 `.git`（文件或目录），最多 8 层；找不到就用 cwd 自己。 */
const rootCache = new Map<string, string>()

export function workspaceRootOf(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const cached = rootCache.get(cwd)
  if (cached !== undefined) return cached
  let cur = cwd
  let found = cwd
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, '.git'))) { found = cur; break }
    const parent = dirname(cur)
    if (parent === cur || parent === '') break
    cur = parent
  }
  // 简单的上界：一个进程通常只碰几个项目，超过 256 条就整体清空（不做 LRU，代价不值得）。
  if (rootCache.size > 256) rootCache.clear()
  rootCache.set(cwd, found)
  return found
}

/**
 * 记忆层用的工作区键：**先向上收敛到 git root**，再派生 `ws:` 键。
 *
 * 为什么不复用 `workspaceScopeKeyOf`：它直接吃 cwd（「作用域」页的现有口径，改了会让存量的
 * 逐条开关全部失配）。记忆层是新数据，可以从一开始就用更稳的身份 —— 否则用户从 `/repo`
 * 进到 `/repo/src`，刚学的项目事实就"消失"了，而他只会认为"记忆丢了"。
 */
export function workspaceMemoryKeyOf(cwd: unknown): string | undefined {
  return workspaceScopeKeyOf(workspaceRootOf(cwd))
}
