// 插件 HTTP 路由的请求栅栏。
//
// 为什么需要它：宿主的 BrowserAuth 栅栏**只包在宿主自己注册的路由上**
// （dsh-client-connection 的 register()/upgrade、dsh-api-gateway、
// dsh-host-open-in-app），dsh-host-webserver 本身没有全局中间件。宿主生态的
// 既定约定是每个注册方自己调 `connection.requestRejection(req)`，它做两件事：
//
//   1. Host/Origin 栅栏 —— Host 必须是回环地址、deployment 派生的 LAN IP 字面量
//      或声明的 trustedHosts。Host 是 DNS rebinding 唯一伪造不了的头：攻击者
//      控制域名 → 浏览器发 `Host: evil.com`，但插件的自比对式 Origin 检查
//      （origin.host === host）会同时成立，于是被误判为同源。
//   2. browser-session cookie 鉴权（HttpOnly + SameSite=Strict，Path=/）。
//
// 只查公开常量 `x-dsh-plugin` 与自比对 Origin 等于没鉴权：本机任意进程都能调写 op，
// 而写 op 里包含 `mcpm-add`（command/args 无白名单，宿主 stdio 传输会 spawn 它
// → 任意命令执行）与 `history-delete`（永久删除会话）。

export interface FenceRequest {
  headers?: Record<string, string | string[] | undefined>
}

export interface FenceRejection {
  status: number
  error: string
}

/** 宿主 connection 服务的最小结构面。 */
export interface ConnectionSeam {
  requestRejection?(req: unknown): number | undefined
}

const headerValue = (req: FenceRequest, name: string): string => {
  const v = req.headers?.[name]
  return Array.isArray(v) ? v[0] ?? '' : v ?? ''
}

/**
 * 判定请求是否应被拒（返回 null = 放行）。
 *
 * 优先用宿主栅栏；它不在场时（非 web 组合、服务未注册）退回等价的本地判定，
 * 而不是静默放行。栅栏自身抛错时同样退回本地判定 —— 宁可拒绝也不要因为宿主
 * 内部变动而变成开放路由。
 *
 * @param req - Node 请求对象（只读 headers）。
 * @param connection - ctx.get('connection')，可缺失。
 */
export function fenceRejection(req: FenceRequest, connection?: ConnectionSeam): FenceRejection | null {
  try {
    const rejection = connection?.requestRejection?.(req)
    if (typeof rejection === 'number') {
      return {
        status: rejection,
        error: rejection === 401
          ? '未通过宿主的浏览器鉴权：请在 DSH Web GUI 内操作，或为本插件配置访问令牌（config.token / DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）'
          : 'Host/Origin 栅栏拒绝：该请求不是发往本机地址的同源请求',
      }
    }
    // 栅栏在场且未返回拒绝码 ⇒ 已通过，不再叠加本地判定（宿主的 trustedHosts
    // 部署信息这里拿不到，重复判定只会更松或更严，都不对）。
    if (typeof connection?.requestRejection === 'function') return null
  } catch (e) { /* 见上方说明：退回本地判定 */ }

  const hostHdr = headerValue(req, 'host')
  let host: URL
  try { host = new URL('http://' + hostHdr) } catch { return { status: 403, error: 'Host 头缺失或无法解析' } }
  const loopback = host.hostname === 'localhost' || host.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host.hostname)
  if (!loopback) return { status: 403, error: 'Host 必须是本机回环地址（防 DNS rebinding）' }
  if (headerValue(req, 'sec-fetch-site') === 'cross-site') return { status: 403, error: '跨站请求被拒' }
  const origin = headerValue(req, 'origin')
  if (origin) {
    try {
      if (new URL(origin).host !== host.host) return { status: 403, error: '跨源请求被拒' }
    } catch { return { status: 403, error: 'Origin 头无法解析' } }
  }
  return null
}

// ── 明文机密 op 的令牌门禁 ────────────────────────────────────────────────────
//
// `mcpm-reveal` / `mcpm-export` 会把 env / headers 里的凭据**原文**交出去。它们曾经
// 与普通读操作同一条路：令牌配了才校验，没配就只靠宿主栅栏（Host/Origin + 浏览器
// session cookie）。问题是"能打开 GUI"就等于能取走全部密钥 —— 而 token 的描述里写着
// 它是"最后一道防线"，防线却可以不存在。这里把口径改成：**没有令牌就没有明文**。
//
// 为什么不用同源 Origin 顶替：同源只证明"请求来自本机页面"，不证明"读的人被授权"；
// 明文凭据要的是后者。配了令牌的本地工具（无 Origin）仍然放行，那是显式凭证。

export interface SecretGateState {
  /** 宿主是否配置了访问令牌（config.token / DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）。 */
  tokenConfigured: boolean
  /** 请求带的 x-dsh-token 是否与宿主令牌一致。 */
  tokenAccepted: boolean
}

export interface SecretGateRejection {
  code: string
  error: string
}

/**
 * 判定敏感 op 是否应被拒（返回 null = 放行）。
 *
 * 两种情况分开报，因为处置方式不同：没配令牌要去宿主配置里加，配了但没带/带错
 * 只要在界面里填对即可（界面按 code 决定给不给输入框）。
 */
export function secretOpRejection(state: SecretGateState): SecretGateRejection | null {
  if (!state.tokenConfigured) {
    return {
      code: 'error.secret.noToken',
      error: '明文查看与导出已被禁用：宿主未配置访问令牌。请在本插件配置里加 token（或设环境变量 DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）后重启 DSH，再在界面上填入同一个令牌。',
    }
  }
  if (!state.tokenAccepted) {
    return {
      code: 'error.secret.badToken',
      error: '访问令牌缺失或不正确：请在界面里填入与宿主配置相同的令牌（随请求以 x-dsh-token 发送）。',
    }
  }
  return null
}
