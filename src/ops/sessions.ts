// 归档会话（History）域的 HTTP ops（2026-09-19 从 index.ts 的 handlers 表抽出）。
//
// 同一条纪律：只负责 op 实现，依赖显式传参；MCP 写后刷新、场景锁定守卫仍作用在组装后的
// 整张表上（见 index.ts）。
//
// 本域的 op 名：history-list / history-sessions / history-export-defaults / dir-list /
// history-archive / history-archive-batch / history-unarchive / history-delete /
// history-unarchive-batch / history-delete-batch / history-workspace-register /
// history-import / bundle-export / history-export / history-retention-get /
// history-retention-set。

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zipSync } from 'fflate'
import { detectFormat, parseGenericText, parseJsonlTranscript, parseMarkdownTranscript } from '../imports/parsers.js'
import { isValidPresetId } from '../prompts/preset-id.js'
import { defaultPersonasDir, validPersonaName } from '../subagents/service.js'
import { isInsideRoot } from '../paths.js'
import { planMemoryExport } from '../memories/service.js'

/** 批量目标的形状由 parseHistoryBatchTarget 产出、registry 消费，本文件不关心其内部结构。 */
type SessionsBatchTarget = unknown

/** history ops 用到的那一点注册表能力（整体 SessionsRegistry 的最小投影）。 */
interface SessionsRegistryLike {
  archivedSessionMetadata(): Promise<{ items: Array<{ sessionId: string; createdAt: number }> }>
  archivedSessionDetails?(): Promise<{ items: Array<{ sessionId: string; createdAt?: number; cwd?: string; title?: string; archivedAt?: number }> }>
  archivedAt?(sessionId: string): number | undefined
  listStoredHeaders?(): Promise<Array<{ id?: string; cwd?: string; createdAt?: number; origin?: string }>>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }>
  deleteSession(sessionId: string): Promise<{ deleted: true }>
  unarchiveSessions?(target: SessionsBatchTarget): Promise<{ unarchivedSessionIds: string[]; archivedSessionIds: string[] }>
  deleteArchivedSessions(target: SessionsBatchTarget): Promise<{
    requestedSessionIds: string[]
    deletedSessionIds: string[]
    skippedSessionIds: string[]
    failures: Array<{ sessionId: string; message: string }>
  }>
  registerWorkspace?(path: string, title?: string): Promise<unknown>
}

export interface SessionOpsDeps {
  /** 归档/历史注册表；未挂载时 undefined（各 op 据此返回明确错误，不崩页面）。 */
  getSessionsRegistry(): SessionsRegistryLike | undefined
  message(e: unknown): string
  readHistoryRetention(): Promise<{ retentionDays: number }>
  writeHistoryRetention(days: number): Promise<void>
  /** 保留期扫描（改了策略立刻扫一次，让 UI 反映新策略）。 */
  sweepHistory(): Promise<unknown>
  /** 归属分组：活登记 → 路径命中 → 按会话目录重建（history-list 与 history-sessions 同源）。 */
  buildHistoryGroups(registry: unknown, items: Array<{ sessionId: string; cwd?: string }>): Promise<{ groups: unknown; workspaces?: unknown }>
  /** 恢复后补回工作区记账。 */
  restoreWorkspaceAccounting(sessionIds: string[]): Promise<unknown>
  parseHistoryBatchTarget(target: unknown): { ok: true; target: SessionsBatchTarget } | { ok: false; error: string }
  /**
   * 官方建会话入口（ctx.agents.create）；不可用时不传，history-import 会如实报错。
   * 直接收官方那个签名 —— 不在这里另造一个更窄的形状，免得宿主换签名时两边对不上。
   */
  createSession?(input: Record<string, unknown>): Promise<unknown>
  /** 按名取宿主服务（sessions / sessionPersistence / sessionProjectionCache）。 */
  host<T = unknown>(name: string): T | undefined
  promptsDir: string
  rulesList(args: any): Promise<any>
  skillDetail(args: any): Promise<any>
  extractTurnsFromEvents(events: unknown[]): Array<{ role: 'user' | 'assistant'; text: string }>
  serializeTurns(turns: Array<{ role: 'user' | 'assistant'; text: string }>, format: 'markdown' | 'jsonl'): string
}

export function buildSessionOps(deps: SessionOpsDeps): Record<string, (args: any) => Promise<any>> {
  return {
    // History（归档会话管理）ops。只读：history-list / history-retention-get；
    // 写：history-archive / history-unarchive / history-delete / history-retention-set。
    // workspaceRegistry 缺失（补丁未生效）时返回明确错误，不崩页面。
    'history-list': async () => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未就绪：请检查宿主 workspaceRegistry 服务。' }
      try {
        const items = (typeof registry.archivedSessionDetails === 'function')
          ? (await registry.archivedSessionDetails()).items
          : (await registry.archivedSessionMetadata()).items.map((i) => ({ sessionId: i.sessionId, createdAt: i.createdAt, archivedAt: registry.archivedAt?.(i.sessionId) }))
        const { retentionDays } = await deps.readHistoryRetention()
        // 归属分组（best-effort）：活登记 → 路径命中 → 按会话目录重建。
        // 宿主删除工作区后登记消失，靠会话目录把分组补回来（详见 buildHistoryGroups）。
        const { groups, workspaces } = await deps.buildHistoryGroups(registry, items as Array<{ sessionId: string; cwd?: string }>)
        return { ok: true, items, groups, workspaces, retentionDays }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 枚举全部持久化会话（含未归档/冷会话）供导出弹窗选择；只读，不门控。
    // 标题经投影缓存 best-effort；任何一步失败只降级为缺字段。
    'history-sessions': async () => {
      const registry = deps.getSessionsRegistry()
      if (!registry || typeof registry.listStoredHeaders !== 'function') {
        return { ok: false, error: '当前环境不支持枚举全部会话（registry 未实现 listStoredHeaders）' }
      }
      try {
        const headers = await registry.listStoredHeaders()
        const archivedItems = typeof registry.archivedSessionDetails === 'function'
          ? (await registry.archivedSessionDetails()).items
          : (await registry.archivedSessionMetadata()).items
        const archived = new Set(archivedItems.map((i) => i.sessionId))
        const cache = deps.host<{ cachedSnapshot?(header: unknown, seq: number, fields: string[]): { values?: { title?: string } } }>('sessionProjectionCache')
        const items: Array<{ sessionId: string; cwd?: string; createdAt?: number; title?: string; archived: boolean; workspaceId?: string; groupId?: string; cwdMissing?: boolean }> = []
        for (const h of headers) {
          const sessionId = h && typeof h.id === 'string' ? h.id : undefined
          if (!sessionId) continue
          // 过滤子代理派生的会话：不占用用户会话列表，也不应出现在导出选择里。
          if ((h as { origin?: string }).origin === 'subagent') continue
          const item: { sessionId: string; cwd?: string; createdAt?: number; title?: string; archived: boolean; workspaceId?: string; groupId?: string; cwdMissing?: boolean } = {
            sessionId,
            archived: archived.has(sessionId),
          }
          if (typeof h.cwd === 'string' && h.cwd) item.cwd = h.cwd
          if (typeof h.createdAt === 'number' && Number.isFinite(h.createdAt)) item.createdAt = h.createdAt
          if (cache && typeof cache.cachedSnapshot === 'function') {
            try {
              const snap = cache.cachedSnapshot(h, 0, ['title'])
              if (snap && snap.values && typeof snap.values.title === 'string') item.title = snap.values.title
            } catch { /* title best-effort */ }
          }
          // 工作区目录可能已被删除/移动（孤儿会话）：best-effort 标记，供导出选择时识别。
          if (item.cwd) {
            try {
              const st = await stat(item.cwd)
              item.cwdMissing = !st.isDirectory()
            } catch { item.cwdMissing = true }
          }
          items.push(item)
        }
        // 归属分组（与 history-list 同源）：导出弹窗的工作区筛选按同一套组 id。
        const { groups } = await deps.buildHistoryGroups(registry, items)
        return { ok: true, items, groups }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 导出默认目录：桌面（存在时）否则用户主目录。只读，不门控。
    'history-export-defaults': async () => {
      let dir = homedir()
      try {
        const desktop = join(homedir(), 'Desktop')
        const st = await stat(desktop)
        if (st.isDirectory()) dir = desktop
      } catch { /* 桌面路径不可用 → 回退主目录 */ }
      return { ok: true, defaultDir: dir }
    },
    // 列出目录的子目录，供客户端「选择文件夹」弹窗逐级浏览。dir 为空时返回根
    // 视图（Windows 枚举盘符，其他平台返回 '/'）。只读，不门控。
    'dir-list': async (args: any) => {
      const raw = String((args && args.dir) || '').trim()
      try {
        if (!raw) {
          if (process.platform !== 'win32') return { ok: true, current: '/', parent: null, entries: [] }
          const drives: Array<{ name: string; path: string }> = []
          for (let c = 65; c <= 90; c++) {
            const root = String.fromCharCode(c) + ':\\'
            try { await stat(root); drives.push({ name: root, path: root }) } catch { /* 跳过不存在的盘符 */ }
          }
          return { ok: true, current: '', parent: null, entries: drives }
        }
        const st = await stat(raw)
        if (!st.isDirectory()) return { ok: false, error: '该路径不是目录' }
        const parent = dirname(raw)
        const names = await readdir(raw, { withFileTypes: true })
        const entries = names
          .filter((d) => d.isDirectory())
          .map((d) => ({ name: d.name, path: join(raw, d.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
        return { ok: true, current: raw, parent: parent === raw ? null : parent, entries }
      } catch (e) {
        return { ok: false, error: deps.message(e) }
      }
    },
    'history-archive': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      const sessionId = String((args && args.sessionId) || '').trim()
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      try { await registry.archiveSession(sessionId); return { ok: true, sessionId } } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 批量归档（导出弹窗「归档所选」）：把选中的会话收进 History，纳入保留期管理。
    'history-archive-batch': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      const rawIds = (args && args.sessionIds) || []
      const ids = Array.isArray(rawIds) ? rawIds.map((s: unknown) => String(s).trim()).filter(Boolean) : []
      if (!ids.length) return { ok: false, error: '请至少选择一个会话' }
      const archived: string[] = []
      const failed: Array<{ sessionId: string; error: string }> = []
      for (const sessionId of ids) {
        try { await registry.archiveSession(sessionId); archived.push(sessionId) }
        catch (e) { failed.push({ sessionId, error: deps.message(e) }) }
      }
      return { ok: true, archived, failed }
    },
    'history-unarchive': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      const sessionId = String((args && args.sessionId) || '').trim()
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      try {
        const r = await registry.unarchiveSession(sessionId)
        const workspace = await deps.restoreWorkspaceAccounting([sessionId])
        return { ok: true, archivedSessionIds: r.archivedSessionIds, ...(workspace ? { workspace } : {}) }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    'history-delete': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      const sessionId = String((args && args.sessionId) || '').trim()
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      try { await registry.deleteSession(sessionId); return { ok: true, sessionId, deleted: true } } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    'history-unarchive-batch': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      if (typeof registry.unarchiveSessions !== 'function') return { ok: false, error: '当前环境不支持批量恢复（registry 未实现 unarchiveSessions）' }
      const parsed = deps.parseHistoryBatchTarget(args && args.target)
      if (!parsed.ok) return parsed
      try {
        const r = await registry.unarchiveSessions(parsed.target)
        const workspace = await deps.restoreWorkspaceAccounting(r.unarchivedSessionIds || [])
        return { ok: true, unarchivedSessionIds: r.unarchivedSessionIds, archivedSessionIds: r.archivedSessionIds, ...(workspace ? { workspace } : {}) }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    'history-delete-batch': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      const parsed = deps.parseHistoryBatchTarget(args && args.target)
      if (!parsed.ok) return parsed
      try {
        const r = await registry.deleteArchivedSessions(parsed.target)
        return { ok: true, requestedSessionIds: r.requestedSessionIds, deletedSessionIds: r.deletedSessionIds, skippedSessionIds: r.skippedSessionIds, failures: r.failures }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 重新登记工作区（写宿主状态）：为「工作区已被删除、目录仍在」的分组补回一条登记。
    // 只在用户显式确认后调用；宿主 realpath 会拒绝不存在的目录，同路径已登记则幂等返回。
    // 不移动、不删除任何文件或会话 —— 但**会改写 `sessionIds` 记账**：`registerWorkspace`
    // 无条件调 `attachKnownSessions`，把该目录下已知的会话挂回这条登记（它自己的文档就
    // 写着"登记被删除时它的 sessionIds 记账一起没了"）。这是不可逆动作前唯一的确认依据
    // 文本，别写成"不影响记账"（界面文案 `hist.register.body`「只写工作区记账」是对得上的）。
    'history-workspace-register': async (args: any) => {
      const registry = deps.getSessionsRegistry()
      if (!registry) return { ok: false, error: '归档服务未挂载' }
      const path = String((args && args.path) || '').trim()
      if (!path) return { ok: false, error: '缺少工作区目录 path' }
      if (typeof registry.registerWorkspace !== 'function') {
        return { ok: false, error: '当前环境不支持重新登记工作区（registry 未实现 registerWorkspace）' }
      }
      const title = args && args.title ? String(args.title) : undefined
      try {
        const workspace = await registry.registerWorkspace(path, title)
        return { ok: true, workspace }
      } catch (e) { return { ok: false, error: deps.message(e) } }
    },
    // 从其他 Agent（Claude Code / Cursor JSONL、Codex Markdown、通用文本）导入对话，
    // 通过 sessions.create 的 seed 机制生成一个可继续对话的全新会话。
    'history-import': async (args: any) => {
      const fileName = String((args && args.fileName) || '').trim()
      const content = String((args && args.content) ?? '')
      if (!fileName || !content.trim()) return { ok: false, error: '缺少文件内容' }
      let turns: Array<{ role: 'user' | 'assistant'; text: string }>
      try {
        const format = detectFormat(fileName, content)
        turns = format === 'jsonl' ? parseJsonlTranscript(content)
          : format === 'markdown' ? parseMarkdownTranscript(content)
            : parseGenericText(content)
      } catch (e) {
        return { ok: false, error: '对话解析失败: ' + deps.message(e) }
      }
      if (!turns.length) return { ok: false, error: '未能从该文件中识别出对话内容' }
      if (typeof deps.createSession !== 'function') return { ok: false, error: '当前环境不支持创建会话（agents.create 不可用）' }
      // 仅接受绝对路径的 cwd；非法或缺失时会话不带目录（归入未分组）。
      const cwdArg = String((args && args.cwd) || '').trim()
      const cwd = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(cwdArg) ? cwdArg : undefined
      // seed 事件信封：seq 从 0 连续、time 为安全整数、surface 事件必须带 surfaceOp:'append'。
      const base = Date.now()
      const seed = turns.map((turn, i) => ({
        type: turn.role === 'user' ? 'user/message' : 'assistant/message',
        seq: i,
        time: base + i,
        data: turn.role === 'user'
          ? { id: 'msg-' + i, role: 'user', content: [{ type: 'text', text: turn.text }], source: { kind: 'typed' } }
          : { message: { id: 'msg-' + i, role: 'assistant', content: [{ type: 'text', text: turn.text }], source: { kind: 'model', provider: 'imported', model: 'imported' } }, turn: i, step: 0, stream: [] },
        surfaceOp: 'append',
      }))
      try {
        // `sessions.create()` 只创建裸 Session；它不经过 DSH agent factory / workspace
        // / session-log，所以返回的内存 id 不会进入 UI 的会话列表。必须走官方的
        // `ctx.agents.create()`，它会在同一事务里创建 Agent、发布 Session，并触发宿主
        // 的持久化与 projection 链路。这里使用 UUID，避免 SessionStore 的裸自增 id 与
        // 宿主 API 会话 id 空间混用。
        const id = 'session-' + randomUUID()
        await deps.createSession({ sessionId: id, seed, ...(cwd ? { meta: { cwd } } : {}) })
        const sessions = deps.host<{ get?(sessionId: string): unknown }>('sessions')
        const live = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
        if (live === undefined || live === null) {
          return { ok: false, error: `创建会话失败：宿主未登记该会话（${id}），未导入任何内容` }
        }
        return { ok: true, sessionId: id, count: turns.length }
      } catch (e) {
        return { ok: false, error: '创建会话失败: ' + deps.message(e) }
      }
    },
    // ---------- 通用导出（D14）----------
    // 技能 / 子智能体 / 提示词 / 记忆四个域的差异只有「从哪取哪些文件」，其余
    //（绝对路径校验、建目录、zip 打包、错误回报）完全相同 —— 所以只加**一个** op。
    // 打包用已在依赖里的 `fflate.zipSync`（此前只用了 unzipSync）。
    'bundle-export': async (args: any) => {
      const kind = String((args && args.kind) || '')
      const KINDS = ['skills', 'subagents', 'presets', 'memories']
      if (KINDS.indexOf(kind) < 0) return { ok: false, error: `kind 需为 ${KINDS.join(' / ')}` }
      const rawNames = (args && args.names) || []
      const names = Array.isArray(rawNames) ? rawNames.map((s: unknown) => String(s).trim()).filter(Boolean) : []
      if (!names.length) return { ok: false, error: '请至少选择一项' }
      // 名字逐项校验：子智能体与提示词这两个域的名字会被拼成绝对路径直接进 readFile，
      // `..` 或路径分隔符能读到根外（此前只做 trim().filter(Boolean)）。
      // 另外两个域**不套单段谓词**，原因不同：
      //   - 记忆：名字是 `<场景>/<名>` 的 id，只用来查索引拿路径，本身不参与拼接；
      //   - 技能：名字可以是多段相对路径（只读来源的 bundle 用 relative() 拼出名字），
      //     而路径本身由 skill-detail 从磁盘发现结果里取，名字只用于精确匹配条目 ——
      //     匹配不上就进 missing，套单段谓词反而会把合法的多段技能名误杀。
      const rejected: string[] = []
      const accepted = names.filter((name) => {
        const ok = kind === 'presets' ? isValidPresetId(name)
          : kind === 'subagents' ? validPersonaName(name)
            : true
        if (!ok) rejected.push(name)
        return ok
      })
      if (rejected.length) return { ok: false, error: `名称非法，已拒绝导出：${rejected.join('、')}` }
      if (!accepted.length) return { ok: false, error: '请至少选择一项' }
      const outDir = String((args && args.outDir) || '').trim()
      // 与 history-export 同一条校验：必须绝对路径（相对路径会在宿主进程的 cwd 下落盘，
      // 用户根本找不到文件）。
      if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(outDir)) return { ok: false, error: '导出目录需为绝对路径' }

      // ① 收集 (zip 内路径, 绝对路径)。
      const entries: Array<{ zip: string; abs: string }> = []
      const missing: string[] = []
      try {
        if (kind === 'subagents') {
          const dir = defaultPersonasDir()
          for (const name of accepted) {
            const abs = join(dir, `${name}.md`)
            // 名字已是单段，`join` 拼不出根外；这里再比一次是**后置断言** —— 一旦触发说明
            // 段名谓词有洞，宁可少导一项也不去读根外的文件。
            if (!isInsideRoot(dir, abs)) { missing.push(name); continue }
            entries.push({ zip: `${name}.md`, abs })
          }
        } else if (kind === 'presets') {
          for (const id of accepted) {
            const docAbs = join(deps.promptsDir, id, 'AGENTS.md')
            if (!isInsideRoot(deps.promptsDir, docAbs)) { missing.push(id); continue }
            entries.push({ zip: `${id}/AGENTS.md`, abs: docAbs })
            // 描述侧车（「只给使用者看」的那句）随预设一起走：导出再导入不该把它丢掉。
            const metaAbs = join(deps.promptsDir, id, 'meta.json')
            try { if ((await stat(metaAbs)).isFile()) entries.push({ zip: `${id}/meta.json`, abs: metaAbs }) } catch { /* 没写描述 */ }
          }
        } else if (kind === 'memories') {
          // 记忆有 flat（`<场景>/<name>.md`）与 bundle（`<场景>/<name>/<name>.md`）两种形态，
          // 且场景名本身可含 '/' —— 按 id 拼路径会把 bundle 读成 `<场景>/<name>.md`，读不到
          // 就静默丢项（详见 planMemoryExport）。所以走索引拿那条规则自己的真实路径。
          const r: any = await deps.rulesList({})
          const plan = planMemoryExport(accepted, (r && r.rules) || [])
          missing.push(...plan.missing)
          for (const item of plan.entries) {
            if (item.kind === 'file') {
              entries.push({ zip: item.zip, abs: item.abs })
              continue
            }
            // bundle：把目录内的文件全部打包（与技能分支同口径），单个目录读不了只丢它自己。
            try {
              for (const e of await readdir(item.abs, { withFileTypes: true })) {
                if (e.isFile()) entries.push({ zip: `${item.zip}/${e.name}`, abs: join(item.abs, e.name) })
              }
            } catch { missing.push(item.id) }
          }
        } else {
          // 技能：先经 skill-detail 拿源文件路径（bundle 型是目录，单文件型是 .md）。
          for (const key of accepted) {
            const i = key.indexOf('/')
            if (i <= 0) { missing.push(key); continue }
            const short = key.slice(i + 1)
            const r: any = await deps.skillDetail({ root: key.slice(0, i), name: short })
            const p = r && r.ok !== false && r.data ? String(r.data.path || '') : ''
            if (!p) { missing.push(key); continue }
            let isDir = false
            try { isDir = (await stat(p)).isDirectory() } catch { isDir = false }
            if (isDir) {
              for (const e of await readdir(p, { withFileTypes: true })) {
                if (e.isFile()) entries.push({ zip: `${short}/${e.name}`, abs: join(p, e.name) })
              }
            } else {
              entries.push({ zip: `${short}/${basename(p)}`, abs: p })
            }
          }
        }
      } catch (e) {
        return { ok: false, error: '收集待导出文件失败: ' + deps.message(e) }
      }

      // ② 读盘 + 打包（读不到的项进 missing，不整体失败 —— 部分成功也有价值）。
      // 上限是**病态保护**，不是策略：导入侧有 5 条限额（见 skills/core.js 的 MAX_UPLOAD_*），
      // 导出侧此前一条都没有 —— 选中一个塞了几百 MB 附件的 bundle 时，「全部正文 + 一份 zip」
      // 会同时驻留内存。超限**整体报错**而不是塞进 missing：静默少几个文件比报错更难查。
      const maxFileBytes = 32 * 1024 * 1024
      const maxTotalBytes = 256 * 1024 * 1024
      const asMb = (n: number) => Math.round(n / 1024 / 1024) + ' MB'
      const bundle: Record<string, Uint8Array> = {}
      let totalBytes = 0
      for (const item of entries) {
        try {
          const size = (await stat(item.abs)).size
          if (size > maxFileBytes) {
            return { ok: false, error: `导出内容过大：${item.zip} 约 ${asMb(size)}，单文件上限 ${asMb(maxFileBytes)}` }
          }
          if (totalBytes + size > maxTotalBytes) {
            return { ok: false, error: `导出内容过大：合计上限 ${asMb(maxTotalBytes)}，已累计 ${asMb(totalBytes)}，加上 ${item.zip} 会超出` }
          }
          bundle[item.zip] = new Uint8Array(await readFile(item.abs))
          totalBytes += size
        } catch { missing.push(item.zip) }
      }
      if (!Object.keys(bundle).length) return { ok: false, error: '没有可导出的文件（选中项都不存在？）' }

      let zipPath = ''
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        zipPath = join(outDir, `dsh-tool-management-${kind}-${stamp}.zip`)
        await mkdir(outDir, { recursive: true })
        await writeFile(zipPath, Buffer.from(zipSync(bundle)))
      } catch (e) {
        return { ok: false, error: '写入导出文件失败: ' + deps.message(e) }
      }
      return { ok: true, written: Object.keys(bundle).length, zipPath, missing }
    },
    // 把选中的归档会话导出为可再导入的转录文件（Markdown / JSONL），写入指定目录。
    // 每个会话一个文件；读不到正文的冷会话列入 skipped，不中断其余导出。
    'history-export': async (args: any) => {
      const rawIds = (args && args.sessionIds) || []
      const ids = Array.isArray(rawIds) ? rawIds.map((s: unknown) => String(s).trim()).filter(Boolean) : []
      if (!ids.length) return { ok: false, error: '请至少选择一个会话' }
      const format = String((args && args.format) || 'markdown').toLowerCase()
      if (format !== 'markdown' && format !== 'jsonl') return { ok: false, error: 'format 需为 markdown 或 jsonl' }
      const outDir = String((args && args.outDir) || '').trim()
      if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(outDir)) return { ok: false, error: '导出目录需为绝对路径' }
      const sessions = deps.host<{ get?(id: string): unknown }>('sessions')
      if (!sessions || typeof sessions.get !== 'function') return { ok: false, error: '当前环境不支持读取会话（sessions.get 不可用）' }
      // 读会话事件：先取活动 store；冷会话（进程重启后）从持久化后端恢复只读句柄。
      const readEvents = async (sessionId: string): Promise<unknown[] | undefined> => {
        const live = sessions.get!(sessionId)
        if (live && typeof (live as { snapshotEvents?: unknown }).snapshotEvents === 'function') {
          const ev = (live as { snapshotEvents(): unknown[] }).snapshotEvents()
          return Array.isArray(ev) ? ev : undefined
        }
        const persistence = deps.host<{ prepare?(id: string): Promise<unknown> }>('sessionPersistence')
        if (persistence && typeof persistence.prepare === 'function') {
          try {
            const prep = await persistence.prepare(sessionId)
            const ps = prep && (prep as { session?: unknown }).session
            try {
              if (ps && typeof (ps as { snapshotEvents?: unknown }).snapshotEvents === 'function') {
                const ev = (ps as { snapshotEvents(): unknown[] }).snapshotEvents()
                return Array.isArray(ev) ? ev : undefined
              }
            } finally {
              const dispose = (prep as { [Symbol.dispose]?: () => void })[Symbol.dispose]
              if (typeof dispose === 'function') dispose()
            }
          } catch { return undefined }
        }
        return undefined
      }
      try {
        await mkdir(outDir, { recursive: true })
      } catch (e) {
        return { ok: false, error: '创建导出目录失败: ' + deps.message(e) }
      }
      const ext = format === 'jsonl' ? '.jsonl' : '.md'
      const exported: Array<{ sessionId: string; fileName: string; path: string; count: number }> = []
      const skipped: Array<{ sessionId: string; error: string }> = []
      // 文件名归一是**有损映射**（`a/b` 与 `a_b` 都成 `a_b`），所以后缀一段短哈希把
      // 不同 sessionId 分开 —— 否则同一批导出里后者静默覆盖前者，用户只拿到一个文件
      // 却以为导出了 N 个（审计 T-26）。哈希只取 8 位、只用来区分，不追求不可逆。
      const digest = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 8)
      for (const sessionId of ids) {
        const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'session'
        const fileName = safe + '-' + digest(sessionId) + ext
        const path = join(outDir, fileName)
        try {
          const events = await readEvents(sessionId)
          const turns = deps.extractTurnsFromEvents(events || [])
          if (!turns.length) {
            skipped.push({ sessionId, error: events ? '会话中没有可导出的消息' : '无法读取会话内容（不在活动存储且无持久化句柄）' })
            continue
          }
          // `'wx'`：绝不覆盖已存在的同名文件 —— 覆盖是静默的，用户会以为导出成功
          // 而实际上把上一次的产物（或自己的文件）抹掉了。撞名就如实报 skipped。
          await writeFile(path, deps.serializeTurns(turns, format), { encoding: 'utf8', flag: 'wx' })
          exported.push({ sessionId, fileName, path, count: turns.length })
        } catch (e) {
          skipped.push({ sessionId, error: '导出失败: ' + deps.message(e) })
        }
      }
      return { ok: true, exported, skipped }
    },
    'history-retention-get': async () => {
      const { retentionDays } = await deps.readHistoryRetention()
      return { ok: true, retentionDays }
    },
    'history-retention-set': async (args: any) => {
      const days = Number((args && args.retentionDays) ?? -1)
      // 错误文案承诺的是「非负整数」，就按整数校验：1.5 这类小数以前会被静默取整成 1，
      // 用户看到的回执与输入不符。
      if (!Number.isSafeInteger(days) || days < 0) {
        return { ok: false, error: 'retentionDays 需为非负整数（0=永久不删除），收到: ' + String((args && args.retentionDays)) }
      }
      try {
        await deps.writeHistoryRetention(days)
      } catch (e) {
        return { ok: false, error: '写入保留期失败: ' + deps.message(e) }
      }
      // 设置变更后立即扫一次，UI 反映新策略。
      await deps.sweepHistory().catch(() => {})
      return { ok: true, retentionDays: days }
    },
  }
}
