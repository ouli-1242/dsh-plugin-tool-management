// ZIP 解包的限额层（无 I/O）：条目数、单条字节、解压后累计。
//
// 上传链路与整机迁移快照共用这一份。单条目与条目数都挡不住「2000 × 8 MiB」这种组合，
// 只有解压后累计量挡得住。
//
// ## 为什么按**实际解出**的字节计
//
// `unzipSync` 的 `filter` 里拿到的是档案自报的 `info.originalSize`（来自中央目录），
// 不是真实产出。一个谎报的档案 —— 申报 1 KiB、实际 8 MiB × 2000 条 —— 能让累计闸门
// 完全失效，一次性把 16 GiB 展开进内存；宿主与插件同进程，这会直接拖死宿主。
//
// 所以改用 fflate 的流式 `Unzip`：`file.ondata` 拿到的是**真正解出来的字节**，按它累加
// 单条与总量。超限的条目立刻停止收集（`terminate()` 只对实现了它的解码器生效，
// 因此**同时**靠分块喂数据来中断）—— `push()` 是同步的，一次喂 1 MiB 并在块与块之间
// 检查中止标记，CPU 与内存都被限住。
//
// 条目数上限仍在 `onfile` 里判：超了就不 `start()`，后续条目一个字节都不解。
//
// 已知边界：解压器本身仍会按压缩流解到超限点为止（这是"发现超限"的固有代价），
// 但超出的部分不再进内存，且总量一旦越界整份解包立即停止。

import { Unzip, UnzipInflate } from 'fflate'

/** 解压时被挡下的单个条目及原因。 */
export interface UnzipProblem { name: string; reason: string }

/** 解压的四道上限：条目数、单条字节、累计字节、来源名（报错用）。 */
export interface UnzipLimits {
  /** 档案内条目上限（含目录条目）。 */
  maxEntries: number
  /** 单个条目的解压后字节上限。 */
  maxEntryBytes: number
  /** 所有条目解压后的累计字节上限。 */
  maxTotalUncompressedBytes: number
  /** 条目数超限时回执里用的档案名（默认 `(zip)`）。 */
  sourceName?: string
}

/**
 * 一次喂给解压器的块大小。
 *
 * 为什么要分块：`Unzip.push()` 是同步的，一次喂完整份档案就等于"在发现超限之前先把
 * 它全解了"。1 MiB 让中止检查的粒度足够细（单块最多解出 1 MiB 量级），又不至于让
 * 每次 push 的固定开销成为负担。
 */
const PUSH_CHUNK_BYTES = 1024 * 1024

/**
 * 解包并丢弃超限条目；返回被丢弃的条目清单。
 *
 * 条目顺序与 `unzipSync` 的返回一致（档案内出现顺序）。超限的条目**不进** `entries`，
 * 并在 `problems` 里留一条 —— 静默丢弃会让用户以为「全都导入成功了」。
 *
 * @param bytes 整份 zip 字节
 * @param limits 四道上限
 * @returns `entries` 是放行的条目（路径 → 字节）；`problems` 是被挡下的条目与原因
 * @throws 解压器本身报错（压缩流损坏、未知压缩算法）时抛错，由调用方转成该文件 / 该域的失败回执
 */
export function unzipLimited(
  bytes: Uint8Array,
  limits: UnzipLimits,
): { entries: Record<string, Uint8Array>; problems: UnzipProblem[] } {
  const problems: UnzipProblem[] = []
  const sourceName = limits.sourceName || '(zip)'
  const entries: Record<string, Uint8Array> = Object.create(null)
  let count = 0
  let total = 0
  let totalReported = false
  let entriesReported = false
  /** 整份解包是否应当停止（条目数超限 / 累计超限）。 */
  let aborted = false
  /** 解压器自身的错误（压缩流损坏等）：喂完再抛，保持与 `unzipSync` 一致的失败语义。 */
  let decodeError: unknown = null

  const unzipper = new Unzip((file) => {
    if (aborted) return
    count += 1
    if (count > limits.maxEntries) {
      if (!entriesReported) {
        entriesReported = true
        problems.push({ name: sourceName, reason: `zip 内条目超过 ${limits.maxEntries} 个，其余条目已忽略` })
      }
      aborted = true
      return
    }
    // 目录条目：不占解压预算，但仍进 `entries`（与 `unzipSync` 的返回同形 —— 调用方
    // 按名字结尾的 `/` 自己跳过，`ops/snapshot.ts` 还用它数条目）。
    if (file.name.endsWith('/')) { entries[file.name] = new Uint8Array(0); return }
    // 自报大小已经越界 → 连解都不解（这一条只是省开销；真实判据是下面的实际字节）。
    if (typeof file.originalSize === 'number' && file.originalSize > limits.maxEntryBytes) {
      problems.push({ name: file.name, reason: `zip 内单条目超过 ${limits.maxEntryBytes >> 20} MiB，已跳过` })
      return
    }
    let size = 0
    let dropped = false
    const chunks: Uint8Array[] = []
    file.ondata = (err, chunk, final) => {
      if (err) { decodeError = err; aborted = true; return }
      if (dropped || aborted) return
      // `chunk` 在部分实现里可能是空视图（终止信号），按长度处理即可。
      const part = chunk && chunk.length ? chunk : null
      if (part !== null) {
        size += part.length
        if (size > limits.maxEntryBytes) {
          dropped = true
          problems.push({ name: file.name, reason: `zip 内单条目超过 ${limits.maxEntryBytes >> 20} MiB，已跳过` })
          return
        }
        total += part.length
        if (total > limits.maxTotalUncompressedBytes) {
          dropped = true
          aborted = true
          if (!totalReported) {
            totalReported = true
            problems.push({ name: file.name, reason: `zip 解压后合计超过 ${limits.maxTotalUncompressedBytes >> 20} MiB，该条目及其后条目已忽略` })
          }
          return
        }
        chunks.push(part)
      }
      if (final && !dropped) entries[file.name] = concatChunks(chunks, size)
    }
    try { file.start() } catch (e) { decodeError = e; aborted = true }
  })
  unzipper.register(UnzipInflate)

  for (let offset = 0; offset < bytes.length && !aborted; offset += PUSH_CHUNK_BYTES) {
    const end = Math.min(offset + PUSH_CHUNK_BYTES, bytes.length)
    unzipper.push(bytes.subarray(offset, end), end === bytes.length)
  }
  if (decodeError !== null) throw decodeError
  return { entries, problems }
}

/** 把若干块拼成一段（只有一块时直接返回，省一次拷贝）。 */
function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
