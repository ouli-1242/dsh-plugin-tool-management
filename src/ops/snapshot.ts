// 整机迁移快照（0.15.0 C2）—— 一键带走全部配置，换机器 / 重装后一键放回来。
//
// 与另外两条出口的定位区分（用户裁定）：
//   · `mcpm-export` 只带 MCP 一个域；
//   · 「兼容」页的 patch 备份是**本机故障恢复**（同机、含明文、按层级轮转）；
//   · 这里是**跨机迁移**：一个目录，人能在上面看、能改、能版本管理。
//
// 两条设计约束：
//   ① 不新写任何语义。导入侧全部**经现有 op**（`mcpm-import` / `rules-import` /
//      `subagent-import` / `agentsmd-import` / `tool-table` / `inject-settings` /
//      `scene-archive-save` …），于是校验、写锁、门禁、缓存与目录重算都自动跟着原域走。
//      `invokeOp` 传进来的就是 handlers 表那一份 —— 场景锁定期间各域自己拒绝，这里不再判一套。
//   ② 默认**打码**。MCP 的 env / headers 里是明文凭据，一份要被拷去 U 盘 / 网盘 / 另一台机器的
//      导出物不该顺手把它们带走；要完整导出必须显式传 `includeSecrets:true`（界面二次确认）。
//      打码值导回来由 `secret-guard` 拿目标机的旧真值顶替（`mcpm-import` 既有的行为）。

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { maskSecretValue, maskUrlQuery } from '../mcp/secret-guard.js'

export interface SnapshotOpsDeps {
  /** handlers 表调用口：走 op 而不是走服务，门禁与写锁才与界面 / 模型是同一套。 */
  invokeOp(name: string, args: any): Promise<any>
  hubPath(...segments: string[]): string
  ensurePaths(): Promise<any>
  pluginVersion(): string
  /** 提示词域目录（默认就在 hub 里，宿主配置可覆盖 —— 由 index.ts 给权威值）。 */
  promptsDir(): string
  /** 快捷提示词库目录（`hub/quick-prompts/`），与预设同为"文件域"。 */
  quickPromptsDir(): string
  message(e: unknown): string
}

const SNAP_PREFIX = 'dsh-tool-management-snapshot-'
/** 快照目录里各部分的名字（导入侧按这些名字找东西，别改）。 */
const F_MANIFEST = 'manifest.json'
const F_MCP = 'mcp.json'
const F_SETTINGS = 'settings.json'
const F_SCENES = 'scenes.json'
const D_MEMORIES = 'memories'
const D_SUBAGENTS = 'subagents'
const D_PROMPTS = 'prompts'
const D_QUICK = 'quick-prompts'
const D_SKILLS = 'skills'
/** 四个"文件域"：整个目录打进一份 zip，键是相对路径。 */
const FILE_DOMAINS = [D_MEMORIES, D_SUBAGENTS, D_PROMPTS, D_QUICK]
const ALL_DOMAINS = ['mcp', D_MEMORIES, D_SUBAGENTS, D_PROMPTS, D_QUICK, D_SKILLS, 'settings', 'scenes']

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** 与 `bundle-export` 同一条判据：目标目录必须是绝对路径（相对路径会落到进程 CWD，那是猜）。 */
function absoluteDir(raw: unknown): string | null {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(s) ? resolve(s) : null
}

/**
 * 递归收一个目录里的所有文件（**相对该目录根**的路径 → 绝对路径）。
 * 目录不存在 = 空（这个域可能压根没用过）。
 * 只收普通文件、不跟随符号链接（`isFile()` 对 link 为 false）—— 迁移物里不该混进指向别处的链接。
 */
async function walk(root: string): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = []
  async function step(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries: Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of (entries || [])) {
      const abs = join(dir, e.name)
      const rel = prefix ? prefix + '/' + e.name : e.name
      if (e.isDirectory()) { await step(abs, rel, depth + 1); continue }
      if (e.isFile()) out.push({ rel, abs })
    }
  }
  try { if ((await stat(root)).isDirectory()) await step(root, '', 0) } catch { return out }
  return out
}

/**
 * 各 op 的返回形态不一（rows / personas / presets / scenes…），这里只为「条数与重名统计」取一份名字清单。
 * 取不到就是 0 —— 预览数字偏保守（少报重名）不影响导入本身，导入一律交给各域自己的 op。
 */
function namesOf(res: any, prefer: string[]): string[] {
  if (!res || res.ok === false) return []
  const bags = [res.data, res].filter(Boolean)
  for (const bag of bags) {
    for (const key of ['rows', 'personas', 'presets', 'prompts', 'scenes', 'skills', 'list', 'entries', 'items']) {
      const arr = (bag as Record<string, unknown>)[key]
      if (!Array.isArray(arr)) continue
      const names: string[] = []
      for (const item of arr) {
        if (typeof item === 'string') { names.push(item); continue }
        for (const field of prefer) {
          const v = item && (item as Record<string, unknown>)[field]
          if (typeof v === 'string' && v) { names.push(v); break }
        }
      }
      if (names.length) return names
    }
  }
  return []
}

/**
 * 从 `skill-state` 的返回里取「<来源>/<技能名>」清单。
 *
 * 为什么不能复用 `namesOf`（2026-09-30 审查 P1-6）：`skill-state` 的形状是
 * `{ ok, data: { roots: [{ key, skills: [{ name, declaredName, … }] }] } }` —— 顶层键是
 * `roots`，而 `namesOf` 只找 `rows / personas / presets / scenes / skills / list / entries /
 * items` 这些**数组**键，一个都对不上 → 恒返回 `[]` → 技能域**永远导出 0 项**，而界面显示的
 * 是"迁移完成"。key 用**声明名**（frontmatter `name`），口径与 `index.ts` 的
 * `skillArchiveKeysOfRoot` 一致（档案里存的就是声明名，用条目名拼会在 stale 校验里被丢掉）。
 */
function skillKeysOf(res: any): string[] {
  if (!res || res.ok === false) return []
  for (const bag of [res.data, res].filter(Boolean)) {
    const roots = (bag as Record<string, unknown>).roots
    if (!Array.isArray(roots)) continue
    const out: string[] = []
    for (const root of roots) {
      const rootKey = String((root as Record<string, unknown> | null)?.key || '')
      if (!rootKey) continue
      const skills = (root as Record<string, unknown>).skills
      if (!Array.isArray(skills)) continue
      for (const sk of skills) {
        const s = sk as Record<string, unknown> | null
        const name = String((s && (s.declaredName || s.name)) || '')
        if (name) out.push(rootKey + '/' + name)
      }
    }
    if (out.length) return out
  }
  return []
}

/** 场景清单（带 label / description / 提示词绑定）：`rules-list` 的 scenes 那一栏，读不到就是空。 */
function sceneRecordsOf(res: any): Array<{ name: string, label?: string, description?: string, prompt?: string }> {
  const bags = [res && res.data, res].filter(Boolean)
  for (const bag of bags) {
    const arr = (bag as Record<string, unknown> | undefined)?.scenes
    if (Array.isArray(arr)) {
      return arr
        .map((x: any) => (typeof x === 'string' ? { name: x } : {
          name: String((x && (x.name || x.scene)) || ''),
          label: x && typeof x.label === 'string' ? x.label : undefined,
          description: x && typeof x.description === 'string' ? x.description : undefined,
          prompt: x && typeof x.prompt === 'string' && x.prompt ? x.prompt : undefined,
        }))
        .filter((x) => x.name && x.name !== '_shared')
    }
  }
  return []
}

/**
 * 键值对打码：**走 `secret-guard` 的唯一口径**（`$VAR` / `!!js` 这类间接引用原样保留）。
 *
 * 这里曾经自己写了一份「所有键一律打成 `••••••`」的版本 —— 与 MCP 列表视图的口径不一致，
 * 结果是配置里的间接引用被当成密钥导出、导回来时 `resolveMaskedKv` 顶替不出真值只能丢键。
 * 打码形态只允许有一处定义（审查 P0-4）。
 */
function maskKv(map: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const k of Object.keys(map as Record<string, unknown>)) out[k] = maskSecretValue((map as Record<string, unknown>)[k])
  }
  return out
}

export function createSnapshotOps(deps: SnapshotOpsDeps): Record<string, (args: any) => Promise<any>> {
  /** 导出：产出一个**目录**（不是 zip）—— 用户要能直接看见里面带了什么、也方便手工挑着带。 */
  async function snapshotExport(args: any): Promise<any> {
    const outDir = absoluteDir(args && args.outDir)
    if (!outDir) return { ok: false, error: '导出目录必须是绝对路径' }
    const includeSecrets = args && args.includeSecrets === true
    await deps.ensurePaths()
    const dir = join(outDir, SNAP_PREFIX + stamp())
    try { await mkdir(dir, { recursive: true }) } catch (e) { return { ok: false, error: '创建快照目录失败: ' + deps.message(e) } }

    const domains: Record<string, number> = {}
    const notes: string[] = []

    // ── MCP：现有 op 的 JSON，默认打码 ─────────────────────────────────────────
    const mcpRes = await deps.invokeOp('mcpm-export', {})
    let mcpRows: any[] = []
    if (mcpRes && mcpRes.ok) {
      try {
        const parsed = JSON.parse(String(mcpRes.json || '{}'))
        mcpRows = Array.isArray(parsed.rows) ? parsed.rows : []
      } catch (e) { notes.push('MCP 导出解析失败: ' + deps.message(e)) }
    } else notes.push('MCP 没读到：' + String((mcpRes && mcpRes.error) || 'op 未返回内容'))
    const mcpOut = mcpRows.map((row) => {
      if (includeSecrets) return row
      const copy = Object.assign({}, row)
      if (copy.env) copy.env = maskKv(copy.env)
      if (copy.headers) copy.headers = maskKv(copy.headers)
      // URL 查询串走 `secret-guard.maskUrlQuery`（与 MCP 列表视图同一口径）。这里原先是**自写的
      // 一条窄正则** `([?&](?:key|token|secret|password)=)`，只认四个固定参数名 ——
      // `?api_key=` / `?access_token=` / `?sig=` / `?client_secret=` 这类 MCP 托管服务最常见的
      // 形态全部漏掉，而这正是「凭据挂在 URL 上」的主流写法。后果不是界面显示问题：默认
      // （`includeSecrets` 缺省 false）导出的 `mcp.json` 里就是**明文凭据**，而这份目录的用途
      // 就是拷去 U 盘 / 网盘 / 另一台机器（审查 P0-4）。
      if (typeof copy.url === 'string') copy.url = maskUrlQuery(copy.url)
      return copy
    })
    try {
      await writeFile(join(dir, F_MCP), JSON.stringify({ exportedAt: new Date().toISOString(), masked: !includeSecrets, rows: mcpOut }, null, 2), 'utf8')
    } catch (e) { return { ok: false, error: '写 mcp.json 失败: ' + deps.message(e) } }
    domains.mcp = mcpOut.length

    // ── 文件域：记忆 / 子智能体 / 提示词 / 快捷提示词，各打进一份 zip（键 = 相对路径）──
    const roots: Record<string, string> = {
      [D_MEMORIES]: deps.hubPath(D_MEMORIES),
      [D_SUBAGENTS]: deps.hubPath(D_SUBAGENTS),
      [D_PROMPTS]: deps.promptsDir(),
      [D_QUICK]: deps.quickPromptsDir(),
    }
    for (const kind of FILE_DOMAINS) {
      const files = await walk(roots[kind])
      if (files.length) {
        const bundle: Record<string, Uint8Array> = {}
        for (const f of files) {
          try { bundle[f.rel] = new Uint8Array(await readFile(f.abs)) } catch (e) { notes.push(kind + ' 跳过 ' + f.rel + '：' + deps.message(e)) }
        }
        try {
          await writeFile(join(dir, kind + '.zip'), Buffer.from(zipSync(bundle)))
        } catch (e) { notes.push(kind + ' 打包失败：' + deps.message(e)) }
      }
      domains[kind] = files.length
    }

    // ── 技能：源目录在外部（不在 hub），交给既有的 `bundle-export` 走它自己的收集路径 ──
    const skillState = await deps.invokeOp('skill-state', {})
    const skillKeys = skillKeysOf(skillState)
    if (!skillKeys.length) notes.push('技能这次没导出：没从 skill-state 读到「<来源>/<名字>」形态的清单')
    if (skillKeys.length) {
      const bundled = await deps.invokeOp('bundle-export', { kind: 'skills', names: skillKeys, outDir: join(dir, D_SKILLS) })
      if (bundled && bundled.ok) domains.skills = Number(bundled.written || 0)
      else notes.push('技能打包失败：' + String((bundled && bundled.error) || 'bundle-export 未返回内容'))
    } else domains.skills = 0

    // ── 侧车配置：三份设置都从各自的读 op 拿，不抄结构 ────────────────────────────
    const [toolTable, inject, sceneSettings] = await Promise.all([
      deps.invokeOp('tool-table', {}),
      deps.invokeOp('inject-settings', {}),
      deps.invokeOp('scene-settings', {}),
    ])
    await writeFile(join(dir, F_SETTINGS), JSON.stringify({
      exportedAt: new Date().toISOString(),
      toolTable: toolTable && toolTable.ok ? { hidden: toolTable.hidden || [], presets: toolTable.presets || [] } : null,
      inject: inject && inject.ok ? (inject.settings || null) : null,
      sceneSettings: sceneSettings && sceneSettings.ok ? (sceneSettings.settings || null) : null,
    }, null, 2), 'utf8')
    domains.settings = 1

    // ── 场景：档案（含 0.15.0 C1 的工具表绑定）+ 场景记录（label / 描述 / 提示词绑定）──
    const modeRes = await deps.invokeOp('scene-mode-get', {})
    const rulesRes = await deps.invokeOp('rules-list', {})
    const archives = (modeRes && modeRes.ok && modeRes.archives) || {}
    await writeFile(join(dir, F_SCENES), JSON.stringify({
      exportedAt: new Date().toISOString(),
      archives,
      records: sceneRecordsOf(rulesRes),
    }, null, 2), 'utf8')
    domains.scenes = Object.keys(archives).length

    const manifest = {
      pluginVersion: deps.pluginVersion(),
      exportedAt: new Date().toISOString(),
      masked: !includeSecrets,
      domains,
      notes,
    }
    await writeFile(join(dir, F_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
    return { ok: true, dir, manifest }
  }

  /** 读快照目录：清单 + 实际存在的部件路径。缺哪个域就是没导出过，不当错误。 */
  async function snapshotRead(dir: string): Promise<{ manifest: any; files: Record<string, string> } | { error: string }> {
    let manifestRaw = ''
    try { manifestRaw = await readFile(join(dir, F_MANIFEST), 'utf8') } catch { return { error: '这个目录里没有 manifest.json —— 不是本插件导出的快照目录' } }
    let manifest: any
    try { manifest = JSON.parse(manifestRaw) } catch (e) { return { error: 'manifest.json 读不动：' + deps.message(e) } }
    if (!manifest || typeof manifest !== 'object') return { error: 'manifest.json 形状不对' }
    const files: Record<string, string> = {}
    const parts = [F_MCP, F_SETTINGS, F_SCENES].concat(FILE_DOMAINS.map((d) => d + '.zip'))
    for (const p of parts) {
      try { if ((await stat(join(dir, p))).isFile()) files[p] = join(dir, p) } catch { /* 这一件没有 */ }
    }
    return { manifest, files }
  }

  async function snapshotPreview(args: any): Promise<any> {
    const dir = absoluteDir(args && args.dir)
    if (!dir) return { ok: false, error: '快照目录必须是绝对路径' }
    const read = await snapshotRead(dir)
    if ('error' in read) return { ok: false, error: read.error }
    const { manifest, files } = read
    const zipKey = (d: string) => d + '.zip'
    const current: Record<string, string[]> = {
      mcp: namesOf(await deps.invokeOp('mcpm-list', {}), ['serverName']),
      [D_SUBAGENTS]: namesOf(await deps.invokeOp('subagent-list', {}), ['name']),
      [D_PROMPTS]: namesOf(await deps.invokeOp('agentsmd-list', {}), ['id']),
      [D_QUICK]: namesOf(await deps.invokeOp('quickprompt-list', {}), ['id']),
      [D_MEMORIES]: namesOf(await deps.invokeOp('rules-list', {}), ['id']),
      scenes: sceneRecordsOf(await deps.invokeOp('rules-list', {})).map((r) => r.name),
    }
    const notes: string[] = []
    const domains: Array<{ domain: string, count: number, clashes: number }> = []

    if (files[F_MCP]) {
      let rows: any[] = []
      try { rows = (JSON.parse(await readFile(files[F_MCP], 'utf8')).rows) || [] } catch (e) { notes.push('mcp.json 读不动：' + deps.message(e)) }
      domains.push({ domain: 'mcp', count: rows.length, clashes: rows.filter((r) => current.mcp.indexOf(String(r.serverName || '')) >= 0).length })
    }
    for (const kind of FILE_DOMAINS) {
      if (files[zipKey(kind)]) {
        try {
          const entries = Object.keys(unzipSync(new Uint8Array(await readFile(files[zipKey(kind)]))))
          // 重名按"顶层条目名"比：人设是扁平文件（`<名>.md`），扩展名不算名字的一部分。
          const stripExt = kind === D_SUBAGENTS ? (n: string) => n.replace(/\.[^.]+$/, '') : (n: string) => n
          const top = [...new Set(entries.map((p) => stripExt(p.split('/')[0])))]
          domains.push({
            domain: kind,
            count: entries.length,
            clashes: top.filter((n) => current[kind].indexOf(n) >= 0).length,
          })
        } catch (e) { notes.push(kind + ' 的 zip 读不动：' + deps.message(e)) }
      } else domains.push({ domain: kind, count: 0, clashes: 0 })
    }
    if (files[F_SCENES]) {
      try {
        const parsed = JSON.parse(await readFile(files[F_SCENES], 'utf8'))
        const names = Object.keys(parsed.archives || {})
        domains.push({ domain: 'scenes', count: names.length, clashes: names.filter((n) => current.scenes.indexOf(n) >= 0).length })
      } catch (e) { notes.push('scenes.json 读不动：' + deps.message(e)) }
    }
    if (files[F_SETTINGS]) domains.push({ domain: 'settings', count: 1, clashes: 1 })
    if (manifest.domains && Number(manifest.domains.skills) > 0) {
      let zips: string[] = []
      try { zips = (await readdir(join(dir, D_SKILLS))).filter((n) => /\.zip$/i.test(n)) } catch { /* 没带技能 */ }
      domains.push({ domain: D_SKILLS, count: zips.length, clashes: 0 })
    }

    return {
      ok: true,
      dir,
      pluginVersion: String(manifest.pluginVersion || ''),
      exportedAt: String(manifest.exportedAt || ''),
      masked: manifest.masked !== false,
      domains,
      notes: (manifest.notes || []).concat(notes),
      missingDomains: ALL_DOMAINS.filter((d) => !domains.some((x) => x.domain === d && x.count > 0)),
    }
  }

  /**
   * 导入：逐域调**该域自己的 import op**，逐域回报成功 / 跳过。
   * 绝不一步写：界面必须先 `snapshot-preview`，用户勾过域、选过冲突策略才走到这里。
   */
  async function snapshotImport(args: any): Promise<any> {
    const dir = absoluteDir(args && args.dir)
    if (!dir) return { ok: false, error: '快照目录必须是绝对路径' }
    const domains: string[] = Array.isArray(args && args.domains) ? args.domains.map((x: unknown) => String(x)) : []
    if (!domains.length) return { ok: false, error: '没有勾选任何域' }
    const overwrite = (args && args.conflict) === 'overwrite'
    const read = await snapshotRead(dir)
    if ('error' in read) return { ok: false, error: read.error }
    const { files } = read
    const report: Array<{ domain: string, imported: number, skipped: number, error?: string, warnings?: string[] }> = []

    /**
     * 一个域失败只记在这一行上：迁移的意义正是「哪域没过来」看得清，不是整批回滚。
     *
     * `warning` 也要透传（2026-09-30 审查 P2-9）：各域的 import op 会用它报"带过来了但有
     * 东西被跳过"（`mcpm-import` 的「这些密钥已是打码占位符，请在编辑里重新填写」就是其中
     * 最重要的一条）。此前只取 imported/skipped，于是"迁移成功"的界面下藏着一份**需要用户
     * 动手补的密钥清单**，用户在另一台机器上等到调用工具时才发现。
     */
    async function run(domain: string, task: () => Promise<{ imported: number, skipped: number, warning?: string }>): Promise<void> {
      if (domains.indexOf(domain) < 0) return
      try {
        const r = await task()
        report.push({
          domain, imported: r.imported, skipped: r.skipped,
          ...(r.warning ? { warnings: [r.warning] } : {}),
        })
      } catch (e) {
        report.push({ domain, imported: 0, skipped: 0, error: deps.message(e) })
      }
    }

    await run('mcp', async () => {
      if (!files[F_MCP]) return { imported: 0, skipped: 0 }
      const raw = await readFile(files[F_MCP], 'utf8')
      const res = await deps.invokeOp('mcpm-import', overwrite ? { json: raw, conflict: 'overwrite' } : { json: raw })
      if (!res || res.ok === false) throw new Error(String((res && res.error) || 'mcpm-import 失败'))
      return {
        imported: (res.added || []).length + (res.overwritten || []).length,
        skipped: (res.skipped || []).length,
        // 「打码占位符被跳过」这类结论必须跟着走：它是用户要动手补的清单，不是内部细节。
        ...(typeof res.warning === 'string' && res.warning ? { warning: res.warning } : {}),
      }
    })

    await run(D_SUBAGENTS, async () => {
      const zip = files[D_SUBAGENTS + '.zip']
      if (!zip) return { imported: 0, skipped: 0 }
      const entries = unzipSync(new Uint8Array(await readFile(zip)))
      const filesArg: Array<{ name: string, data: string }> = []
      let skipped = 0
      for (const [rel, bytes] of Object.entries(entries)) {
        // 人设是扁平的 `<名>.md`：嵌套路径不是 subagent-import 认的形状，如实跳过。
        if (rel.indexOf('/') >= 0 || !/\.md$/i.test(rel)) { skipped += 1; continue }
        filesArg.push({ name: rel, data: Buffer.from(bytes).toString('base64') })
      }
      if (!filesArg.length) return { imported: 0, skipped }
      const res = await deps.invokeOp('subagent-import', { files: filesArg })
      if (!res || res.ok === false) throw new Error(String((res && res.error) || 'subagent-import 失败'))
      return { imported: (res.imported || []).length, skipped: skipped + (res.skipped || []).length }
    })

    // 两个提示词域同形：`<id>/<正文>` + 可选 `<id>/meta.json`，一次一份地导入。差别只在
    // 正文文件名与 op 名（快捷域没有独立的 import op，`create` 就是那个形状），所以共用一段。
    const importPromptLike = (domain: string, docName: string, importOp: string, updateOp: string) => run(domain, async () => {
      const zip = files[domain + '.zip']
      if (!zip) return { imported: 0, skipped: 0 }
      const entries = unzipSync(new Uint8Array(await readFile(zip)))
      const bodies: Record<string, string> = {}
      const metas: Record<string, any> = {}
      let skipped = 0
      for (const [rel, bytes] of Object.entries(entries)) {
        const parts = rel.split('/')
        if (parts.length !== 2) { skipped += 1; continue }
        const text = Buffer.from(bytes).toString('utf8')
        if (parts[1] === docName) bodies[parts[0]] = text
        else if (parts[1] === 'meta.json') { try { metas[parts[0]] = JSON.parse(text) } catch { /* 描述丢了不影响正文导入 */ } }
      }
      let imported = 0
      for (const id of Object.keys(bodies)) {
        const desc = String((metas[id] && metas[id].description) || '')
        const res = await deps.invokeOp(importOp, { id, content: bodies[id], description: desc })
        if (res && res.ok) { imported += 1; continue }
        // 同名一律拒（两个 import 口都不覆盖）。覆盖模式下改走 upsert 那条 update 路径。
        if (!overwrite) { skipped += 1; continue }
        const upd: any = await deps.invokeOp(updateOp, { id, nextId: id, content: bodies[id], description: desc })
        if (upd && upd.ok) imported += 1
        else skipped += 1
      }
      return { imported, skipped }
    })

    await importPromptLike(D_PROMPTS, 'AGENTS.md', 'agentsmd-import', 'agentsmd-update')
    await importPromptLike(D_QUICK, 'PROMPT.md', 'quickprompt-create', 'quickprompt-update')

    await run(D_MEMORIES, async () => {
      const zip = files[D_MEMORIES + '.zip']
      if (!zip) return { imported: 0, skipped: 0 }
      const entries = unzipSync(new Uint8Array(await readFile(zip)))
      // zip 的相对路径就是 `<场景>/<文件>`：按场景分组，每组各调一次 rules-import。
      const byScene: Record<string, Array<{ name: string, data: string }>> = {}
      let skipped = 0
      for (const [rel, bytes] of Object.entries(entries)) {
        const i = rel.indexOf('/')
        if (i <= 0) { skipped += 1; continue }
        const scene = rel.slice(0, i)
        const name = rel.slice(i + 1)
        // 附件目录（`<场景>/<名>/附件…`）不是 rules-import 的形状：如实跳过，不假装带过来了。
        if (name.indexOf('/') >= 0 || !name) { skipped += 1; continue }
        ;(byScene[scene] || (byScene[scene] = [])).push({ name, data: Buffer.from(bytes).toString('base64') })
      }
      let imported = 0
      const reasons: string[] = []
      for (const scene of Object.keys(byScene)) {
        const res = await deps.invokeOp('rules-import', { scene, files: byScene[scene] })
        if (!res || res.ok === false) { skipped += byScene[scene].length; continue }
        const data = res.data || res
        imported += (data.imported || []).length
        const skippedRows = Array.isArray(data.skipped) ? data.skipped : []
        skipped += skippedRows.length
        // `rules-import` 的 skipped 是 `{name, reason}` —— 只数个数会把「为什么没过来」
        // 丢掉，而那正是用户要照着修的东西（名字不合法 / 正文超限 / 附件重名）。
        // 上限 5 条：这是提示不是日志，界面上一行放不下更多（审查 P2-9 同一条口径）。
        for (const row of skippedRows.slice(0, 5)) {
          const name = String((row && row.name) || '')
          const reason = String((row && row.reason) || '')
          if (reason) reasons.push(`${name ? name + '：' : ''}${reason}`)
        }
      }
      return { imported, skipped, ...(reasons.length ? { warning: reasons.join('；') } : {}) }
    })

    await run('scenes', async () => {
      if (!files[F_SCENES]) return { imported: 0, skipped: 0 }
      const parsed = JSON.parse(await readFile(files[F_SCENES], 'utf8'))
      const archives = parsed.archives || {}
      const records: Record<string, any> = {}
      for (const r of (parsed.records || [])) if (r && r.name) records[String(r.name)] = r
      let imported = 0
      let skipped = 0
      for (const scene of Object.keys(archives)) {
        const rec = records[scene] || {}
        const withPrompt = { name: scene, label: rec.label, description: rec.description, ...(rec.prompt ? { prompt: rec.prompt } : {}) }
        let created = await deps.invokeOp('rules-create-scene', withPrompt)
        if (!created || created.ok === false) {
          // 提示词预设可能还没过来（或名字变了）：那就先不带绑定建场景，档案照存。
          if (rec.prompt) created = await deps.invokeOp('rules-create-scene', { name: scene, label: rec.label, description: rec.description })
        }
        if ((!created || created.ok === false) && !/已存在|exist/i.test(String((created && created.error) || ''))) {
          skipped += 1
          continue
        }
        const saved = await deps.invokeOp('scene-archive-save', { scene, archive: archives[scene] })
        if (saved && saved.ok) imported += 1
        else skipped += 1
      }
      return { imported, skipped }
    })

    await run('settings', async () => {
      if (!files[F_SETTINGS]) return { imported: 0, skipped: 0 }
      const s = JSON.parse(await readFile(files[F_SETTINGS], 'utf8'))
      let done = 0
      let skipped = 0
      const write = async (op: string, args: any, has: boolean) => {
        if (!has) { skipped += 1; return }
        const r = await deps.invokeOp(op, args)
        if (r && r.ok !== false) done += 1
        else skipped += 1
      }
      await write('tool-table', { set: true, hidden: (s.toolTable && s.toolTable.hidden) || [] }, !!s.toolTable)
      await write('inject-settings', { set: true, ...(s.inject || {}) }, !!s.inject)
      await write('scene-settings', { set: true, ...(s.sceneSettings || {}) }, !!s.sceneSettings)
      return { imported: done, skipped }
    })

    await run(D_SKILLS, async () => {
      const skillDir = join(dir, D_SKILLS)
      let zips: string[] = []
      try { zips = (await readdir(skillDir)).filter((n) => /\.zip$/i.test(n)).map((n) => join(skillDir, n)) } catch { return { imported: 0, skipped: 0 } }
      let imported = 0
      let skipped = 0
      for (const zip of zips) {
        // 走 `skill-upload`（把 zip 读成 base64）而**不是** `skill-import`（2026-09-30 审查 P1-6）：
        // 导出侧产出的是 `bundle-export` 打的**一个 zip**（内含 `<技能名>/<文件>`），而
        // `skill-import` 的 `analyzeSource` 用 `lstat` + `endsWith('.md')` 判定来源，**完全不认识
        // `.zip`** —— 喂过去必然 `error.source.unrecognized`，该域整行报错。zip 的解包只存在于
        // `skill-upload` 这条链（`importUploadedSkill` → `prepareUploadedSource` → `writeUploadedZip`）；
        // 已实测它能正确吃下这种形态（`<技能名>/SKILL.md` → 落 `hub/skills/<技能名>/`）。
        let b64: string
        try { b64 = (await readFile(zip)).toString('base64') } catch (e) {
          throw new Error(`读取技能包失败：${deps.message(e)}`)
        }
        const res = await deps.invokeOp('skill-upload', {
          name: basename(zip).replace(/\.zip$/i, ''),
          zip: b64,
          ...(overwrite ? { conflict: 'overwrite' } : {}),
        })
        if (!res || res.ok === false) throw new Error(String((res && res.error) || 'skill-upload 失败'))
        const data = res.data || {}
        imported += (data.imported || []).length
        skipped += (data.skipped || []).length + (data.failed || []).length
      }
      return { imported, skipped }
    })

    return { ok: true, dir, conflict: overwrite ? 'overwrite' : 'skip', report }
  }

  return {
    'snapshot-export': snapshotExport,
    'snapshot-preview': snapshotPreview,
    'snapshot-import': snapshotImport,
  }
}
