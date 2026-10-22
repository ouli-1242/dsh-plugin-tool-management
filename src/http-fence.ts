// 插件 HTTP 路由的请求栅栏。
//
// 为什么需要它：宿主的 BrowserAuth 栅栏**只包在宿主自己注册的路由上**
// （dsh-client-connection 的 register()/upgrade、dsh-api-gateway、
// dsh-host-open-in-app），dsh-host-webserver 本身没有全局中间件。宿主生态的
// 既定约定是每个注册方自己调 `connection.admit(req)`（0.2.1 起的完整版，
// `requestRejection(req)` 是它只取状态码的那层包装），它做两件事：
//
//   1. Host/Origin 栅栏 —— Host 必须是回环地址、deployment 派生的 LAN IP 字面量
//      或声明的 trustedHosts。Host 是 DNS rebinding 唯一伪造不了的头：攻击者
//      控制域名 → 浏览器发 `Host: evil.com`，但插件的自比对式 Origin 检查
//      （origin.host === host）会同时成立，于是被误判为同源。
//   2. browser-session cookie 鉴权（HttpOnly + SameSite=Strict，Path=/）。
//
// `admit()` 还交回这次请求所代表的 **Peer**，而本插件的 exact 路由按官方契约只服务
// owner Peer（非 owner 一律 403），所以 Peer 上的 principal 也要验 —— 只取状态码会漏掉
// 这一层。但「Peer 带不带 principal」随宿主版本而变，判据见下方 `fenceRejection` 里那一段。
//
// 只查公开常量 `x-dsh-plugin` 与自比对 Origin 等于没鉴权：本机任意进程都能调写 op，
// 而写 op 里包含 `mcpm-add`（command/args 无白名单，宿主 stdio 传输会 spawn 它
// → 任意命令执行）与 `history-delete`（永久删除会话）。

import { clearRuntimeNote, noteRuntime } from './compat/runtime-notes.js'

/** 过鉴权栅栏时要看的请求头。 */
export interface FenceRequest {
  headers?: Record<string, string | string[] | undefined>
}

/** 栅栏拒绝的形状：状态码 + 错误码（界面按码分支）。 */
export interface FenceRejection {
  status: number
  error: string
}

/** 宿主 connection 服务的最小结构面。 */
export interface ConnectionSeam {
  /**
   * 0.2.1 起宿主把栅栏本身拆分：`admit()` 返回**请求所代表的那个 Peer**（或拒绝码），
   * 而 `requestRejection()` 只是它只取状态码的那一层包装。我们要的是 Peer —— 见下。
   */
  admit?(req: unknown): { peer?: { principal?: { kind?: string } } } | { rejection: 401 | 403 } | undefined
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
/**
 * 退回本地最小判定时上报。本地链**没有**浏览器会话鉴权 —— 这是"进程级边界只有
 * 配了令牌才有"那句话的证据，不能只写在注释里。成功走到宿主栅栏时清掉。
 */
function noteFenceFallback(reason: string, threw: boolean): void {
  noteRuntime({
    id: 'http-fence-fallback',
    label: 'HTTP 请求栅栏',
    kind: 'write',
    fallback: 'inform-only',
    detail: threw
      ? `宿主请求栅栏抛错（${reason}）：本次请求已退回本地判定（只校验回环 Host 与 Origin，没有浏览器会话鉴权）。`
      : `宿主 connection 服务未提供请求栅栏（${reason}）：已退回本地判定（只校验回环 Host 与 Origin，没有浏览器会话鉴权）。`,
    detailKey: threw ? 'http-fence-fallback.threw' : 'http-fence-fallback.missing',
    params: { reason },
  })
}

/** 宿主的准入栅栏：优先 `connection.admit()`，退回 Host/Origin 手检。通过返回 null。 */
export function fenceRejection(req: FenceRequest, connection?: ConnectionSeam): FenceRejection | null {
  try {
    // 优先 `admit()`（0.2.1 起存在）：它做 Host/Origin 栅栏 + 浏览器 session 鉴权，
    // 并把"这次请求代表谁"作为 Peer 交出来。`requestRejection()` 只给状态码 —— 状态码
    // 足以回答"拦不拦"，却不足以回答"这个调用方被授权到什么程度"，而本插件的路由是
    // **exact 路由**（`kind: 'exact'`，官方契约：只有 owner Peer 才该拿到响应）。
    //
    // Peer 是否带 `principal` 随宿主版本而变：0.2.0-rc.2 的 `admit()` 把 `OperatorPeer`
    // 直接交出来，那个类的字段只有 `id` / `ctx` / `scope`，**没有** `principal`。
    // 于是「没有 principal 就当作非 owner」会把**每一次**合法的 GUI 请求都判成 403 ——
    // 所有者身份"）。所以判据改成：`principal` 缺席 ⇒ 放行（admit 只把唯一那个 operator
    // 交出来，它本来就是 owner）；`principal` 在场且 kind 不是 owner ⇒ 才拒绝。
    const admission = connection?.admit?.(req)
    if (admission !== undefined) {
      // 宿主栅栏真的给出了判定（放行或拒绝都算在岗）：清掉历史回退上报。
      clearRuntimeNote('http-fence-fallback')
      if ('rejection' in admission) {
        const status = admission.rejection
        return {
          status,
          error: status === 401
            ? '未通过宿主的浏览器鉴权：请在 DSH Web GUI 内操作，或为本插件配置访问令牌（config.token / DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）'
            : 'Host/Origin 栅栏拒绝：该请求不是发往本机地址的同源请求',
        }
      }
      const principal = admission.peer?.principal
      if (principal !== undefined && principal.kind !== 'owner') {
        return { status: 403, error: '拒绝：调用方不是本机所有者身份' }
      }
      return null
    }
    const rejection = connection?.requestRejection?.(req)
    if (typeof rejection === 'number') {
      clearRuntimeNote('http-fence-fallback')
      return {
        status: rejection,
        error: rejection === 401
          ? '未通过宿主的浏览器鉴权：请在 DSH Web GUI 内操作，或为本插件配置访问令牌（config.token / DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）'
          : 'Host/Origin 栅栏拒绝：该请求不是发往本机地址的同源请求',
      }
    }
    // 栅栏在场且未返回拒绝码 ⇒ 已通过，不再叠加本地判定（宿主的 trustedHosts
    // 部署信息这里拿不到，重复判定只会更松或更严，都不对）。
    if (typeof connection?.requestRejection === 'function') {
      clearRuntimeNote('http-fence-fallback')
      return null
    }
    noteFenceFallback(connection ? 'connection 服务没有 admit / requestRejection' : '未挂载 connection 服务', false)
  } catch (e) {
    // 见上方说明：退回本地判定。**必须出声** —— 静默回退时用户以为浏览器鉴权还在。
    noteFenceFallback(String((e && (e as Error).message) || e), true)
  }

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
// 它是"最后一道防线"，防线却可以不存在。所以 把口径改成：**没有令牌就没有明文**。
//
// 用户点「显示密钥」只拿到一句"缺少访问令牌"，跳到兼容页也没有任何可填的东西
// （没有存量令牌可填，只能先去"设置令牌"再回来），等于"自己的密钥自己永远看不到"。
// 现在明文门禁与写门禁**激活条件完全一致**：有生效的令牌就要带对的，没生效就不设防。
// 配置里**有**令牌但被关掉（tokenDisabled）仍按"有令牌"处理 —— 那条路是通的
// （填对存量令牌即可看），所以不放开。
//
// 为什么不用同源 Origin 顶替：同源只证明"请求来自本机页面"，不证明"读的人被授权"；
// 明文凭据要的是后者。配了令牌的本地工具（无 Origin）仍然放行，那是显式凭证。

/** 敏感 op 的令牌门状态：配没配、这一次过没过。 */
export interface SecretGateState {
  /** 宿主是否配置了访问令牌（config.token / DSH_PLUGIN_TOOL_MANAGEMENT_TOKEN）。 */
  tokenConfigured: boolean
  /** 请求带的 x-dsh-token 是否与宿主令牌一致。 */
  tokenAccepted: boolean
}

/** 令牌门拒绝的形状：错误码 + 文案。 */
export interface SecretGateRejection {
  code: string
  error: string
}

// 令牌相关的拒绝文案**只有这一句**，所有出口都引用它（用户要求 ：
// 「这些关于密钥没填的提示词应该统一文案」；再简化成一句话）。
//
// 提示条右侧本来就挂着「填写令牌」按钮，把按钮名念一遍等于同一件事在一行里说两遍，还占掉
// 一整行的宽度。这一句只说"缺什么 / 错在哪"，动作交给那颗按钮；它跳到哪、填完什么状态，
// 由兼容页的胶囊与三行自己说。**不要再往这句里加指引**：契约测试钉着它的长度。
//
// 为什么必须同源：同一个"没填令牌"会在四个地方冒出来（宿主写门禁、明文门禁的两条分支、
// 界面的错误码词典），此前各写一套 —— 截图里同一件事出现了三种说法，用户无法判断它们
// 是不是同一件事。界面靠**文本相等**识别这句话（见 client.js 的 isTokenGateText），
// 所以改这句必须同时改界面词典里的那三个键。
/** 令牌缺失 / 不匹配时给界面的那句话（两种情况合并，不告诉调用方是哪一种）。 */
export const TOKEN_MSG = '缺少访问令牌，或令牌不对'
/**
 * 界面按 code 在最右侧挂「填写令牌」跳转按钮（这一族里的 code 都算）。
 *
 * 但常量与界面词典里的 `error.secret.noToken` 都留着：宿主没重启时旧响应里还可能出现它，
 * 而界面同时按 code 与**文本相等**两条路识别这一族（见 client.js 的 isTokenGateText）。
 */
export const TOKEN_CODE_NO_HOST = 'error.secret.noToken'
/** 上面那句话的错误码：界面按它认出「要填令牌」，而不是按文案匹配。 */
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
