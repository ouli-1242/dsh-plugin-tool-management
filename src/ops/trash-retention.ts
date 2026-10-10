// 回收站保留期的两条 op（0.19.1）。
//
//   trash-retention-get  只读：当前保留期天数（`0` = 永久保留）
//   trash-retention-set  写：改保留期，成功后**立即扫一次**（与 `history-retention-set` 同一条）
//
// 与 `history-retention-get/set` 逐字同形（ops/sessions.ts:599-618）：同一个
// `retentionDays` 入参、同一条「非负整数」校验、同一条「改完立刻扫，让界面反映新策略」。
// 两处保留期是同一个功能出现在两个页面，回执形状分家的话，客户端就得写两套解析。
//
// 读侧为什么是纯读：客户端 boot 时必问一次，用来渲染下拉框的当前值。那一次不能要令牌，
// 否则没配令牌的宿主上这一格永远是空的（与 `slash-settings` 同一条理由）。

import type { TrashSweepResult } from '../trash-retention.js'

export interface TrashRetentionOpsDeps {
  read(): Promise<{ retentionDays: number }>
  write(retentionDays: number): Promise<void>
  /** 保留期改完后立刻扫一次（`retentionDays = 0` 时是纯 no-op）。 */
  sweep(): Promise<TrashSweepResult>
}

export function buildTrashRetentionOps(
  deps: TrashRetentionOpsDeps,
): Record<string, (args: any) => Promise<any>> {
  return {
    'trash-retention-get': async () => {
      const { retentionDays } = await deps.read()
      return { ok: true, retentionDays }
    },
    'trash-retention-set': async (args: any) => {
      const days = Number((args && args.retentionDays) ?? -1)
      // 错误文案承诺的是「非负整数」，就按整数校验：1.5 这类小数以前在 History 页会被
      // 静默取整成 1，用户看到的回执与输入不符。这里用同一道判据。
      if (!Number.isSafeInteger(days) || days < 0) {
        return {
          ok: false,
          code: 'error.trash.retention.invalid',
          error: `retentionDays 需为非负整数（0=永久保留），收到: ${String((args && args.retentionDays))}`,
          params: { value: String((args && args.retentionDays)) },
        }
      }
      try {
        await deps.write(days)
      } catch (e) {
        return {
          ok: false,
          code: 'error.trash.retention.writeFailed',
          error: `写入保留期失败: ${String((e as Error)?.message ?? e)}`,
          params: { reason: String((e as Error)?.message ?? e) },
        }
      }
      // 设置变更后立即扫一次：界面上的条目数要与新策略一致，不能等到 6 小时后的下一轮。
      // 清扫自己吞异常（见 createTrashRetentionDomain），所以这里不会因为删除失败而回滚设置
      // —— 设置已经写进侧车了，如实回执「已保存，清理时 N 项失败」比报一个假失败诚实。
      const res = await deps.sweep()
      return {
        ok: true,
        retentionDays: days,
        // 回执带上这次实际清掉的数量：用户改完设置马上想知道「清掉了什么」，
        // 而 `failed > 0` 说明有条目删不掉（IO 错误），要能说出来而不是假装干净。
        swept: res.swept.length,
        failed: res.failed,
      }
    },
  }
}
