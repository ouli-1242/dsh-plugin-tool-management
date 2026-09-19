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
  summarize,
  type CapabilityFinding,
  type HostAssessment,
} from '../compat/probe.js'
import { assessPresetReach, type PresetRosterLike } from '../compat/preset-reach.js'
import { pluginLog } from '../skills/service.js'
import type { InjectSettings, LiveInjectionSnapshot } from '../context-inject.js'

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
  getSessionsRegistry(): CompatRegistryLike | undefined
  /**
   * 宿主 tools 服务：preset-reach 用它数出当前 MCP 工具数。
   * `schemas()` 在宿主上是**同步**返回 `ToolSchema[]` 的（官方 dsh-tools 契约），这里不写死
   * 那个类型——本插件只需要"能 await 出一份带 name 的清单"，写宽一点免得官方换签名就红。
   */
  tools: { schemas(): unknown }
  readInjectSettings(force?: boolean): Promise<InjectSettings>
  injectSettingsOp(args: any): Promise<any>
  presetRoster(): PresetRosterLike | undefined
  listPatchBackups(): Promise<PatchBackupInfo[]>
  cleanPatchBackups(delByLevel: Record<string, number>): Promise<{ removed: string[]; failed: string[]; kept: number }>
  /**
   * 注入通道的实况快照读取器 —— 装配 / 卸载会改写它（apply 内的 `contextInjectorLive`），
   * 所以传 getter 而不是值，否则 op 会一直握着通道卸载前那份引用。
   */
  getContextInjectorLive(): (() => LiveInjectionSnapshot) | null
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
        // 每次刷新都留一条结构化日志：升级当天就能在日志里看到降级发生。
        if (force || !deps.compatLog.version || deps.compatLog.version !== assessment.identity.version) {
          deps.compatLog.version = assessment.identity.version
          void pluginLog()('compat/probe', {
            hostVersion: assessment.identity.version,
            summary,
            degraded: assessment.degraded.map((item: CapabilityFinding) => ({ id: item.id, state: item.state, detail: item.detail })),
            blockers: assessment.identity.blockers,
            sameAsHost: assessment.identity.sameAsHost,
          }).catch(() => {})
        }
        return {
          ok: true,
          host: { version: assessment.identity.version, modules: assessment.identity.modules },
          sameAsHost: assessment.identity.sameAsHost,
          unverified: assessment.identity.unverified,
          findings: assessment.findings,
          degraded: assessment.degraded,
          blockers: assessment.identity.blockers,
          mayDelete: assessment.mayDelete,
          verifiedVersion: VERIFIED_HOST_VERSION,
          expectedPeerRange: EXPECTED_PEER_RANGE,
          minHostVersion: EXPECTED_MIN_HOST_VERSION,
          generatedAt: assessment.generatedAt,
          summary,
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
    // 注入实况（只读）：最近活跃会话里模型**真正看到**的五域文本 + 本次运行的投递统计。
    // 回答"勾了开关到底送没送到"——界面配置与实际注入不一致时，这里一眼可见。
    'injection-live': async () => {
      const live = deps.getContextInjectorLive()
      if (live === null) return { ok: false, error: '注入通道未装配' }
      try { return { ok: true, ...live() } } catch (e) { return { ok: false, error: deps.message(e) } }
    },
  }
}
