// 「无法自动验证」清单：兼容页把绿行当成「验证过」是危险的 —— 很多契约只能确认名字还在，
// 时序、返回值形状与真实渲染必须人工核对。这份清单随兼容状态 JSON 返回，供诊断使用；页面
// 不展示。
import type { HostModuleContract } from './host-contracts.js'
import type { ManualReviewItem } from './probe-types.js'

/** 能力表里那些探针只能核对成员存在、核对不了语义的项。 */
const CAPABILITY_MANUAL_REVIEWS: readonly ManualReviewItem[] = [
  {
    id: 'agent.created-event',
    label: '子代理创建时序',
    detail: '只能确认 agent 作用域的 on() 还在；agent/created 监听是否仍串行、工具限制是否在子代理首轮之前生效，无法在探测里验证。',
  },
  {
    id: 'sandboxPolicy.resolve',
    label: '沙箱策略语义',
    detail: '探测会用 read-only 请求核对返回的 mode / workspaceRoot 形状；真实写入时宿主是否按这份策略放行 / 拒绝，仍要在实际写补丁时确认。',
  },
  {
    id: 'official-skill-assets',
    label: '官方技能资产',
    detail: '只能核对 office / sandbox 资产目录与 SKILL.md 存在；正文语义、LibreOffice Kit 命令是否真能执行，仍需实际调用技能确认。',
  },
  {
    id: 'mcp-client.config-schema',
    label: 'MCP 配置 schema',
    detail: '只能核对官方 schema 仍接受插件写出的 8 个配置键；补丁写入后宿主是否真的建立连接，仍要看 MCP 页的实际状态。',
  },
  {
    id: 'projection-title-disk',
    label: '标题缓存磁盘布局',
    detail: '只能核对 JSON 后端的 per-record 标记与 title / titleInput 投影键；本机实际存储根与后端是否一致、旧记录能否读回，仍需看真实会话列表。',
  },
]

/**
 * 把契约清单上的 `manual` 说明并进同一份视图。
 *
 * 契约级说明以包名为 id：同一份清单既给页面，也给 doctor 的 JSON，避免两处各写一份
 * 「哪些东西没验证」。
 *
 * @param contracts 运行时 / 行为 / 客户端三份契约清单（可重复传入同一包）。
 * @returns 去重后的待人工核对项（按 id）。
 */
export function manualReviewItems(contracts: readonly HostModuleContract[]): ManualReviewItem[] {
  const out: ManualReviewItem[] = []
  const seen = new Set<string>()
  const add = (item: ManualReviewItem): void => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    out.push(item)
  }
  for (const contract of contracts) {
    if (contract.manual === undefined || contract.manual === '') continue
    add({ id: contract.package, label: contract.feature, detail: contract.manual })
  }
  for (const item of CAPABILITY_MANUAL_REVIEWS) add(item)
  return out
}
