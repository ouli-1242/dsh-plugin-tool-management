// 系统回收站：永久删除前的最后一道保险（Win 走 PowerShell、macOS 移进 ~/.Trash、Linux 用 gio）。
//
// 从 skills/service.ts 整段搬来，一行未改。这一层只跟外部进程打交道，不认识技能也不碰状态；
// 外部命令一律带超时上限，失败返回 false 而不是抛出 —— 调用方据此决定要不要继续真删。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { isSameOrDescendant, isValidSegment } from '../paths.js'
import { permanentlyDeleteTrash, trashRootPath } from './core.js'

// ── 系统回收站（永久删除的最后一道保险） ──────────────────────────────────

/**
 * 外部进程（PowerShell / gio）的超时上限。这些调用在技能的**写队列**里被 await
 * （skill-trash-delete），进程一旦挂起，该域全部写操作会永久停摆且无任何提示 ——
 * 回收站 API 在文件被占用、系统弹窗等情况下确实会挂住。超时后杀掉进程并返回 false，
 * 让调用方按既有的「回收站失败 → 硬删除」兜底走下去，队列得以继续。
 */
export const EXTERNAL_CMD_TIMEOUT_MS = 30_000

export function runQuietly(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      resolve(ok)
    }
    let child: any
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      finish(false)
      return
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 进程可能已自行退出 */ }
      finish(false)
    }, EXTERNAL_CMD_TIMEOUT_MS)
    child.on('error', () => finish(false))
    child.on('close', (code: number) => finish(code === 0))
  })
}

export function psQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Win → 回收站；macOS → ~/.Trash；Linux → gio trash。失败返回 false。 */
export async function moveToSystemTrash(abs: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(" + psQuote(abs) + ", 'OnlyErrorDialogs', 'SendToRecycleBin')",
      ].join('; ')
      return await runQuietly('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    }
    if (process.platform === 'darwin') {
      await rename(abs, join(homedir(), '.Trash', basename(abs) + '-' + Date.now()))
      return true
    }
    return await runQuietly('gio', ['trash', abs])
  } catch {
    return false
  }
}

/**
 * 永久删除回收站条目：先尝试系统回收站（用户仍可在系统里找回），
 * 失败才落到 core 的硬删除 —— 让「永久删除」也不会静默丢数据。
 */
export async function permanentlyDeleteTrashSafely(
  id: string,
  log: (event: string, detail?: unknown) => Promise<void>,
): Promise<any> {
  const clean = String(id || '').trim()
  const root = trashRootPath()
  // 走 `paths.ts` 的单段名校验，而不是自写白名单（审查 F1，0.17.0）：
  // 原判据 `/^[A-Za-z0-9._-]{1,128}$/` 放行 `.` 与 `..`，而 `root + sep + '..'` 解析后
  // 正是**回收站根目录**，末尾那句字符串前缀比对拦不住它 —— 于是「删掉某一条」变成
  // 「把整个 `trash/`（技能/场景/子智能体/提示词四类）送进系统回收站」，且返回 `ok:true`。
  // 换成 `isValidSegment` 还让两条路同源：能通过这里的 id，必定也能通过
  // `permanentlyDeleteTrash` 内部的 `entryPath`（同一个谓词），不会一个放行、一个拒绝。
  const target = isValidSegment(clean) ? join(root, clean) : null
  if (target && isSameOrDescendant(root, target) && existsSync(target)) {
    if (await moveToSystemTrash(target)) {
      await log('trash-delete-system', { id: clean, path: target })
      return { id: clean, method: 'system-trash' }
    }
  }
  return permanentlyDeleteTrash(clean, log)
}