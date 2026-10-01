// MCP 配置体检的探测部分：命令在不在 PATH 上、http 端点通不通、把一行配置汇成检查清单，
// 以及 `mcpm-inspect` 这个 op 本身。
//
// 正文从 mcp/manager.ts 的 createMcpManager 闭包里整段搬来，一字未改（只去不掉缩进 —— 它本来
// 就在两层上；改的是两个闭包作用域的名字走 deps，moved-verify 按这两类容差机检）。
//
// 为什么先剥这一段：它是这 2211 行里少见的**纯消费方** —— 只读 normalizeRow 与 mcpmList 的
// 结果，不碰工厂实例上那几个缓存（disabledToolsCache / restrictTimer / epoch /
// agentRestrictions 那一簇被 ops 段与 dispose 共同改写，剥它要动的是调用点而不是这段）。
// 体检自己的承诺是「点了什么都不变」，所以它复用列表结果而不回写任何缓存。
import { maskUrlQuery } from './secret-guard.js'
import { parseRows } from './patch-yaml.js'
import { execFile } from 'node:child_process'
export interface InspectProbeDeps {
  /** 把一行受管配置归一化成列表形状（体检的输入来自它，不另读补丁）。 */
  ensurePaths(): Promise<any>
  readPatch(abs: string): Promise<string>
  message(e: unknown): string
  normalizeRow(r: any, level: string, abs: string): any
  /** 列表视图：体检复用它的结果，因此自己也「什么都不改」。 */
  mcpmList(): Promise<any>
}

export interface InspectProbe {
  probeCommandOnPath(command: string): Promise<'ok' | 'missing' | 'unknown'>
  describeProbeFailure(e: unknown): string
  probeHttpEndpoint(url: string, headers: unknown): Promise<{ reachable: true } | { reachable: false; reason: string }>
  inspectChecks(row: any, duplicateIds: number): Promise<Array<{ id: string; level: 'warn' | 'info'; params?: Record<string, unknown> }>>
  mcpmInspect(args: any): Promise<any>
}

export function createInspectProbe(deps: InspectProbeDeps): InspectProbe {
  const INSPECT_PATH_TIMEOUT_MS = 3000

  /** 命令是否在 PATH 上：`unknown`（查不了）与 `missing`（确认没有）必须分开 —— 前者不是问题。 */
  async function probeCommandOnPath(command: string): Promise<'ok' | 'missing' | 'unknown'> {
    if (!command) return 'unknown'
    const finder = process.platform === 'win32' ? 'where' : 'which'
    return await new Promise((resolve) => {
      execFile(finder, [command], { timeout: INSPECT_PATH_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (!error) { resolve(String(stdout || '').trim() ? 'ok' : 'missing'); return }
        // ENOENT = 连 where/which 自己都没跑到；killed = 超时。两种都是「无法确认」，
        // 剩下的（退出码非 0）才是「PATH 上没有这条命令」。
        const code = (error as { code?: unknown }).code
        if (code === 'ENOENT' || (error as { killed?: boolean }).killed === true) resolve('unknown')
        else resolve('missing')
      })
    })
  }

  /** streamable-http 连通性探测的超时：再长，「全部检查」就会被一台挂掉的服务拖住。 */
  const INSPECT_PROBE_TIMEOUT_MS = 5000

  /** 探测失败的原因短语（进词典模板的 {reason}）：认得出常见错误码就说人话，认不出给原文截断。 */
  function describeProbeFailure(e: unknown): string {
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return '探测超时（' + Math.round(INSPECT_PROBE_TIMEOUT_MS / 1000) + ' 秒无响应）'
    }
    const code = err && err.cause && err.cause.code
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败（' + code + '）'
    if (code === 'ECONNREFUSED') return '连接被拒绝（' + code + '）'
    if (code === 'ETIMEDOUT') return '连接超时（' + code + '）'
    if (code === 'ECONNRESET') return '连接被重置（' + code + '）'
    if (typeof code === 'string' && /CERT|SSL|TLS/.test(code)) return 'TLS 证书校验失败（' + code + '）'
    const text = String((err && err.cause && err.cause.message) || (err && err.message) || e || '')
    return text.length > 80 ? text.slice(0, 77) + '…' : text
  }

  /**
   * streamable-http 的连通性探测：对配置地址 GET 一次，**任何** HTTP 响应（含 404/405）
   * 都算「可达」—— 探测只回答"这个地址现在连不连得上"，不校验它是不是 MCP 服务。
   * 不读响应体：streamable-http 对 GET 常回一条 SSE 长连接，拿到状态行就取消。
   */
  async function probeHttpEndpoint(url: string, headers: unknown): Promise<{ reachable: true } | { reachable: false; reason: string }> {
    const extra: Record<string, string> = {}
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof v === 'string' && v) extra[k] = v
      }
    }
    try {
      const res = await fetch(url, { method: 'GET', headers: extra, redirect: 'follow', signal: AbortSignal.timeout(INSPECT_PROBE_TIMEOUT_MS) })
      try { await res.body?.cancel() } catch { /* 取消失败不影响「可达」结论 */ }
      return { reachable: true }
    } catch (e) {
      return { reachable: false, reason: describeProbeFailure(e) }
    }
  }

  /** 一行配置 → 检查项。`level: 'warn'` 才点黄；`info` 是「查不了 / 不算问题」那类说明。 */
  async function inspectChecks(row: any, duplicateIds: number): Promise<Array<{ id: string; level: 'warn' | 'info'; params?: Record<string, unknown> }>> {
    const checks: Array<{ id: string; level: 'warn' | 'info'; params?: Record<string, unknown> }> = []
    const declared = String(row.transport || '')
    const url = String(row.url || '')
    const command = String(row.command || '')
    // transport 缺失/不认识时按字段形状推：历史上手工改过补丁文件的行会绕过 normalize，
    // 直接判「没有 transport」会把一条其实能用的配置说成坏的。
    const transport = declared === 'stdio' || (!declared && command && !url) ? 'stdio'
      : declared === 'streamable-http' || (!declared && url) ? 'streamable-http'
        : declared
    if (!declared && transport) checks.push({ id: 'transportMissing', level: 'info' })
    /** 值必须是字符串映射：非对象整片算坏，对象里逐个挑出非字符串的键。 */
    const badKv = (map: unknown) => {
      if (map == null) return []
      if (typeof map !== 'object' || Array.isArray(map)) return ['*']
      return Object.keys(map as Record<string, unknown>).filter((k) => typeof (map as Record<string, unknown>)[k] !== 'string')
    }
    if (transport === 'stdio') {
      if (!command) checks.push({ id: 'noCommand', level: 'warn' })
      else {
        // 唯一一次外部调用。npx / uvx 这类 shim 找不到时界面给的下半句是「shim 属正常可忽略」，
        // 不让用户以为命令坏了。
        //
        // `params.command` 原样回给客户端：这与 `mcpm-list`（同样是**免令牌**的只读 op）一致
        // —— 列表视图里的 `command` 一直是明文，命令名本身不是凭据（真正装凭据的 `args`
        // 两边都不回）。若哪天要收紧，两处必须一起收，否则只是把同一份值换个 op 暴露。
        const found = await probeCommandOnPath(command)
        if (found === 'missing') checks.push({ id: 'cmdMissing', level: 'warn', params: { command } })
        else if (found === 'unknown') checks.push({ id: 'cmdUnknown', level: 'info', params: { command } })
      }
      if (row.args != null && !Array.isArray(row.args)) checks.push({ id: 'argsNotArray', level: 'warn' })
      const badEnv = badKv(row.env)
      if (badEnv.length) checks.push({ id: 'kvNotString', level: 'warn', params: { where: 'env', keys: badEnv.join('、') } })
    } else if (transport === 'streamable-http') {
      if (!url) checks.push({ id: 'noUrl', level: 'warn' })
      // URL 一律**打码后**回给客户端（`maskUrlQuery`，与列表视图同一口径）。本 op 在登记表里
      // 是 `readonly: true` 的免令牌 op，原先这里回的是补丁文件里的 URL 原文 —— 于是一个
      // 无需令牌的请求就能拿到 `?api_key=…` 的明文，绕过了 `mcpm-reveal` 那道
      // 「令牌是明文凭据最后一道防线」的设计（审查 P0-5）。路径与主机保留，定位不受影响。
      else if (!/^https?:\/\//.test(url)) checks.push({ id: 'badUrl', level: 'warn', params: { url: maskUrlQuery(url) } })
      else {
        // 格式对了再做一次真实探测（0.16.5）：此前的体检止步于格式校验，一条编造的
        // 地址也能拿绿点 —— 绿点承诺的「没发现问题」其实只覆盖了一半（2026-09-29 实测）。
        const probe = await probeHttpEndpoint(url, row.headers)
        if (!probe.reachable) checks.push({ id: 'httpUnreachable', level: 'warn', params: { url: maskUrlQuery(url), reason: probe.reason } })
      }
      const badHeaders = badKv(row.headers)
      if (badHeaders.length) checks.push({ id: 'kvNotString', level: 'warn', params: { where: 'headers', keys: badHeaders.join('、') } })
    } else if (!command && !url) {
      checks.push({ id: 'noEndpoint', level: 'warn' })
    } else {
      checks.push({ id: 'badTransport', level: 'warn', params: { transport } })
    }
    if (duplicateIds > 1) checks.push({ id: 'nameDup', level: 'warn', params: { name: String(row.serverName || ''), count: duplicateIds } })
    return checks
  }

  async function mcpmInspect(args: any): Promise<any> {
    const p = await deps.ensurePaths()
    const rows: any[] = []
    const errors: string[] = []
    for (const level of ['project', 'global']) {
      const abs = level === 'project' ? p.projectPatch : p.globalPatch
      let content = ''
      try { content = await deps.readPatch(abs) } catch (e) { errors.push(level + ': ' + deps.message(e)); continue }
      const { rows: fileRows } = parseRows(content)
      for (const r of fileRows) rows.push(deps.normalizeRow(r, level, abs))
    }
    // 重名判据：同一个 serverName 挂在**不同 id** 下。同 id 跨层是正常遮蔽（界面已有「重复 id」标签），
    // 而按名字注册的 `mcp__<serverName>__*` 会撞车 —— 那才是配置问题。
    const idsByName: Record<string, Set<string>> = {}
    for (const r of rows) {
      const n = String(r.serverName || '')
      if (!idsByName[n]) idsByName[n] = new Set()
      idsByName[n].add(String(r.id))
    }
    const onlyId = args && String(args.id || '') ? String(args.id) : ''
    const onlyLevel = args && String(args.level || '') ? String(args.level) : ''
    // 逐行检查并行跑：体检含 streamable-http 的端点探测（每次至多 5 秒超时），串行会让
    // 「全部检查」在多台同时连不上时按行数翻倍地慢。Promise.all 保序，与旧实现一致。
    const targets = rows.filter((r) => (!onlyId || String(r.id) === onlyId) && (!onlyLevel || String(r.level) === onlyLevel))
    const results = await Promise.all(targets.map(async (r) => ({
      id: r.id,
      serverName: r.serverName,
      level: r.level,
      transport: r.transport || null,
      checks: await inspectChecks(r, (idsByName[String(r.serverName || '')] || new Set()).size),
    })))
    return { ok: true, results, errors }
  }

  return { probeCommandOnPath, describeProbeFailure, probeHttpEndpoint, inspectChecks, mcpmInspect }
}
