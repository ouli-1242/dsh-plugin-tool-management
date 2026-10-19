// MCP 重启做了一半的状态标记（0.21.2）。
//
// 为什么必须有它：`mcpm-restart` 是**两段写**——阶段 1 强制停用并落盘，等 loader 反映
// （最多 ~11s），阶段 2 再按重启前的状态写回。补丁里阶段 1 落下的 `disabled: true` 与
// 「用户主动停用」**完全同形**：同一行内容、同一份文件、同一个生效值。于是进程在这 ~11s
// 里被杀（崩溃 / 断电 / 用户手动重启 DSH），那个服务器就永远停在停用态，而没有任何代码、
// 任何界面能把它与「用户自己关的」区分开 —— 用户看到的是「重启了一下，服务器再也回不来」。
//
// 标记只回答一个问题：**这次重启有没有干完**。它记 server/level/phase/at/pid/bootId 六个字段：
//   · server / level  哪个 id、哪张补丁（恢复只需要这两个 + 重新算有效状态）
//   · phase   1 = 已强制停用、等 loader；2 = 正在写回；3 = 已写回
//   · at      哪个时刻
//   · pid     写下这个标记的进程 —— 它**还活着就什么都不做**（重启可能还在正常跑）
//   · bootId  插件的本次启动 id，用于识别「同一轮启动内的重放」
//
// 刻意**不存**重启前的完整有效状态：那要求在阶段 1 之前把两张补丁全读一遍并存档，而恢复时
// 一样要重新读一遍才敢写（磁盘上可能已经变了）。存快照只会多一处会过期的真相源 ——
// 所以恢复走「重新算」（见 boot/reconcile.ts 的 reconcileMcpRestart）。

import { readFileSync, renameSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../memories/index-io.js'
import { hubPath } from '../hub.js'

/** 标记文件名（hub 根）。 */
export const MCP_RESTART_STATE_FILE = 'mcp-restart-state.json'

export type McpRestartPhase = 1 | 2 | 3

export interface McpRestartMarker {
  v: 1
  /** 卡住的那个补丁条目 id。 */
  server: string
  /** global / project —— 决定动哪张补丁。 */
  level: 'global' | 'project'
  phase: McpRestartPhase
  /** 写下这个标记的毫秒时间戳。 */
  at: number
  /** 写下这个标记的进程 pid。 */
  pid: number
  /** 插件本次启动的 id（同 index.ts 的 BOOT_ID）。 */
  bootId: string
}

/** 标记文件绝对路径。 */
export function mcpRestartMarkerPath(): string {
  return hubPath(MCP_RESTART_STATE_FILE)
}

/**
 * 写标记（**原子写**，best-effort）。
 *
 * 失败不改变重启本身是否进行 —— 它只是"崩溃后没有人来收尾"的保险。所以 catch 后只 warn。
 */
export async function writeMcpRestartMarker(marker: Omit<McpRestartMarker, 'v' | 'at'>): Promise<void> {
  try {
    const path = mcpRestartMarkerPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomically(
      path,
      JSON.stringify({ v: 1, at: Date.now(), ...marker } satisfies McpRestartMarker, null, 2),
    )
  } catch (e) {
    console.warn(
      `[dsh-plugin-tool-management] MCP 重启标记写入失败（进程若中断将无法自动收尾）：`
      + `${String((e as Error)?.message ?? e)}`,
    )
  }
}

/** 读标记；不存在 / 读不出 / 形状不对 → `null`（一律不猜）。 */
export async function readMcpRestartMarker(): Promise<McpRestartMarker | null> {
  try {
    const obj = JSON.parse(await readFile(mcpRestartMarkerPath(), 'utf8')) as Partial<McpRestartMarker>
    if (!obj || typeof obj !== 'object') return null
    if (typeof obj.server !== 'string' || obj.server === '') return null
    const level = obj.level === 'project' ? 'project' : 'global'
    const phase = obj.phase === 2 || obj.phase === 3 ? obj.phase : 1
    return {
      v: 1,
      server: obj.server,
      level,
      phase,
      at: Number.isFinite(obj.at) ? Number(obj.at) : 0,
      pid: Number.isFinite(obj.pid) ? Number(obj.pid) : 0,
      bootId: typeof obj.bootId === 'string' ? obj.bootId : '',
    }
  } catch { return null }
}

/** 同步版：探测链（state-doctor、守卫 probe）里不能 await。读不到就当作没有。 */
export function hasMcpRestartMarker(): boolean {
  try {
    readFileSync(mcpRestartMarkerPath(), 'utf8')
    return true
  } catch { return false }
}

/** 清掉标记（重启正常跑完之后）。不存在就算了。 */
export async function clearMcpRestartMarker(): Promise<void> {
  await rm(mcpRestartMarkerPath(), { force: true }).catch(() => undefined)
}

/**
 * 进程是否还活着（同机）。
 *
 * `pid <= 0`（老标记 / 读不出来）按**活着**处理 —— 那种情况下自动恢复才是最危险的分支
 * （可能在一次正常的重启中途插进去改补丁）。宁可漏一次自动恢复（用户手动重启即可），
 * 也不要在一个未知进程可能正持有写锁时动它的文件。
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    // EPERM = 进程存在但不在同一个用户下 → 活着；ESRCH = 真的没有。
    return code === 'EPERM'
  }
}

/** 留一份坏标记便于事后核对（与索引隔离同思路）。 */
export function quarantineMcpRestartMarker(): void {
  try { renameSync(mcpRestartMarkerPath(), `${mcpRestartMarkerPath()}.corrupt-${Date.now()}`) } catch { /* 没有就算了 */ }
}
