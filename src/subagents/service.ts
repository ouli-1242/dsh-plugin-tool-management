// 人设运行侧（provider 挂载 + 一次委派），2026-10-01 从本文件的工厂体剥出。
import { createRunProvider } from "./run-provider.js"
// src/subagents/service.ts —— 轻量子智能体：人设发现（TTL 扫描）+ 官方 ctx.subagents.start 薄封装。
// 设计 §3：人设 = $DSH_HOME/tool-management/agents/<name>.md（frontmatter 可选，缺省派生）；v1 串行运行；
// provider 缺失时经 createRequire 挂载宿主侧包：`spawn`（新会话，默认）与 `fork`（继承本次会话）。
//
// v0.4 目录变更：人设由 `$DSH_HOME/subagents/` 搬到 `$DSH_HOME/tool-management/agents/`
// （插件产生的文件统一收在 tool-management/ 下）。旧目录在首次扫描时搬入，见 relocateLegacyPersonas。
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidSegment } from '../paths.js'
import { resolveDshHome } from '../skills/core.js'
// 深度探针与注入通道共用一份实现（口径分叉就会出现"目录说不能、工具却能"的错配）。
// 方向是 service → context-inject，单向：context-inject 不 import 本模块。
import { subagentDepthOf } from '../context-inject.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry } from '../hub.js'
import { expandUploads, planPersonaImport } from '../imports/upload.js'
import {
  catalogDepthOf,
  emptyResultNote,
  parsePersona,
  renderPersonaPrompt,
  RESULT_MAX,
  textOfBlocks,
} from './persona-parse.js'
import { decideToolFilter } from './tool-filter.js'
import { serializePersona, validPersonaName } from './persona-write.js'
import type { PersonaDoc, SubagentService, ToolFilter } from './persona-types.js'

// 拆出四层后 subagents/service.js 的公开面照旧（index.ts、ops/sessions.ts、scenes/candidates.ts、
// subagents/tools.ts 与契约测试都按这个路径引）。
export {
  catalogInjectedAt,
  catalogDepthOf,
  DEFAULT_PERSONA_CATALOG_DEPTH,
  emptyResultNote,
  neutralizePromptVariables,
  normalizeReasoningEffort,
  parsePersona,
  parsePresetToolRules,
  renderPersonaPrompt,
  REASONING_EFFORT_MAX_LENGTH,
  textOfBlocks,
  UNLIMITED_PERSONA_CATALOG_DEPTH,
} from './persona-parse.js'
export { presetRulesOf, serializePersona, validPersonaName } from './persona-write.js'
export { decideToolFilter } from './tool-filter.js'
export type { PersonaDoc, PresetToolRule, SubagentService, ToolFilter, ToolFilterDecision } from './persona-types.js'

const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** 人设默认目录：`$DSH_HOME/tool-management/subagents/`（域 = 子智能体，工具 `subagent_manager_*`）。 */
export function defaultPersonasDir(): string {
  return join(resolveDshHome(), 'tool-management', 'subagents')
}

/**
 * 旧目录 `$DSH_HOME/subagents/` → `tool-management/subagents/` 一次性搬移（幂等）。
 * （hub 内 `agents/` → `subagents/` 的改名由 hub.ts 的启动迁移负责。）
 * 只在目标不存在同名文件时搬（绝不覆盖）；源目录保留空壳。每个进程只跑一次。
 */
let personasRelocated = false
async function relocateLegacyPersonas(dir: string): Promise<void> {
  if (personasRelocated) return
  personasRelocated = true
  const legacy = join(resolveDshHome(), 'subagents')
  if (legacy === dir) return
  let names: string[]
  try {
    names = (await readdir(legacy)).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return
  }
  if (!names.length) return
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  for (const name of names) {
    const from = join(legacy, name)
    const to = join(dir, name)
    try {
      const exists = await stat(to).then(() => true).catch(() => false)
      if (exists) continue
      await rename(from, to)
    } catch {
      /* 单项失败（被占用等）不阻断其余；保留源文件，下次启动再试 */
    }
  }
}

export function createSubagentService(ctx: any, opts?: { subagentsDir?: string; stateDir?: string }): SubagentService {
  const dir = opts?.subagentsDir || defaultPersonasDir()
  const stateDir = opts?.stateDir && opts.stateDir.trim() !== '' ? opts.stateDir : join(resolveDshHome(), 'tool-management')
  const stateFile = join(stateDir, 'subagents-index.json')
  const req = createRequire(import.meta.url)

  let cache: { at: number; value: PersonaDoc[] } | null = null

  // ── 写操作串行队列 ──────────────────────────────────────────────────────
  // 状态文件的「读-改-写」必须整体串行：两个并发开关各自读到同一份快照、各自写回，
  // 后写的会把先写的改动抹掉（用户关掉的人设会自己回来）。人设文件的建/改/删也走这里，
  // 否则「查重 → 写入」之间的空窗会让两次同名导入互相覆盖。
  // 与 rules / skills 两域同一实现（`then(task, task)` 让前一个失败后队列照样继续）。
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const enqueueMutation = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(task, task)
    mutationQueue = queued.catch(() => undefined)
    return queued
  }

  // ── 人设启用集合（子智能体开关）────────────────────────────────────────
  // subagents-index.json：{ version: 1, enabled: string[] }（与 memories-index.json 同目录约定）。
  //   - 文件**缺失** = **全部启用**（老用户升级零感知，行为与开关上线前一致）；
  //   - 文件**存在但解析失败** = **全部停用** + 告警一次（fail-closed：损坏不该把用户停用的
  //     人设一次性重新暴露给模型，且用户看不到任何提示；与 rules 域索引隔离同口径）；
  //   - 文件一旦写出即为权威：之后新建/导入/回收站恢复的人设**自动启用**（刚建就想用是常理）；
  //   - 停用只影响注入与 subagent_* 工具的可见性，人设文件一个字节不动。
  // 缓存约定：undefined = 还没读过盘；null = 文件缺失（全部启用）；数组 = 权威集合。
  let enabledCache: string[] | null | undefined = undefined
  // 与缓存配对的文件指纹（mtimeMs；文件不存在时 null）。**必须比对指纹**：这个文件可能被
  // 另一个 DSH 实例（多 profile 共享 state 目录）或手工编辑改动，只在自身写入时失效缓存
  // 会让插件一直返回旧集合 —— 用户停用的人设悄悄回来。一次 stat 比重新读 + 解析便宜，
  // 而且立刻跟上外部改动，不引入新的 TTL 窗口。
  let enabledStamp: number | null = null
  // 解析失败只告警一次：readEnabled 每次读都会走到那段，不设标志会刷屏。
  let warnedBrokenState = false
  /** 文件 mtimeMs；不存在或读不到时 null（与「文件缺失」同一判定）。 */
  const fileStamp = async (path: string): Promise<number | null> => {
    try {
      return (await stat(path)).mtimeMs
    } catch {
      return null
    }
  }
  async function readEnabled(): Promise<string[] | null> {
    const stamp = await fileStamp(stateFile)
    if (enabledCache !== undefined && stamp === enabledStamp) return enabledCache
    // 用局部变量过渡：await 之后 TS 对闭包级缓存变量的收窄会失效，直接返回会报 undefined。
    let next: string[] | null
    let text: string | null
    try {
      text = await readFile(stateFile, 'utf8')
    } catch {
      text = null
    }
    if (text === null) {
      // 文件不存在 → 全部启用（升级零感知，见上方约定）。
      next = null
    } else {
      try {
        const raw = JSON.parse(text)
        next = Array.isArray(raw && raw.enabled) ? raw.enabled.map((x: unknown) => String(x)) : []
      } catch (e) {
        // 文件**存在**却解析失败 → fail-closed 成「谁都不启用」。沿用「全部启用」会把用户
        // 停用的人设一次性全部重新暴露给模型，而用户看不到任何提示；空集合至少可见、可恢复
        // （重新开启即可）。文件本身一个字节不动，修好后重启即恢复。
        if (!warnedBrokenState) {
          warnedBrokenState = true
          ctx.logger?.warn?.(`[dsh-plugin-tool-management] 人设索引解析失败（${message(e)}）；已按「全部停用」处理，请检查 ${stateFile}`)
        }
        next = []
      }
    }
    enabledCache = next
    enabledStamp = stamp
    return next
  }
  async function writeEnabled(list: string[]): Promise<void> {
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify({ version: 1, enabled: list }, null, 2), 'utf8')
    enabledCache = list
    // 写入后重取指纹，让下一次 readEnabled 直接命中缓存（否则会白读一次）。
    enabledStamp = await fileStamp(stateFile)
  }
  /** 新建/导入/恢复的人设默认停用（v0.8.5 用户裁定，与技能 / MCP 同口径）：
   *  文件缺失（含旧数据）时先把「全部启用」物化成显式全集**并排除新名**——
   *  否则新名会随"文件缺失=全启用"的兼容语义被误判为启用。已有显式集合时新名
   *  不在集合里，天然停用，无需写盘。 */
  async function materializeEnabledExcluding(names: string[]): Promise<void> {
    const set = await readEnabled()
    if (set !== null) return
    const docs = await list()
    await writeEnabled(docs.map((d) => d.name).filter((n) => names.indexOf(n) < 0))
    cache = null
  }
  /** 改名跟随：旧名在集合里就改新名；不在（停用中）保持停用。 */
  async function renamePersonaInEnabled(from: string, to: string): Promise<void> {
    const set = await readEnabled()
    if (set === null) return
    const i = set.indexOf(from)
    if (i < 0) return
    set[i] = to
    await writeEnabled(set)
  }
  /** 删除后从集合摘掉，别留悬空名（列表时无害，但会让集合越攒越脏）。 */
  async function removePersonaFromEnabled(name: string): Promise<void> {
    const set = await readEnabled()
    if (set === null || set.indexOf(name) < 0) return
    await writeEnabled(set.filter((n) => n !== name))
  }
  /**
   * 启用集合的「跟随写」失败**不能吞**。原先这五处一律 `.catch(() => undefined)`，
   * 而写盘失败时后果是静默改变开关状态：新建/导入/恢复的人设会停在**启用**态（下一轮就进
   * 模型上下文），改名的人设会停在**停用**态 —— 用户看到的却都是成功。
   *
   * 沿用 `sceneSyncError` 的形状：只给**原因原文**，句子由界面按当前语言拼。
   */
  async function withEnabledNote(res: any, task: () => Promise<void>): Promise<any> {
    try {
      await task()
      return res
    } catch (e) {
      const reason = message(e)
      return res && res.ok === false
        ? { ...res, error: `${res.error}；另外，启停状态没能同步（${reason}）` }
        : { ...res, stateSyncError: reason }
    }
  }
  /** list() 输出统一附上 enabled：文件缺失 → 全 true；否则按集合。 */
  function withEnabled(docs: PersonaDoc[], set: string[] | null): PersonaDoc[] {
    if (set === null) return docs.map((d) => ({ ...d, enabled: true }))
    return docs.map((d) => ({ ...d, enabled: set.indexOf(d.name) >= 0 }))
  }

  async function list(): Promise<PersonaDoc[]> {
    let docs: PersonaDoc[]
    if (cache && Date.now() - cache.at < 1000) {
      docs = cache.value
    } else {
      // 旧目录搬家放在首次扫描前（幂等；失败不阻断，旧目录仍会被下面的读取兜底看到）。
      await relocateLegacyPersonas(dir).catch(() => undefined)
      const fresh: PersonaDoc[] = []
      try {
        const entries = await readdir(dir)
        // 只列**能管得动**的人设（2026-09-30 审查 P2-18）：`validPersonaName` 走
        // `paths.ts` 的 `isValidSegment`，隐藏名（`.foo`）被判 `hidden` —— 于是此前列表里
        // 会出现一个「看得见、改不了、删不掉」的人设（任何 op 都拒它）。同一条谓词在这里
        // 收口；大小写也按 `relocateLegacyPersonas` 的 `toLowerCase()` 口径统一（`A.MD` 在
        // 那边算人设、在这边不算，是同一个分叉的另一半）。
        for (const fileName of entries.filter((e) => !e.startsWith('.') && e.toLowerCase().endsWith('.md')).sort()) {
          const raw = await readFile(join(dir, fileName), 'utf8').catch(() => '')
          if (!raw.trim()) continue
          fresh.push({ ...parsePersona(raw, fileName.slice(0, -3)), path: join(dir, fileName) })
        }
      } catch { /* 目录缺失 = 无人设 */ }
      cache = { at: Date.now(), value: fresh }
      docs = fresh
    }
    return withEnabled(docs, await readEnabled())
  }

  // provider 在场性（设计 §3.2，落地方式见 cordis.patch.yml 的取舍注释）：
  // 官方通道探测（ctx.subagents.list()）→ 缺失才挂载 → 失败把原因原样带出（不吞、不谎报）。
  // 不是一次性静默标记：每次调用都先探测，宿主后来注册了 provider 也能立刻跟上。
  //
  // 两个 provider（2026-09-17 加 fork，理由见 runOnce 的通道说明）：
  //   spawn = 新起的独立会话（默认）；fork = **继承本次会话已完成的对话**（官方 subagent_fork 用的是它）。
  // ---------- 运行侧：provider 挂载与一次委派（0.16.x 设计 §3.2） ----------
  // 正文 2026-10-01 整段搬到 ./run-provider.js（一字未改，只把 ctx / req / message 三个
  // 闭包名字改走 deps）。`req` 由**这里**造好再传过去：provider 包是按 service.js 自己的
  // 位置解析的，把 createRequire 那行搬走等于换解析基准。
  const { runSerial } = createRunProvider({ ctx, req, message })

  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生）。 */
  const writeOps = new Set([
    'subagent-create', 'subagent-update', 'subagent-delete', 'subagent-import',
    'subagent-toggle', 'subagent-trash-restore', 'subagent-trash-delete',
  ])
  const ops: Record<string, (args: any) => Promise<any>> = {
    'subagent-list': async () => {
      const docs = await list()
      return {
        ok: true,
        // catalogDepth 报**生效值**（没写就是默认 1），界面与模型都不必各自知道默认是多少。
        // 手写 map：新增字段必须**两处都加**（list 与 get），少一处就是界面读不到。
        subagents: docs.map((p) => ({ name: p.name, enabled: p.enabled !== false, description: p.description, provider: p.provider ?? null, model: p.model ?? null, reasoningEffort: p.reasoningEffort ?? null, tools: p.tools ?? null, toolsDeny: p.toolsDeny ?? null, toolsByPreset: p.toolsByPreset ?? null, catalogDepth: catalogDepthOf(p), output: p.output ?? null })),
      }
    },
    'subagent-get': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      const docs = await list()
      const p = docs.find((d) => d.name === name)
      if (!p) return { ok: false, error: `人设不存在: ${name}` }
      return { ok: true, persona: { name: p.name, description: p.description, provider: p.provider ?? '', model: p.model ?? '', reasoningEffort: p.reasoningEffort ?? '', tools: p.tools ?? [], toolsDeny: p.toolsDeny ?? [], toolsByPreset: p.toolsByPreset ?? {}, catalogDepth: catalogDepthOf(p), output: p.output ?? '', body: p.body } }
    },
    'subagent-create': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}（≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (exists) return { ok: false, error: `人设已存在: ${name}` }
      // 目录必须先建：v0.4 起人设落在 hub 内的 agents/，全新安装时它还不存在
      // （旧版本落在 $DSH_HOME/subagents/，那个目录一直有人建，所以这个坑以前不显形）。
      try {
        await mkdir(dir, { recursive: true })
      } catch (e) {
        return { ok: false, error: `创建人设目录失败: ${dir}（${message(e)}）` }
      }
      await writeFile(target, serializePersona(args), 'utf8')
      // v0.8.5：新建默认不启动——显式集合下新名天然停用；文件缺失时先物化全集并排除新名。
      cache = null
      return withEnabledNote({ ok: true, name }, () => materializeEnabledExcluding([name]))
    },
    /**
     * 保存人设，**可选改名**（nextName）。
     * 人设名就是文件名（`agents/<名>.md`），所以改名 = 重命名文件；
     * 目标名已存在直接拒绝，绝不覆盖别人的文件。
     * 返回 `renamedFrom` 供调用方把场景档案里的绑定一起改掉（档案存的是人设名）。
     */
    'subagent-update': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (!exists) return { ok: false, error: `人设不存在: ${name}` }
      let finalName = name
      let renamedFrom: string | undefined
      const nextRaw = args && args.nextName !== undefined ? String(args.nextName).trim() : ''
      if (nextRaw !== '' && nextRaw !== name) {
        if (!validPersonaName(nextRaw)) {
          return { ok: false, error: `新人设名不合法: ${nextRaw}（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）` }
        }
        const nextTarget = join(dir, nextRaw + '.md')
        const taken = await readFile(nextTarget, 'utf8').then(() => true).catch(() => false)
        if (taken) return { ok: false, error: `人设已存在: ${nextRaw}` }
        finalName = nextRaw
        renamedFrom = name
      }
      // 先把新内容写进临时文件、再一次性改名到位。原先的顺序是「先 rename 旧文件 → 再
      // writeFile 新文件」，writeFile 一旦失败就留下「新名字 + 旧内容」的半态 —— 用户看到
      // 改名成功、内容却还是旧的。临时名以 `.` 开头且不以 `.md` 结尾，扫描时天然被忽略。
      const finalTarget = join(dir, finalName + '.md')
      const tmp = join(dir, `.${finalName}.tmp-${process.pid}-${Date.now()}`)
      try {
        await writeFile(tmp, serializePersona({ ...args, name: finalName }), 'utf8')
        await rename(tmp, finalTarget)
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined)
        return { ok: false, error: `保存人设失败: ${message(e)}` }
      }
      // 改名时旧文件等新文件就位后再清：清失败只多一份副本，不丢数据。
      if (renamedFrom) await rm(join(dir, renamedFrom + '.md'), { force: true }).catch(() => undefined)
      cache = null
      return withEnabledNote(
        { ok: true, name: finalName, ...(renamedFrom ? { renamedFrom } : {}) },
        async () => { if (renamedFrom) await renamePersonaInEnabled(renamedFrom, finalName) },
      )
    },
    /**
     * 删除人设 = **移入回收站**（`hub/trash/agents-trash/<id>/persona.md`）。
     * 早先这里是 `rm`，而界面按钮写着「移入回收站」——文案与行为不一致；现在行为追上文案，
     * 误删可以从子智能体页的回收站里恢复。
     */
    'subagent-delete': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (!exists) return { ok: false, error: `人设不存在: ${name}` }
      const moved = await moveToTrash('subagents', name, [{ from: target, dest: 'persona.md' }])
      if (moved.ok === false) return { ok: false, error: `移入回收站失败: ${moved.error}` }
      cache = null
      return withEnabledNote({ ok: true, name, trashId: moved.id }, () => removePersonaFromEnabled(name))
    },
    'subagent-trash-list': async () => ({ ok: true, trash: await listTrashEntries('subagents') }),
    'subagent-trash-restore': async (args: any) => {
      const id = String((args && args.id) || '').trim()
      const entry = await readTrashEntry('subagents', id)
      if (!entry) return { ok: false, error: `回收站条目不存在: ${id}` }
      if (!validPersonaName(entry.name)) return { ok: false, error: `回收站里的人设名不合法: ${entry.name}` }
      const target = join(dir, entry.name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      // 绝不覆盖：同名人设已经存在时如实拒绝，让人自己决定怎么办。
      if (exists) return { ok: false, error: `无法恢复，同名人设已存在: ${entry.name}` }
      try {
        await mkdir(dir, { recursive: true })
        await moveOutOfTrash('subagents', id, 'persona.md', target)
      } catch (e) {
        return { ok: false, error: `恢复失败: ${message(e)}` }
      }
      await purgeTrashEntry('subagents', id)
      // v0.8.5：回收站恢复默认不启动（与新建/导入同口径）。
      cache = null
      return withEnabledNote({ ok: true, name: entry.name }, () => materializeEnabledExcluding([entry.name]))
    },
    'subagent-trash-delete': async (args: any) => {
      const id = String((args && args.id) || '').trim()
      const gone = await purgeTrashEntry('subagents', id)
      if (!gone) return { ok: false, error: `回收站条目不存在: ${id}` }
      return { ok: true, id }
    },
    /**
     * 导入人设（.md / .zip）：一个 .md 一个人设，文件名（去扩展名）= 人设名；
     * zip 内任意层级的 .md 都按文件名导入（目录层级忽略）。同名**跳过并报告**，不覆盖既有文件。
     * 部分成功：单条失败只记 skipped。
     */
    'subagent-import': async (args: any) => {
      const files = args && args.files
      if (!Array.isArray(files) || !files.length) return { ok: false, error: '没有选择要导入的文件' }
      const { entries, problems } = expandUploads(files)
      const planned = planPersonaImport(entries)
      const skipped: Array<{ name: string; reason: string }> = [...problems, ...planned.problems]
      const imported: string[] = []
      for (const target of planned.targets) {
        if (!validPersonaName(target.name)) { skipped.push({ name: target.name, reason: '人设名不合法（≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）' }); continue }
        const text = Buffer.from(target.bytes).toString('utf8').replace(/^\uFEFF/, '')
        if (!text.trim()) { skipped.push({ name: target.name, reason: '内容为空，已跳过' }); continue }
        const targetPath = join(dir, target.name + '.md')
        const exists = await readFile(targetPath, 'utf8').then(() => true).catch(() => false)
        if (exists) { skipped.push({ name: target.name, reason: '同名已存在（已跳过）' }); continue }
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(targetPath, text, 'utf8')
        } catch (e) {
          skipped.push({ name: target.name, reason: '写入失败：' + message(e) })
          continue
        }
        imported.push(target.name)
      }
      if (imported.length) cache = null
      return withEnabledNote(
        { ok: true, imported, skipped },
        async () => { if (imported.length) await materializeEnabledExcluding(imported) },
      )
    },
    /**
     * 子智能体开关（v0.8）：停用 = 不注入目录段、subagent_manager_list/run 不可见；文件本体不动。
     * `enabled` 必须显式给布尔值 —— 与 rules-toggle 同一条口径：不按"翻转"推断，
     * 免得参数丢了时界面以为改了、实际什么都没动。
     */
    'subagent-toggle': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      if (typeof (args && args.enabled) !== 'boolean') {
        return { ok: false, error: '缺少参数：enabled 必须是布尔值（只按传入值写入，不做"翻转"推断）' }
      }
      const docs = await list()
      if (!docs.some((d) => d.name === name)) return { ok: false, error: `人设不存在: ${name}` }
      const set = await readEnabled()
      // 文件缺失 = 当前全启用：首次开关时把现状物化成显式集合（否则"部分停用"无处落笔）。
      const base = (set === null ? docs.map((d) => d.name) : set.slice()).filter((n) => docs.some((d) => d.name === n))
      const i = base.indexOf(name)
      if (args.enabled === true) {
        if (i < 0) base.push(name)
      } else if (i >= 0) {
        base.splice(i, 1)
      }
      await writeEnabled(base)
      cache = null
      return { ok: true, name, enabled: args.enabled === true }
    },
  }
  // 写 op 统一进串行队列（理由见上方 mutationQueue 的说明）。放在这里统一包、而不是逐个手写：
  // 以后新增写 op 只改 writeOps 一处，不会漏掉。
  for (const name of writeOps) {
    const fn = ops[name]
    if (typeof fn === 'function') ops[name] = (args: any) => enqueueMutation(() => fn(args))
  }
  const enabledStore = {
    /** 指定名单里当前被停用的（进入模式拍快照用：只记将被启用的行，退出时精确停回）。 */
    async disabledAmong(names: string[]): Promise<string[]> {
      const docs = await list()
      const state = new Map(docs.map((d) => [d.name, d.enabled !== false]))
      return names.filter((n) => state.get(n) === false)
    },
    /** 指定名单里当前**开着**的（进入模式把未勾的关掉时，只记将被关闭的行）。 */
    async enabledAmong(names: string[]): Promise<string[]> {
      const docs = await list()
      const state = new Map(docs.map((d) => [d.name, d.enabled !== false]))
      return names.filter((n) => state.get(n) === true)
    },
    /** 当前开着的人设全名单（档案页把页面的「开关」落成场景绑定时用）。 */
    async enabledNames(): Promise<string[]> {
      const docs = await list()
      const state = new Map(docs.map((d) => [d.name, d.enabled !== false]))
      return docs.map((d) => d.name).filter((n) => state.get(n) === true)
    },
    /** 批量启停；只碰给出的名字，人设已不存在的跳过（别把悬空名写进集合）。
     *  同样走写队列：它由场景档案引擎直接调用（不经 op 表），不排队就会与开关 op 互相覆盖。 */
    async setEnabled(names: string[], enabled: boolean): Promise<void> {
      await enqueueMutation(async () => {
        const docs = await list()
        const set = await readEnabled()
        const base = (set === null ? docs.map((d) => d.name) : set.slice()).filter((n) => docs.some((d) => d.name === n))
        let dirty = false
        for (const n of names) {
          if (!docs.some((d) => d.name === n)) continue
          const i = base.indexOf(n)
          if (enabled && i < 0) { base.push(n); dirty = true }
          if (!enabled && i >= 0) { base.splice(i, 1); dirty = true }
        }
        if (dirty) {
          await writeEnabled(base)
          cache = null
        }
      })
    },
  }
  return { list, runSerial, ops, enabledStore, writeOps }
}
