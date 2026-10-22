// 并发编辑的「内容指纹」判据（0.21.2 Phase 4）。
//
// 问题：两个窗口同时打开同一份记忆 / 提示词 / 补丁，后保存的那一份会把前一份的改动整份覆盖。
// 文件锁只能防同进程的两条路径，防不住外部编辑器 —— 所以判据必须是**内容**：读的时候给一份
// 指纹，写的时候核对指纹还在不在。
//
// 为什么不用 mtime：拷贝、同步盘回写、`touch` 都会改 mtime 而不改内容；反过来，某些工具
// 会保留 mtime 而改内容。内容 hash 没有这两种误判。
//
// `expectedStamp` 是**可选**参数：不带 = 回到旧行为（不校验）。这样旧客户端、脚本、
// 模型工具都不受影响，只有界面在编辑弹窗里主动带。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const STALE_WRITE_CODE = 'stale-write'

export interface StaleWriteResult {
  ok: false
  code: typeof STALE_WRITE_CODE
  error: string
  current: { stamp: string | null }
}

/** 内容指纹：sha256 前 16 位。`null` / `undefined` 表示"文件不存在"。 */
export function stampOfText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 文件指纹：不存在返回 `null`；其它读失败抛错（调用方按失败处理，不静默放行）。 */
export async function stampOf(abs: string): Promise<string | null> {
  try {
    return stampOfText(await readFile(abs, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw e
  }
}

/** 规范化客户端传来的 `expectedStamp`：非字符串 / 空串 = 没带。 */
export function normalizeStamp(expected: unknown): string | null {
  if (typeof expected !== 'string') return null
  const s = expected.trim()
  return s === '' ? null : s
}

export function staleWriteResult(current: string | null): StaleWriteResult {
  return {
    ok: false,
    code: STALE_WRITE_CODE,
    error: '文件已在别处被修改，本次保存没有写入。请重新加载后再改，或选择覆盖保存。',
    current: { stamp: current },
  }
}

/**
 * 比对指纹：一致 / 没带 = `null`（继续写）；不一致 = 冲突回执。
 * 调用方直接 `return conflict` 即可，回执形状与其余 op 的失败一致。
 */
export function stampConflict(current: string | null, expected: unknown): StaleWriteResult | null {
  const want = normalizeStamp(expected)
  if (want === null) return null
  return want === current ? null : staleWriteResult(current)
}

export class StaleWriteError extends Error {
  readonly code = STALE_WRITE_CODE
  readonly current: string | null

  constructor(current: string | null) {
    super('文件已在别处被修改，本次保存没有写入。')
    this.name = 'StaleWriteError'
    this.current = current
  }
}

/** 抛错版：给没有结构化回执通道的写路径用。 */
export async function assertStamp(abs: string, expected: unknown): Promise<void> {
  const want = normalizeStamp(expected)
  if (want === null) return
  const current = await stampOf(abs)
  if (current !== want) throw new StaleWriteError(current)
}
