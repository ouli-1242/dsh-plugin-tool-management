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
