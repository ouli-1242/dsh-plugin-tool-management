// 诊断包（0.21.2 Phase 5.3）—— 一段可直接复制的纯文本。
//
// 纪律（写在最前面，改的时候别破坏）：
//   · **只读**：本模块不碰磁盘、不发请求，所有事实由调用方取好传进来；
//   · **不含秘密 / 正文**：令牌只报"配没配 / 这次生效没有"，侧车只报存在性、大小与时间，
//     记忆 / 提示词 / 人设正文一个字都不进来，环境变量值也不进来；
//   · 字段是**白名单**：调用方多传的键一律不输出（测试钉住这条）。
//
// 为什么是纯文本而不是 JSON：用户要把它贴进 issue / 聊天窗口。JSON 里那些引号与转义
// 对人是噪音，对机器也没有额外价值 —— 需要结构化数据的地方直接读各个 op。
export const DIAGNOSTICS_TITLE = 'dsh-plugin-tool-management 诊断信息'

export interface DiagnosticsSidecar {
  name: string
  /** 三态读取器给出的结论；没有三态读取器的侧车用 `present` / `missing`。 */
  state: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'present' | 'unknown'
  bytes?: number | null
  mtime?: string | null
}

export interface DiagnosticsInput {
  pluginVersion: string
  hostVersion: string | null
  verifiedVersion?: string | null
  platform: { os: string; node: string }
  /** 插件数据目录（hub）。 */
  dataDir: string
  token: { configured: boolean; active: boolean }
  update: { status: string; current?: string | null; bestCompatible?: string | null } | null
  compat: {
    findings: number
    degraded: number
    blockers: string[]
    unverified: string[]
    separateCopies: string[]
  } | null
  sidecars: DiagnosticsSidecar[]
  counts: Record<string, number>
  log: { path: string; bytes: number | null } | null
  doctor: { findings: Array<{ where: string; kind: string; name: string }>; skipped: string[] } | null
  /** 生成时间（测试注入用）。 */
  now?: Date
}

const yesNo = (value: boolean): string => (value ? '是' : '否')

/** 侧车一行：名字 + 状态 + 大小 + 时间。大小 / 时间缺失时留 `-`，不猜。 */
function sidecarLine(row: DiagnosticsSidecar): string {
  const size = typeof row.bytes === 'number' ? String(row.bytes) + ' B' : '-'
  const mtime = row.mtime || '-'
  return '- ' + row.name + '  ' + row.state + '  ' + size + '  ' + mtime
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = []
  lines.push(DIAGNOSTICS_TITLE)
  lines.push('生成时间: ' + (input.now || new Date()).toISOString())
  lines.push('插件版本: ' + input.pluginVersion)
  lines.push('宿主版本: ' + (input.hostVersion || '未知') +
    (input.verifiedVersion ? '（插件适配版本 ' + input.verifiedVersion + '）' : ''))
  lines.push('平台: ' + input.platform.os + ' / node ' + input.platform.node)
  lines.push('数据目录: ' + input.dataDir)
  lines.push('访问令牌: ' + (input.token.configured ? '已配置' : '未配置') + '（本次生效: ' + yesNo(input.token.active) + '）')
  if (input.update) {
    lines.push('更新检查: ' + input.update.status +
      (input.update.current ? '（当前 ' + input.update.current +
        (input.update.bestCompatible ? ' → 兼容最高 ' + input.update.bestCompatible : '') + '）' : ''))
  }
  lines.push('')
  if (input.compat) {
    const c = input.compat
    lines.push('宿主能力: ' + c.findings + ' 项探测，降级 ' + c.degraded +
      '，阻塞 ' + c.blockers.length + '，未验证 ' + c.unverified.length +
      '，两份拷贝 ' + c.separateCopies.length)
    if (c.blockers.length) lines.push('阻塞项: ' + c.blockers.join('；'))
    if (c.unverified.length) lines.push('未验证包: ' + c.unverified.join('、'))
    if (c.separateCopies.length) lines.push('两份拷贝: ' + c.separateCopies.join('、'))
  } else {
    lines.push('宿主能力: 探测不可用')
  }
  lines.push('')
  lines.push('侧车:')
  if (input.sidecars.length) for (const row of input.sidecars) lines.push(sidecarLine(row))
  else lines.push('- （无）')
  lines.push('')
  const countKeys = Object.keys(input.counts)
  lines.push('计数: ' + (countKeys.length
    ? countKeys.map((k) => k + ' ' + input.counts[k]).join(' / ')
    : '（无）'))
  if (input.log) {
    lines.push('日志: ' + input.log.path + '  ' + (typeof input.log.bytes === 'number' ? String(input.log.bytes) + ' B' : '大小未知'))
  }
  lines.push('')
  if (input.doctor) {
    const d = input.doctor
    lines.push('悬空引用体检: ' + (d.findings.length ? d.findings.length + ' 项' : '未发现') +
      (d.skipped.length ? '（未查: ' + d.skipped.join('、') + '）' : ''))
    for (const f of d.findings) lines.push('- [' + f.kind + '] ' + f.where + ' → ' + f.name)
  } else {
    lines.push('悬空引用体检: 未运行')
  }
  return lines.join('\n') + '\n'
}
