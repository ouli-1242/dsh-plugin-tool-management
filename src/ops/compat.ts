// 兼容 / 注入 / 备份域的 HTTP ops（2026-09-19 从 index.ts 的 handlers 表抽出）。
//
// 为什么抽出来：index.ts 的 apply() 闭包里塞了 40 个 op 的内联实现，改一处要在 700 行
// 的对象字面量里找。这里按域收成一个 `buildCompatOps(deps)` —— 依赖全部显式传参，
// 不再靠闭包隐式捕获，各域可以单独读、单独改。
//
// 边界纪律：本文件只负责「op 的实现」，不负责 ops 表之外的接线（MCP 写后刷新、场景锁定
// 守卫仍作用在组装后的整张表上，见 index.ts）。

import {
  EXPECTED_MIN_HOST_VERSION,
  EXPECTED_PEER_RANGE,
  VERIFIED_HOST_VERSION,
  routeFor,
  summarize,
  type CapabilityFinding,
  type HostAssessment,
  type OperationName,
  type RouteDecision,
} from '../compat/probe.js'
import { INJECT_DOMAIN_KEYS } from '../context-inject.js'
import { assessPresetReach, type PresetRosterLike } from '../compat/preset-reach.js'
import { runtimeNotes } from '../compat/runtime-notes.js'
import { pluginLog } from '../skills/service.js'
import type { InjectSettings, LiveInjectionSnapshot } from '../context-inject.js'
import type { ToolTableReport } from '../tools/table.js'

/** patch 备份清单里的一项：名字 / 层级 / 时间 / 大小（不带文件内容）。 */
export interface PatchBackupInfo {
  name: string
  level: string
  mtime: number
  size: number
}

/** compat-status 需要的那一点注册表能力（整体 SessionsRegistry 的最小投影）。 */
interface CompatRegistryLike {
  capabilities?(force?: boolean): HostAssessment
}

export interface CompatOpsDeps {
  /** 归档/历史注册表；未挂载时 undefined（compat-status 据此报「探测不可用」）。 */
  getSessionsRegistry(): CompatRegistryLike | undefined  /**
   * 宿主 tools 服务：preset-reach 用它数出当前 MCP 工具数。
   * `schemas()` 在宿主上是**同步**返回 `ToolSchema[]` 的（官方 dsh-tools 契约），这里不写死
   * 那个类型——本插件只需要"能 await 出一份带 name 的清单"，写宽一点免得官方换签名就红。
   */
  tools: { schemas(): unknown }
  readInjectSettings(force?: boolean): Promise<InjectSettings>
  injectSettingsOp(args: any): Promise<any>
  /** 模型工具表设置（读写侧车 `tool-table.json`；界面在「兼容」页同一块）。 */
  toolTableOp(args: any): Promise<any>
  /** 当前工具表实况（注册时量到的体积 + 关掉了哪些），功能总览那一行用。 */
  toolTableReport(): ToolTableReport
  presetRoster(): PresetRosterLike | undefined
  listPatchBackups(): Promise<PatchBackupInfo[]>
  cleanPatchBackups(delByLevel: Record<string, number>): Promise<{ removed: string[]; failed: string[]; kept: number }>
  /**
   * 注入通道的实况快照读取器 —— 装配 / 卸载会改写它（apply 内的 `contextInjectorLive`），
   * 所以传 getter 而不是值，否则 op 会一直握着通道卸载前那份引用。
   */
  getContextInjectorLive(): (() => LiveInjectionSnapshot) | null
  /** 令牌实况（与 token-status 同源）：功能是否生效、本次启动验过没有。 */
  readTokenState(): Promise<{ active: boolean; accepted: boolean }>
  /** 当前锁定中的场景名（空数组 = 没锁）。 */
  lockedSceneNames(): Promise<readonly string[]>
  /** 停用表中的工具条数（读 TTL 缓存，无 I/O）。 */
  disabledToolCount(): number
  message(e: unknown): string
  /**
   * compat-status 的日志去重状态（记录已打过日志的宿主版本）。跨调用可变 —— 用对象持有，
   * 让"改到哪一次"留在调用方那侧，本文件不自己藏状态。
   */
  compatLog: { version?: string }
}

export function buildCompatOps(deps: CompatOpsDeps): Record<string, (args: any) => Promise<any>> {
  return {
    'compat-status': async (args: any) => {
      const force = Boolean(args && args.refresh)
      try {
        const registry = deps.getSessionsRegistry()
        const assessment = registry && typeof registry.capabilities === 'function'
          ? registry.capabilities(force)
          : undefined
        if (assessment === undefined) {
          return {
            ok: true,
            host: { version: 'unknown' },
            findings: [],
            degraded: [],
            blockers: ['归档服务未挂载：无法探测宿主能力'],
            summary: '宿主能力探测不可用（归档服务未挂载）',
          }
        }
        const summary = summarize(assessment)
        // 运行时降级（A1 的补丁校验、A2 的投影缓存适配、B3 的装配层…）统一在这里并进
        // findings/degraded：它们不是宿主能力，但必须各占一行 —— 否则用户只能在事故之后
        // 才知道某道保险没生效。上报口径见 compat/runtime-notes.ts。
        const extraFindings: CapabilityFinding[] = runtimeNotes().map((note) => ({
          id: note.id,
          label: note.label,
          kind: note.kind,
          owner: 'plugin',
          fallback: note.fallback,
          state: 'not-available',
          missing: [],
          detail: note.detail,
        }))
        const findings = [...assessment.findings, ...extraFindings]
        const degraded = [...assessment.degraded, ...extraFindings]
        const merged = { ...assessment, findings, degraded }
        const summaryMerged = extraFindings.length === 0 ? summary : summarize(merged)
        // 每次刷新都留一条结构化日志：升级当天就能在日志里看到降级发生。
        if (force || !deps.compatLog.version || deps.compatLog.version !== assessment.identity.version) {
          deps.compatLog.version = assessment.identity.version
          void pluginLog()('compat/probe', {
            hostVersion: assessment.identity.version,
            summary: summaryMerged,
            degraded: degraded.map((item: CapabilityFinding) => ({ id: item.id, state: item.state, detail: item.detail })),
            blockers: assessment.identity.blockers,
            sameAsHost: assessment.identity.sameAsHost,
          }).catch(() => {})
        }
        return {
          ok: true,
          host: { version: assessment.identity.version, modules: assessment.identity.modules },
          sameAsHost: assessment.identity.sameAsHost,
          unverified: assessment.identity.unverified,
          findings,
          degraded,
          blockers: assessment.identity.blockers,
          mayDelete: assessment.mayDelete,
          verifiedVersion: VERIFIED_HOST_VERSION,
          expectedPeerRange: EXPECTED_PEER_RANGE,
          minHostVersion: EXPECTED_MIN_HOST_VERSION,
          generatedAt: assessment.generatedAt,
          summary: summaryMerged,
        }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 预设可达性矩阵：每个 Agent 预设下，本插件的注入类能力到不到得了模型。
    // 只读预设组合文本，不挂载任何预设、不改任何数据。回答的是"面板上说注入了，
    // 模型真的看得到吗" —— 压制型预设（persona complete / includeRuntimeContext:false，
    // 如极简）默认不注入，可在「注入」设置里改成强制注入。
    'preset-reach': async () => {
      try {
        // 宿主平面的 MCP 工具数：四个官方预设都不在组合里挂 MCP，MCP 由
        // $DSH_HOME/cordis.patch.yml 这一层挂载，所以它对所有预设一视同仁；
        // 这一列要回答的只是"现在有没有 MCP 工具可用"。探测失败 → 不传该字段，
        // 矩阵那一格显示"判断不了"而不是猜。
        let mcpTools: number | undefined
        try {
          const schemas = (await deps.tools.schemas()) as Array<{ name?: string }>
          mcpTools = schemas.filter((s: any) => String(s && s.name || '').startsWith('mcp__')).length
        } catch { mcpTools = undefined }
        const settings = await deps.readInjectSettings()
        const report = await assessPresetReach(deps.presetRoster(), {
          mcpTools,
          inject: { underSuppressingPresets: settings.underSuppressingPresets, domains: settings.domains },
        })
        return { ok: true, ...report }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 注入设置（读 / 写）：压制型预设下是否仍然注入 + 各域开关。界面在「兼容」页。
    'inject-settings': (args: any) => deps.injectSettingsOp(args),
    // 模型工具表（读 / 写）：哪些工具**根本不发**给模型。工具表按每个请求付钱，关掉的
    // 整份不进请求（与 MCP 停用那半边的区别：那些是宿主工具、关掉仍留在表里；这些是
    // 我们自己的工具，关掉两边一起生效）。返回里带分组体积，界面据此显示 ≈token。
    'tool-table': (args: any) => deps.toolTableOp(args),
    // 功能总览（B6）：**按功能点**回答"现在每一项到底能不能用"，三层合成 ——
    //   ① 装配层（listener / provider / 适配是否真的挂上，来自运行时上报通道）
    //   ② 宿主能力层（compat 探测的路由判定）
    //   ③ 用户配置层（开关 / 令牌 / 场景锁定）
    // 数据全部来自已有的缓存状态与运行时上报，**不新增宿主探测**（避免哨兵真调一类的开销）。
    // 行内 `tab` 供界面跳转到对应页签；`state` 取值见下方约定。
    'feature-overview': async () => {
      try {
        const registry = deps.getSessionsRegistry()
        const assessment = registry && typeof registry.capabilities === 'function' ? registry.capabilities() : undefined
        const notes = new Map(runtimeNotes().map((note) => [note.id, note] as const))
        const settings = await deps.readInjectSettings()
        const domainsOn = INJECT_DOMAIN_KEYS.filter((key) => settings.domains[key] !== false)
        const token = await deps.readTokenState()
        const lockedScenes = await deps.lockedSceneNames()
        const disabledTools = deps.disabledToolCount()
        const routeOf = (operation: OperationName): RouteDecision | undefined =>
          assessment === undefined ? undefined : routeFor(assessment, operation)
        /** 一行一个功能点：状态三层合成，`detail` 写明依据。 */
        const rows: Array<{ key: string; label: string; tab: string; state: string; detail: string }> = []
        const push = (key: string, label: string, tab: string, state: string, detail: string) => rows.push({ key, label, tab, state, detail })
        // 前置项：插件挂载（这一行本身说明 12 个 inject 都解析了 —— 否则 apply 根本不会跑）；
        // 启动期那段 `!!js` 表达式若抛错，插件同样不会挂上（它的 try/catch 就是为了不抛）。
        const mountNote = notes.get('cordis-original-symbol')
        push('mount', '插件挂载', 'compat',
          mountNote === undefined ? 'ok' : 'degraded',
          mountNote === undefined ? '12 个 inject 服务全部解析，插件已挂载（详见 doctor 的挂载心跳）' : mountNote.detail)
        // 装配层：有上报就是降级，附上报里的原因；没有就是正常。
        const assemblyRows: Array<[string, string, string]> = [
          ['patch-write-guard', '宿主配置写入（补丁校验）', 'mcp'],
          ['context-injection', '上下文注入通道', 'compat'],
          ['official-suppression', '官方注入的关域拦截', 'compat'],
          ['skills-provider', '技能 provider 装配', 'skills'],
          ['projection-cache-adapter', '投影缓存删除屏障', 'sessions'],
          ['mcp-tool-visibility', '工具表可见性（停用 / 关掉的工具不下发）', 'mcp'],
        ]
        for (const [noteId, label, tab] of assemblyRows) {
          const note = notes.get(noteId)
          push(noteId, label, tab, note === undefined ? 'ok' : 'degraded',
            note === undefined ? '装配正常，无降级上报' : note.detail)
        }
        // 宿主能力层：删除 / 归档 / 恢复 / 批量各自由路由判定回答（与服务端执行同源）。
        const deleteRoute = routeOf('delete')
        push('session-delete', '会话删除', 'sessions',
          deleteRoute === undefined ? 'unknown' : deleteRoute.via === 'none' ? 'unavailable' : 'ok',
          deleteRoute === undefined ? '能力探测不可用（归档服务未挂载）'
            : deleteRoute.via === 'none' ? '宿主缺少该路径所需能力：' + deleteRoute.refusals.map((item) => item.label).join('、')
              : `可用（路径：${deleteRoute.via}）`)
        for (const [operation, label] of [['archive', '归档'], ['unarchive', '恢复'], ['batch', '批量操作'], ['list', '历史列表']] as const) {
          const decision = routeOf(operation)
          push('session-' + operation, `会话${label}`, 'sessions',
            decision === undefined ? 'unknown' : decision.via === 'none' ? 'unavailable' : 'ok',
            decision === undefined ? '能力探测不可用（归档服务未挂载）'
              : decision.via === 'none' ? '宿主缺少该路径所需能力：' + decision.refusals.map((item) => item.label).join('、')
                : `可用（路径：${decision.via}）`)
        }
        // 用户配置层：注入域 / 令牌 / 场景锁定 / 停用工具数。
        push('injection-domains', '注入域开关', 'compat',
          domainsOn.length === 0 ? 'disabled' : 'ok',
          domainsOn.length === 0 ? '五个注入域全部关闭（用户设置）' : `${domainsOn.length}/5 个域开启：${domainsOn.join('、')}`)
        push('token', '访问令牌', 'compat',
          !token.active ? 'disabled' : token.accepted ? 'ok' : 'locked',
          !token.active ? '未启用（宿主没配令牌，或令牌功能被关掉）'
            : token.accepted ? '已生效且本次启动已通过验证' : '已生效，本次启动尚未验证：写操作与对话会被拦住，到本页下方填写令牌')
        push('scene-lock', '场景锁定', 'scenes',
          lockedScenes.length === 0 ? 'ok' : 'locked',
          lockedScenes.length === 0 ? '无锁定场景' : `锁定中：${lockedScenes.join('、')}（写门禁按锁定场景生效）`)
        push('mcp-tools', 'MCP 工具停用', 'mcp',
          disabledTools === 0 ? 'ok' : 'partial',
          disabledTools === 0 ? '没有停用的工具' : `${disabledTools} 个工具处于停用态（执行拦截 + 可见性摘除）`)
        // 工具表按每个请求付钱：这一行回答"这一轮实际发出去多少"。关掉的工具整份不进请求，
        // 但代价是模型调不到它们（本插件的面板不受影响）——所以是 partial，不是 ok。
        // **出厂默认关掉的那几条不算**：那是插件替用户做的一个可逆选择，不是用户关出了
        // 一个缺口。把默认态报成 partial 违背本页口径（琥珀只留给"该做却没做"），也永远
        // 无法消掉 —— 用户打开它们反而会被罚一个 ok。
        // 末尾那句是**逐会话**的差额：官方 `skill` 工具在场的会话里我们那份加载器会再让位
        // 一个（见 index.ts 的 CARRIER_DUPLICATES），本表的数字是全局口径、不含它。
        const table = deps.toolTableReport()
        const carrierNote = '；官方 `skill` 工具在场的会话，`skill_manager_read` 还会自动让位一份'
        const userOff = table.hiddenCount - table.defaultHiddenCount
        const offPart = table.hiddenCount === 0
          ? `${table.totalCount} 个工具全部下发（≈${table.totalTok} tok/轮）`
          : (userOff === 0
            ? `出厂默认关掉 ${table.defaultHiddenCount}/${table.totalCount} 个`
            : `关掉 ${table.hiddenCount}/${table.totalCount} 个（含出厂默认 ${table.defaultHiddenCount} 个）`)
            + `：一轮少发 ≈${table.hiddenTok} tok（现在 ≈${table.visibleTok} tok/轮，到「兼容」页的「模型工具表」可逐条打开；面板不受影响）`
        push('tool-table', '模型工具表', 'compat',
          userOff === 0 ? 'ok' : 'partial',
          offPart + carrierNote)
        push('native-delete', '宿主原生删除入口', 'compat',
          notes.has('workspace.delete-native') ? 'partial' : 'ok',
          notes.get('workspace.delete-native')?.detail ?? '宿主未提供原生删除入口（本插件自有完整序列）')
        // 身份 / 版本：与 compat-status 同一份数据。
        const identity = assessment?.identity
        const identityIssue = identity !== undefined && (identity.blockers.length > 0 || Object.values(identity.sameAsHost).some((same) => same === false))
        push('host-identity', '宿主身份与模块', 'compat',
          assessment === undefined ? 'unknown' : identityIssue ? 'degraded' : 'ok',
          assessment === undefined ? '能力探测不可用（归档服务未挂载）'
            : identityIssue ? '存在阻塞项：' + (identity?.blockers ?? []).join('；')
              : `模块与宿主同源（宿主 DSH ${identity?.version ?? '?'}）`)
        // 无独立装配点的域：没有上报就是正常（如实说明依据是"没有降级上报"）。
        for (const [key, label, tab] of [['memory', '记忆', 'memory'], ['prompts', '提示词', 'prompts'], ['subagents', '子智能体', 'subagents'], ['scenes', '场景档案', 'scenes']] as const) {
          push(key, label, tab, 'ok', '无降级上报（装配失败会出现在这里）')
        }
        return { ok: true, rows, generatedAt: Date.now() }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // patch 备份（改宿主配置前的整份副本）：列清单只读，清理按写门禁。
    // 每份备份里都是**明文**凭据，所以给一个显式出口让人能删掉多余的副本（理由见
    // cleanPatchBackups 的注释）。清单不带文件内容，只给名字 / 层级 / 时间 / 大小。
    'backups-list': async () => {
      const files = await deps.listPatchBackups()
      return { ok: true, files, total: files.length, totalSize: files.reduce((s, f) => s + f.size, 0) }
    },
    'backups-clean': async (args: any) => {
      // 口径是**每个层级各删最旧的几份**：`del` 是 `{ 层级: 份数 }`，键与 listPatchBackups
      // 给的层级标签同源（global / profile:<名> / legacy）。认不出的键天然落空（没有这个
      // 层级就没得删），非法值一律忽略 —— 参数畸形时**一份都不删**，这是安全的默认。
      const raw = (args && args.del) || {}
      const del: Record<string, number> = {}
      if (raw && typeof raw === 'object') {
        for (const key of Object.keys(raw)) {
          const n = Number((raw as Record<string, unknown>)[key])
          if (Number.isSafeInteger(n) && n >= 1 && n <= 20) del[key] = n
        }
      }
      const r = await deps.cleanPatchBackups(del)
      // 失败原因（文件被占用等）由界面按当前语言拼：这里只回结构化字段。回中文串会让
      // 英文界面原样露出中文（与 compat-status 的 summary 同一条纪律）。
      return {
        ok: true, removed: r.removed.length, kept: r.kept,
        ...(r.failed.length ? { failedCount: r.failed.length, failedNames: r.failed } : {}),
      }
    },
    // 注入实况（只读）：最近活跃会话里模型**真正看到**的五域文本 + 那一段对话的投递统计。
    // 回答"勾了开关到底送没送到"——界面配置与实际注入不一致时，这里一眼可见。
    'injection-live': async () => {
      const live = deps.getContextInjectorLive()
      if (live === null) return { ok: false, error: '注入通道未装配' }
      try { return { ok: true, ...live() } } catch (e) { return { ok: false, error: deps.message(e) } }
    },
  }
}
