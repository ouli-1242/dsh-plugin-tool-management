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
 * 优先用宿主栅栏；它不在场时（非 web 组合、服务未注册）退回**本地最小判定**，而不是静默放行。
 * 栅栏自身抛错时同样退回本地判定 —— 但这句**不是**"宁可拒绝"：本地链不含 cookie 鉴权，
 * 于是丢掉的恰好是宿主栅栏比本地判定多出来的那一层。无 Origin 的非浏览器请求只要带上
 * `Host: localhost` 就能过（本机任意进程都做得到），而写 op 里包含 `mcpm-add`（宿主 stdio
 * 传输会按 command/args spawn 它）与 `history-delete`（永久删除会话）。
 * 准确的说法是：退回一个**不依赖宿主内部**的判定 —— 仍要求回环 Host，但没有会话凭证。
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
// 它是"最后一道防线"，防线却可以不存在。所以 2026-09-18 把口径改成：**没有令牌就没有明文**。
//
// 2026-09-19 用户裁定收回前半条：**没配令牌时不该设防**。理由是那道门没有出路 ——
// 用户点「显示密钥」只拿到一句"缺少访问令牌"，跳到兼容页也没有任何可填的东西
// （没有存量令牌可填，只能先去"设置令牌"再回来），等于"自己的密钥自己永远看不到"。
// 现在明文门禁与写门禁**激活条件完全一致**：有生效的令牌就要带对的，没生效就不设防。
// 配置里**有**令牌但被关掉（tokenDisabled）仍按"有令牌"处理 —— 那条路是通的
// （填对存量令牌即可看），所以不放开。
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

// 令牌相关的拒绝文案**只有这一句**，所有出口都引用它（用户裁定 2026-09-18：
// 「这些关于密钥没填的提示词应该统一文案」；2026-09-19 再简化成一句话）。
//
// 2026-09-19 晚再去掉"去哪儿填、点什么"那两句（用户截图：提示条在好几个地方都折成两行）——
// 提示条右侧本来就挂着「填写令牌」按钮，把按钮名念一遍等于同一件事在一行里说两遍，还占掉
// 一整行的宽度。这一句只说"缺什么 / 错在哪"，动作交给那颗按钮；它跳到哪、填完什么状态，
// 由兼容页的胶囊与三行自己说。**不要再往这句里加指引**：契约测试钉着它的长度。
//
// 为什么必须同源：同一个"没填令牌"会在四个地方冒出来（宿主写门禁、明文门禁的两条分支、
// 界面的错误码词典），此前各写一套 —— 截图里同一件事出现了三种说法，用户无法判断它们
// 是不是同一件事。界面靠**文本相等**识别这句话（见 client.js 的 isTokenGateText），
// 所以改这句必须同时改界面词典里的那三个键。
export const TOKEN_MSG = '缺少访问令牌，或令牌不对'
/**
 * 界面按 code 在最右侧挂「填写令牌」跳转按钮（这一族里的 code 都算）。
 *
 * 2026-09-19 之后 `secretOpRejection` **不再产生** NO_HOST（没配令牌就直接放行，见上），
 * 但常量与界面词典里的 `error.secret.noToken` 都留着：宿主没重启时旧响应里还可能出现它，
 * 而界面同时按 code 与**文本相等**两条路识别这一族（见 client.js 的 isTokenGateText）。
 */
export const TOKEN_CODE_NO_HOST = 'error.secret.noToken'
export const TOKEN_CODE_BAD = 'error.token.required'

/**
 * 判定敏感 op 是否应被拒（返回 null = 放行）。
 *
 * 没配令牌 ⇒ 放行（与写门禁同一激活条件，理由见上方段落）。有令牌 ⇒ 必须带对的。
 *
 * 两个 code 仍然分开报：界面用不到（话已经一样了），但日志与排查需要区分
 * 「宿主根本没配令牌」与「这次带的令牌不对」—— 前者是配置问题，后者是输入问题。
 */
export function secretOpRejection(state: SecretGateState): SecretGateRejection | null {
  if (!state.tokenConfigured) return null
  if (!state.tokenAccepted) {
    return { code: TOKEN_CODE_BAD, error: TOKEN_MSG }
  }
  return null
}
