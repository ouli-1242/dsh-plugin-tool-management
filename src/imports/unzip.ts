// ZIP 解包的限额层（无 I/O）：条目数、单条字节、解压后累计。
//
// 上传链路与整机迁移快照共用这一份。单条目与条目数都挡不住「2000 × 8 MiB」这种组合，
// 只有解压后累计量挡得住；而 `unzipSync` 一旦放行就会把内容实体化进内存，所以判断必须
// 在 `filter` 里完成（fflate 在 inflate 之前调用 filter）。
//
// 已知前提：信任档案自报的 `info.originalSize`（fflate 不独立约束输出长度）。谎报只能让
// 解压产物比申报的大，不会绕过条目数 / 单条上限；累计量仍以申报值为准。
import { unzipSync } from 'fflate'

export interface UnzipProblem { name: string; reason: string }

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
 * 解包并丢弃超限条目；返回被丢弃的条目清单。
 * 解压本身失败会抛错，由调用方转成该文件 / 该域的失败回执。
 */
export function unzipLimited(
  bytes: Uint8Array,
  limits: UnzipLimits,
): { entries: Record<string, Uint8Array>; problems: UnzipProblem[] } {
  const problems: UnzipProblem[] = []
  const sourceName = limits.sourceName || '(zip)'
  let count = 0
  let uncompressed = 0
  let totalReported = false
  const entries = unzipSync(bytes, {
    filter(info) {
      count += 1
      // 被 filter 丢掉的条目必须回报：静默丢弃会让用户以为「全都导入成功了」。
      if (count > limits.maxEntries) {
        if (count === limits.maxEntries + 1) {
          problems.push({ name: sourceName, reason: `zip 内条目超过 ${limits.maxEntries} 个，其余条目已忽略` })
        }
        return false
      }
      if (!info.name.endsWith('/') && info.originalSize > limits.maxEntryBytes) {
        problems.push({ name: info.name, reason: `zip 内单条目超过 ${limits.maxEntryBytes >> 20} MiB，已跳过` })
        return false
      }
      if (!info.name.endsWith('/')) {
        uncompressed += info.originalSize
        if (uncompressed > limits.maxTotalUncompressedBytes) {
          if (!totalReported) {
            totalReported = true
            problems.push({ name: info.name, reason: `zip 解压后合计超过 ${limits.maxTotalUncompressedBytes >> 20} MiB，该条目及其后条目已忽略` })
          }
          return false
        }
      }
      return true
    },
  })
  return { entries, problems }
}
