// 审批策略探测（宿主端）：确认门在「完全权限」会话里该怎么行为。
//
// 背景：DSH 的审批策略是「会话级 fold + 全局默认」两级（dsh-user-approval：
// effectivePolicy(session) = overrideOf(session) ?? config.policy ?? 'ask'），
// 「完全权限」预设写的是**会话级** approval/policy fold（dsh-permission-presets
// 调 approval.setPolicy(agent, 'never')，预设自述 "without approval prompts"）。
//
// 口径（2026-09-13 用户裁定，方案 B）：**never = 用户在预设层面已预先批准一切确认门**。
// 因此插件的三个确认门在 never 会话里直接放行（并写插件审计日志留痕），不再把 ask
// 交给审批层——宿主 ApprovalService.decide() 对 never 直接返回 rejected（fail-closed），
// 确认卡永远不会弹出，模型只会收到一句无信息量的「用户拒绝」。这也与 DSH 官方子代理
// 工具（dsh-tool-subagent 无 ask 门）在完全权限下的行为一致。
// 注意这是**插件自定策略**，与宿主 decide() 的 never=自动拒 相反，属有意选择：
// 插件确认门的语义是「问用户」，而用户已在会话层面声明「不要再问我」。
//
// 读取链的关键约束：**必须用 ctx.get('approval')，不能用 ctx.approval**。
// 本插件的 inject 未声明 approval，cordis 的上下文代理会沿 fiber 链找 provider，
// 找不到就抛 `cannot get property "approval" without inject`；旧实现把它写在
// try/catch 里，异常被吞成 false，于是 never 会话里永远走 ask 分支（2026-09-13
// 19:52 会话实测到的 bug）。dsh-tools 自己拿这条缝也是 `this.ctx.get("approval")`
// （dsh-tools/lib/index.js `serviceAsk`），且它的 inject 同样只有 systemPrompt
// ——可作对照。回归测试见 test/approval-policy.test.mjs。

/** 审批服务缝的最小结构面（真实实现是 dsh-user-approval 的 ApprovalService）。 */
export interface ApprovalSeam {
  /** 会话的有效策略：会话 fold 优先，其次全局默认。 */
  effectivePolicy?(session: unknown): string | undefined
  /** 全局默认策略（插件配置）。 */
  config?: { policy?: string } | undefined
}

/**
 * 判断本次工具调用的会话是否处于 never 审批策略（= 完全权限，确认门应直接放行）。
 *
 * 任一步不可用（无 approval 服务、无 agent/session、读取抛错）都返回 false：
 * 探测失败一律退回正常问询流程，绝不代替审批层做放行决定。
 */
export function isApprovalNever(ctx: unknown, exec: unknown): boolean {
  try {
    const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get
    if (typeof get !== 'function') return false
    const approval = get.call(ctx, 'approval') as ApprovalSeam | undefined
    if (!approval) return false
    const session = (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session
    if (session !== undefined && typeof approval.effectivePolicy === 'function') {
      return approval.effectivePolicy(session) === 'never'
    }
    return approval.config?.policy === 'never'
  } catch {
    return false
  }
}
