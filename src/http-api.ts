// UI 半侧的 HTTP API 路由：读请求体、过宿主同源围栏与令牌门禁、把 op 派给 handlers 表。
//
// 正文从 index.ts 的 apply 闭包里整段搬来，一字未改 —— 只去一层缩进，并把 apply 作用域里的
// 名字改走 deps（moved-verify 按这几类容差机检，容差之外任何一字不同都会报错）。
//
// 为什么传引用而不是传值：`handlers` 在装配之后还会被 Object.assign 追加、被逐条重包门禁，
// 快照一份就等于发一份「看不到后续改写」的副本；两个 op 名单 Set 同理，要的是集合本身。
import type { Context } from '@deepseek-ai/cordis'
import { noteRuntime } from './compat/runtime-notes.js'
import { recordOpAudit } from './audit-log.js'
import { isReadCall } from './op-registry.js'
import { TOKEN_CODE_BAD, TOKEN_MSG, fenceRejection, secretOpRejection, type ConnectionSeam } from './http-fence.js'
import type { AccessToken, OpWhitelist } from './request-gate.js'

// 宿主 webServer 三个面的最小结构类型（原本定义在 index.ts 的「本地接口」区，
// 只有这条路由与 DshContext.webServer 用得到，随正文一起搬过来）。
export interface HttpReq {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: string, callback: (chunk?: unknown) => void): void
}

export interface HttpRes {
  writeHead(code: number, headers?: Record<string, string>): void
  end(body?: string): void
}

export interface WebServerService {
  register(route: { kind: 'exact'; path: string; handler(req: HttpReq, res: HttpRes): void }): () => void
}

export interface HttpApiDeps extends
  // 访问令牌与 op 白名单：apply 里由 request-gate 的两个工厂建好，逐字段透传（类型钉回工厂出口）。
  Pick<AccessToken, 'CONFIG_TOKEN' | 'TOKEN_DISABLED' | 'TOKEN' | 'tokenMatches' | 'BOOT_ID' | 'markAccepted' | 'unmarkAccepted'>,
  Pick<OpWhitelist, 'WRITE_OPS' | 'SENSITIVE_OPS'> {
  /** apply 的 ctx：本层只用到 `get('connection')` 与 `effect`（路由的 disposer 挂插件作用域）。 */
  ctx: Pick<Context, 'get' | 'effect'>
  config?: Record<string, unknown>
  webServer: WebServerService
  /** 全部 HTTP op 的派发表 —— 传引用：装配后还会被 Object.assign 追加、被逐条重包门禁。 */
  handlers: Record<string, (args: any) => Promise<any>>
  message(e: unknown): string
  withPatchWarnings(result: any): any
  tokenConfigState(): Promise<{ found: boolean; configHasToken: boolean; configDisabled: boolean; pendingRestart: boolean }>
  tokenConfigure(args: any, presented: boolean): Promise<any>
}

export function installHttpApi(deps: HttpApiDeps): void {

  // ---------- HTTP API route (UI half), registered defensively ----------
  if (deps.webServer) {
    // Cap request bodies (88 MiB): skill-upload carries Base64 folder/ZIP
    // payloads (64 MiB of raw content). Reachability is decided by
    // fenceRejection() below — the host's Host/Origin + browser-session fence
    // (or a correct explicit token). `config.maxBodyBytes` overrides the cap
    // (tests use a small value).
    const configuredMaxBody = Number((deps.config as { maxBodyBytes?: unknown } | undefined)?.maxBodyBytes)
    // 默认 88 MiB：够塞下一份带多张大附件（图片 / PDF）的技能或记忆打包体，又不至于让
    // 一个失控的客户端把进程内存吃光。`config.maxBodyBytes` 可覆盖（测试用小值）。
    const DEFAULT_MAX_BODY_BYTES = 88 * 1024 * 1024
    const MAX_BODY = Number.isFinite(configuredMaxBody) && configuredMaxBody > 0 ? configuredMaxBody : DEFAULT_MAX_BODY_BYTES
    const readBody = (req: HttpReq) => new Promise<string>((resolve, reject) => {
      // 先看 content-length：注定超限的请求在**读第一个字节之前**就拒掉。以前只能边收边数，
      // 一个 5 GB 的上传会先让我们缓冲满 88 MiB 才回错。读取流照旧 drain（一个字节都不留），
      // 否则响应写完后服务端会直接拆连接，客户端可能在上传中途拿到网络错误而不是下面这句 JSON。
      // 错误消息必须含 `body too large` —— 后面的 catch 靠这个子串分流。
      const declared = Number(req.headers && req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY) {
        const drain = (req as { resume?: () => void }).resume
        if (typeof drain === 'function') drain.call(req)
        reject(new Error('request body too large'))
        return
      }
      // Accumulate Buffers and decode ONCE at the end: decoding each chunk
      // separately corrupts multi-byte UTF-8 characters that straddle a
      // chunk boundary (e.g. long Chinese skill bodies).
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c) => {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
        size += buf.length
        if (size > MAX_BODY) { reject(new Error('request body too large')); return }
        chunks.push(buf)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
    // 宿主 BrowserAuth 栅栏。宿主的鉴权**只包在它自己注册的路由上**——dsh-host-webserver
    // 没有全局中间件，既定约定是每个注册方自己调 connection.requestRejection(req)：
    // 它先做 Host/Origin 栅栏（Host 必须是回环或 deployment 派生的 LAN IP 字面量，
    // 这是 DNS rebinding 唯一伪造不了的头），再叠加 browser-session cookie 鉴权。
    // 本插件此前只查公开常量 x-dsh-plugin 与自比对（Origin.host === Host）的 "同源"，
    // 两者都挡不住 rebind 后的网页或本机任意进程 —— 等于没鉴权。现在优先走宿主栅栏。
    const connection = ((): ConnectionSeam | undefined => {
      try { return deps.ctx.get('connection') as ConnectionSeam | undefined }
      catch { return undefined }
    })()
    try {
      // ctx.effect wires the route's disposer into this plugin's scope, so an
      // unload (HMR removal, disable, update) unregisters the route — the
      // documented cleanup contract (webServer.register does not auto-scope).
      deps.ctx.effect(() => deps.webServer.register({
        kind: 'exact',
        path: '/dsh-plugin-tool-management/api',
        handler: async (req, res) => {
          // 鉴权顺序：POST-only → 插件门禁头（防误触，不是凭证）→ 宿主栅栏
          // （Host/Origin + browser-session cookie）→ 可选访问令牌。令牌是本地工具与
          // LAN 部署的逃生门：**令牌正确即视为已授权**，可越过浏览器鉴权。
          //
          // 「未配置令牌时」别读成"仍有门禁"：下面的写 op 判据是
          // `if (TOKEN && WRITE_OPS.has(op))` —— `TOKEN === ''` 时整条短路，79 个写 op
          // 只剩 `fenceRejection` 一道。而它自身有两种形态：宿主栅栏在场时含 cookie 鉴权；
          // 栅栏缺席或抛错时退回本地判定，**只查回环 Host 与（若给了）Origin 自比对**，
          // 没有 cookie 那一层 —— 本机任意进程都能调写 op。所以准确说法是：
          // 未配置令牌时不再有「**无栅栏**放行」的缺口，但进程级边界只有配了令牌才有。
          const hdr = (name: string): string => {
            const v = req.headers?.[name]
            return Array.isArray(v) ? v[0] ?? '' : v ?? ''
          }
          if (String(req.method || 'POST').toUpperCase() !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            return
          }
          if (hdr('x-dsh-plugin') !== 'dsh-plugin-tool-management') {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'missing plugin gate header' }))
            return
          }
          // 「本次带的这串对不对」比的是**存量**令牌：关掉令牌功能之后仍然要凭它才能开回来、
          // 换掉、或看明文（要求 9）。
          const tokenAccepted = deps.CONFIG_TOKEN !== '' && deps.tokenMatches(hdr('x-dsh-token'))
          // 验过就置闩（本次进程一次即可）。`agent/pre-step` 的令牌门禁读的就是它 ——
          // 那一边看不到请求头，只能由这里告诉它"这台机器已经有人验过令牌了"。
          if (tokenAccepted) deps.markAccepted()
          if (!tokenAccepted) {
            const fence = fenceRejection(req, connection)
            if (fence) {
              res.writeHead(fence.status, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: fence.error }))
              return
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          try {
            let payload: any = {}
            try {
              payload = JSON.parse((await readBody(req)) || '{}')
            } catch (e) {
              if (String((e as Error)?.message).includes('body too large')) {
                res.end(JSON.stringify({ ok: false, error: '请求体过大' }))
                return
              }
              /* otherwise fall through with {} */
            }
            const op = String(payload.op || '')
            // 敏感 op（会吐明文密钥与完整配置）：**配了令牌就必须带对的**，没配令牌则不设防
            // （判定与理由见 http-fence.ts 的 secretOpRejection —— 用户裁定 2026-09-19：
            // 没配令牌时那道门没有出路，用户无从填一个不存在的令牌）。
            // 之前这里只查"有没有 Origin 头"，而 token 为空时它形同虚设 —— 任何能
            // 打开 GUI 的浏览器都拿得到全部密钥原文。
            if (deps.SENSITIVE_OPS.has(op)) {
              // 明文门禁看的是**存量**令牌（CONFIG_TOKEN 而不是生效值 TOKEN）：关掉令牌
              // 功能之后仍然"要凭存量令牌才给明文"—— 那条路是通的（填对就能看），
              // 与"从来没配过"不同。
              const gate = secretOpRejection({ tokenConfigured: deps.CONFIG_TOKEN !== '', tokenAccepted })
              if (gate) {
                res.end(JSON.stringify({ ok: false, error: gate.error, code: gate.code }))
                return
              }
            }
            // 「读改写」两态 op（`inject-settings` / `tool-table` / `scene-settings` /
            // `mcpm-settings`）：同一个名字既读又写，于是整条 op 被列进 WRITE_OPS —— 读侧也
            // 一起被拦，界面表现是"没填令牌时整块设置消失、填了还要刷新才出现"（2026-09-19
            // 用户报的）。判据是**这次调用要不要写**，不是 op 名在不在名单里。
            // 判据本身在登记表（`writeWhen`），这里不再手写一份 —— 手写那份只认 `set:true`，
            // 于是 `tool-table` 的 `presetSave` / `presetDelete` 被当成读放行，配了令牌也能
            // 只凭宿主栅栏改侧车（审查 F2，0.17.0 修）。
            const readOnlyCall = isReadCall(op, payload.args)
            if (deps.TOKEN && deps.WRITE_OPS.has(op) && !readOnlyCall && !deps.tokenMatches(hdr('x-dsh-token'))) {
              // 文案与明文门禁同源（http-fence.ts），code 也统一 —— 界面据此在最右侧挂
              // 「去填令牌」跳转按钮。这条错误会出现在**任意**页面，而入口只有一个。
              res.end(JSON.stringify({ ok: false, code: TOKEN_CODE_BAD, error: TOKEN_MSG }))
              return
            }
            // 令牌状态（只读，**不需要**令牌本身）：回答"宿主配没配"、"本次带的这串对不对"、
            // "配置文件里的改动是不是还没重启生效"、"本次进程的标识"。就地回答而不是进 handlers 表：
            // 前者的答案来自本次请求头与进程状态，而后者的 handlers 只拿得到 args。
            // 不返回令牌、也不返回它的任何片段 —— 泄给同源页面等于把最后一道门交出去。
            if (op === 'token-status') {
              const state = await deps.tokenConfigState()
              res.end(JSON.stringify({
                ok: true,
                // 「宿主配置了令牌」= 配置里**有**值（关掉也算有：随时能开回来）。
                hostConfigured: deps.CONFIG_TOKEN !== '',
                // 当前进程里令牌功能是开还是关（关掉 = 写操作不要求令牌）。
                disabled: deps.TOKEN_DISABLED,
                // 「当前进程里令牌**在生效**」= 写操作要不要令牌。关掉或没配都是 false。
                // 界面据此判断"填令牌"这件事有没有意义（没生效时填了也没人验，还会把
                // 一句无处可填的提示挂在屏幕上 —— 用户 2026-09-19 报的就是这个）。
                active: deps.TOKEN !== '',
                accepted: tokenAccepted,
                bootId: deps.BOOT_ID,
                configHasToken: state.configHasToken,
                configDisabled: state.configDisabled,
                configFound: state.found,
                pendingRestart: state.pendingRestart,
              }))
              return
            }
            // 设置 / 关闭令牌：同样就地处理（理由见 tokenConfigure 的注释 —— 也正因为不进
            // handlers，模型侧没有任何工具能间接关掉它）。
            if (op === 'token-configure') {
              res.end(JSON.stringify(deps.withPatchWarnings(await deps.tokenConfigure(payload.args || {}, tokenAccepted))))
              return
            }
            // 「清除令牌」的配套：把「本次启动已验过」的闩重新挂上。没有它，解锁一次之后
            // 清除令牌 + 强刷新，浏览器里已无令牌，闩却挂着 —— pre-step 门禁读闩
            // （tokenGateActive），整个启动期都放行对话（2026-09-19 用户实测的漏洞）。
            // 不要求凭证：它只会收紧（要求重新验令牌），给不了任何人任何权限；同样不进
            // handlers —— 模型不该有能力拨这颗闩。
            if (op === 'token-unaccept') {
              deps.unmarkAccepted()
              res.end(JSON.stringify({ ok: true }))
              return
            }
            const fn = deps.handlers[op]
            if (!fn) {
              res.end(JSON.stringify({ ok: false, error: '未知操作: ' + op }))
              return
            }
            const result = await fn(payload.args || {})
            // 「最近改动」流水：来源 = 面板（这条 HTTP 路由是界面唯一的入口）。
            // 「这次算不算写」的判据在 recordOpAudit 里（与写门禁同源：登记表的 `writeWhen`）
            // —— 不在这里再传一次 `readOnlyCall`，两处各判一次迟早会分家。
            recordOpAudit(op, payload.args || {}, 'panel', result)
            res.end(JSON.stringify(deps.withPatchWarnings(result === undefined ? { ok: true } : result)))
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: deps.message(e) }))
          }
        },
      }), 'dsh-plugin-tool-management: api route')
    } catch (e) {
      // A registration failure must never take down the whole entry: log and continue.
      console.error('[dsh-plugin-tool-management] webServer route registration failed:', deps.message(e))
      // 结构性弱点（2026-09-30 审查 §5 F4）：compat-status **本身就走这条路由**，所以路由没注册上
      // 时兼容页也拿不到这条降级行 —— 面板是**整页失联**，不是"少一行"。这里至少把它写进运行期
      // 上报通道（日志里必然有一条，进程内可查），并在 README 里写明"面板空白先看宿主日志"。
      // 之所以不是"必然可见"的告警：可见的通道就是这条路由，它自己挂了就没得显示。
      noteRuntime({
        id: 'web-server-route',
        label: 'HTTP 路由注册',
        kind: 'write',
        fallback: 'inform-only',
        detail: '向宿主 webServer 注册 API 路由失败（' + deps.message(e) + '）：插件面板与全部 HTTP op 不可用（兼容页也走这条路由，所以它也打不开）。宿主日志里有同一条记录；模型工具不受影响。',
        detailKey: 'web-server-route.register-failed',
        params: { reason: deps.message(e) },
      })
    }
  }
}
