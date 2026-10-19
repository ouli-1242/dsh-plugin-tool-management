// 启动期对账框架（0.21.2）。
//
// 为什么需要它：插件此前**完全没有启动期对账** —— restoreSnapshot 只有两个调用点，
// 都在 scene-mode-set 里（archive-engine.ts 的 712 与 297），没有任何 boot 路径。后果是
// 两类「上个进程没干完」的状态会一直留着：
//   1. 记忆索引被隔离（memories-index.json 改名成 .corrupt-*）—— 隔离标记只活在进程内
//      的 corruptIndexes Map 里，重启即清零，而文件已不在原位，于是被当成「全新用户」，
//      第一次普通写入就把空索引落盘（0.21.2 审查实测）。
//   2. MCP 重启做了一半（阶段 1 停用已落盘、阶段 2 恢复没跑）—— 补丁里留下与「用户主动停用」
//      完全同形的 disabled: true，无标记可辨、无自愈路径。
//
// 三条硬规则（改这个文件前先读完）：
//   1. 幂等：每个 reconciler 连跑两次，第二次必须是 no-op。恢复写必须先比有效状态。
//   2. best-effort：单个 reconciler 失败只在兼容页留一条降级，绝不让 apply() 失败。
//   3. 顺序执行：不并发。索引守卫要先于 MCP 恢复（后者要写补丁，前者要护索引）。

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { clearMcpRestartMarker, processAlive, readMcpRestartMarker } from '../mcp/restart-marker.js'

/** 一条「上次没干完」的发现，供兼容页降级区与 state-doctor 共用。 */
export interface ReconcilerFinding {
  /** 稳定 id，界面与 noteRuntime 用它去重；同一个 id 重复出现只更新不新增。 */
  id: string
  label: string
  detail: string
  detailKey?: string
  params?: Record<string, unknown>
}

export interface BootReconciler {
  id: string
  label: string
  /** 幂等修复动作。抛错由调用方兜住。 */
  run(): Promise<void>
  /** 探测当前是否仍有未处理状态；state-doctor 复用它，不写第二份。 */
  probe?(): Promise<ReconcilerFinding[]>
}

const reconcilers: BootReconciler[] = []

/** 注册一个启动期 reconciler（插件 apply() 内调用，随后 runBootReconcilers()）。 */
export function registerBootReconciler(reconciler: BootReconciler): void {
  const existing = reconcilers.find((r) => r.id === reconciler.id)
  if (existing !== undefined) {
    // 同 id 重复注册（HMR 重放 apply）→ 覆盖而非追加，否则一次启动会跑两遍。
    Object.assign(existing, reconciler)
    return
  }
  reconcilers.push(reconciler)
}

/** 已注册的 reconciler（顺序即执行顺序）。 */
export function registeredReconcilers(): readonly BootReconciler[] {
  return reconcilers
}

/** 清空注册表。仅测试用 —— 生产环境一次 apply 一份。 */
export function resetBootReconcilers(): void {
  reconcilers.length = 0
}

/**
 * 跑一遍所有 reconciler。**永不抛错**。
 *
 * 单个失败只 warn 并继续：启动期对账是收尾，不是前置条件。因它让插件 apply 失败，
 * 等于把「上次的崩溃」升级成「这次起不来」—— 那是拿更重的代价换更轻的收益。
 */
export async function runBootReconcilers(): Promise<void> {
  for (const reconciler of reconcilers) {
    try {
      await reconciler.run()
    } catch (error) {
      console.warn('[dsh-plugin-tool-management] 启动期对账「' + reconciler.label + '」失败：' + String((error as Error)?.message ?? error))
    }
  }
}

/**
 * 收集所有 reconciler 的探测结果（best-effort，单个失败只 warn）。
 * 供 state-doctor 与兼容页降级区共用 —— 两处都不自己写探测逻辑。
 */
export async function collectReconcilerFindings(): Promise<ReconcilerFinding[]> {
  const findings: ReconcilerFinding[] = []
  for (const reconciler of reconcilers) {
    if (reconciler.probe === undefined) continue
    try {
      findings.push(...(await reconciler.probe()))
    } catch (error) {
      console.warn('[dsh-plugin-tool-management] 探测「' + reconciler.label + '」失败：' + String((error as Error)?.message ?? error))
    }
  }
  return findings
}
// ── MCP 重启收尾（0.21.2）───────────────────────────────────────────────────
//
// 恢复口径：**重新算，不照抄快照**。重启前状态不在标记里（刻意不存，见 restart-marker.ts 的
// 文件头），所以从「阶段 1 写之前那份补丁备份」反推 —— writePatch 每次改前都会留一份
// .bak-<stamp> 在 hub/backups/（KEEP=5），阶段 1 之前的那份就是重启前的真相。
//
// 四条防线，缺一条都不自动恢复：
//   ① 标记存在且 shape 合法；
//   ② 记录的 pid **已经死了** —— 活着说明那次重启可能还在正常跑（重启要 ~11s），
//      此刻插进去改补丁会和它竞态；
//   ③ 阶段 1 的强制停用**确实是当前生效值** —— 不是就说明已经有人动过它
//      （用户显式改的、或上一次收尾成功了），别按推断写回；
//   ④ 备份读得到、且那份里该条目的生效值 ≠ 当前值。

/** 备份目录里某个层级的补丁备份（按时间倒序，最新在前）。 */
function listPatchBackups(dir: string, level: 'global' | 'project'): Array<{ abs: string; stamp: string }> {
  try {
    const tag = level === 'global' ? '.global' : '.profile-'
    return readdirSync(dir)
      .filter((name) => name.startsWith('cordis.patch.yml' + tag) && /\.bak-\d{8}-\d{6}(\d{6})?$/.test(name))
      .map((name) => ({ abs: join(dir, name), stamp: /\.bak-(\d{8}-\d{6}(?:\d{6})?)$/.exec(name)?.[1] ?? '' }))
      .filter((row) => row.stamp !== '')
      .sort((a, b) => (a.stamp < b.stamp ? 1 : -1))
  } catch { return [] }
}

export interface McpRestartRecoveryDeps {
  /** 读某个补丁 id 的**当前**生效停用值。 */
  isRowDisabled(id: string, level: 'global' | 'project'): Promise<boolean>
  /** 把该条目显式设成 enabled / disabled（走 mcpmSetEnabled 的语义：先清覆盖块再按需补）。 */
  setRowEnabled(id: string, level: 'global' | 'project', enabled: boolean): Promise<void>
  /** 备份目录（hub/backups/）。 */
  backupDir(): string
  /** 读补丁备份原文。 */
  readBackup(abs: string): Promise<string>
  /** 从补丁原文里取某个 id 的生效停用值；解析不了返回 null。 */
  effectiveDisabledIn(content: string, id: string): boolean | null
}

/**
 * 跑一次 MCP 重启收尾。返回做了什么（无标记 / pid 还活着 / 已一致 / 已恢复 / 无法判断）。
 * **永不抛错**：启动对账不能拖垮 apply()。
 */
export async function reconcileMcpRestart(deps: McpRestartRecoveryDeps): Promise<string> {
  const marker = await readMcpRestartMarker()
  if (marker === null) return 'no-marker'
  // ② pid 还活着 → 那次重启可能还在跑，别动它的补丁。
  if (processAlive(marker.pid)) return 'pid-alive'
  const level = marker.level
  let current: boolean
  try { current = await deps.isRowDisabled(marker.server, level) } catch (e) {
    console.warn('[dsh-plugin-tool-management] MCP 重启收尾：读不到当前生效状态，跳过：' + String((e as Error)?.message ?? e))
    return 'read-failed'
  }
  // ③ 已经不是「强制停用」那个值了 → 有人动过（用户显式改 / 上一次收尾已成功）。只清标记。
  if (!current) { await clearMcpRestartMarker(); return 'already-changed' }
  // ④ 从备份反推重启前的状态。
  const backups = listPatchBackups(deps.backupDir(), level)
  let beforeDisabled: boolean | null = null
  for (const backup of backups) {
    try {
      beforeDisabled = deps.effectiveDisabledIn(await deps.readBackup(backup.abs), marker.server)
    } catch { beforeDisabled = null }
    if (beforeDisabled !== null) break
  }
  if (beforeDisabled === null) {
    console.warn(
      '[dsh-plugin-tool-management] MCP 重启收尾：补丁备份里读不到「' + marker.server + '」的重启前状态，'
      + '已保留现场（该服务当前为停用态）。可到 hub/backups/ 手工核对后重试。',
    )
    return 'unknown-before'
  }
  if (beforeDisabled === current) { await clearMcpRestartMarker(); return 'already-consistent' }
  try {
    await deps.setRowEnabled(marker.server, level, !beforeDisabled)
  } catch (e) {
    console.warn('[dsh-plugin-tool-management] MCP 重启收尾：写回失败：' + String((e as Error)?.message ?? e))
    return 'write-failed'
  }
  await clearMcpRestartMarker()
  console.warn(
    '[dsh-plugin-tool-management] MCP 重启收尾：「' + marker.server + '」上次重启中断在阶段 1，'
    + (beforeDisabled ? '它重启前就是停用态' : '已按重启前的启用状态恢复'),
  )
  return beforeDisabled ? 'was-disabled' : 'restored'
}
