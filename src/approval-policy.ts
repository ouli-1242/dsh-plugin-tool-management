// 审批策略预检（宿主端）。
//
// 背景：DSH 的审批策略是「会话级 fold + 全局默认」两级（dsh-user-approval：
// effectivePolicy(session) = overrideOf(session) ?? config.policy ?? 'ask'），
// 「完全权限」预设写的是**会话级** approval/policy fold（dsh-permission-presets
// 调 approval.setPolicy(agent, 'never')）。此时 ask 会在审批层被自动判成
// rejected（fail-closed），插件的确认门永远等不到确认卡，模型只看到一句
// 无信息量的「用户拒绝」。这里把 never 预检出来，换成可行动报错。
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

/** never 会话里确认门无法弹出时给模型的可行动报错。 */
export function neverPolicyHint(what: string): string {
  return `${what}：当前会话审批策略为 never（完全权限模式会自动拒绝一切需确认的操作，不会弹确认卡）。` +
    '请把访问模式切换为「工作区内修改」后重试，或在插件设置里关闭对应确认开关（requireConfirmForModel*）。'
}

/**
 * 判断本次工具调用的会话是否处于 never 审批策略。
 *
 * 任一步不可用（无 approval 服务、无 agent/session、读取抛错）都返回 false：
 * 预检只做「提前给可行动报错」，绝不代替审批层放行或拒绝。
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
