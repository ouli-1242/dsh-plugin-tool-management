// 程序性记忆（P4）：步骤、成功计数、playbook 晋升、技能提议与可回滚安装。
//
// 这一层只回答一件事：**一条"做法"什么时候可信到可以变成一份技能**。阶梯是
// episode → note → memory → core → playbook → skill（04-governance §6），前四段已经
// 在 P1/P3 里做完，这里接后两段。
//
// 四条纪律，每一条都对应一个具体的坏结果：
//
// ① **steps 的真值在 state.json，正文只是给人读的投影**。frontmatter 的解析器只认顶层
//    标量，数组塞进去会被压成半句话；正文里的编号列表则可能被用户手写改过。两边不一致
//    时以 state 为准，正文解析只用于给"有正文、没状态"的旧条目兜底。
// ② **成功只认显式回报**。从"这一轮工具都没报错"去推断"这条流程执行成功了"，会把一次
//    无关的对话也算进去；三次误判就能把一条没验证过的做法升成 playbook。
// ③ **playbook 注入只放标题**。它有十几个步骤，把步骤全塞进每次会话的上下文，等于让
//    一条记忆吃掉整个自动段的预算；模型真正需要的是"有这么一份流程，要用就去 read"。
// ④ **技能写入必须人工确认 + 写后回读 lint + 失败回滚**。技能是机器级对象，写坏一份的
//    影响面比一条记忆大得多；`skill-create` 返回 OK 只说明文件写上了，不说明宿主能加载。
//    所以写完要回读 frontmatter、再让技能清单认出它，任一步不过就把它移进回收站。

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomically } from '../memories/index-io.js'
import { parseSkillDoc, toKebab } from '../skills/frontmatter.js'
import { createHash } from 'node:crypto'
import { normalizeProcedure, type ProcedureState } from './state.js'

/** 步骤条数上限：再多就说明它该是文档，不是一条记忆。 */
export const MAX_PROCEDURE_STEPS = 12
/** 单步长度上限（字符）。 */
export const MAX_STEP_LENGTH = 240
/** 升 playbook 需要的成功次数（04-governance §6：同 key 的 procedure 成功 ≥ 3 次）。 */
export const PLAYBOOK_SUCCESS_THRESHOLD = 3
/** 标题上限（字符）。playbook 注入只用这一行。 */
const MAX_TITLE_LENGTH = 60

// ── 步骤 ────────────────────────────────────────────────────────────────────

/** 洗净一组步骤：去空、去编号前缀、限长、限条数。 */
export function cleanSteps(raw: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const line = item.trim().replace(/^\s*(?:\d+[.)、]|[-*•])\s*/u, '').trim().slice(0, MAX_STEP_LENGTH)
    if (line === '') continue
    out.push(line)
    if (out.length >= MAX_PROCEDURE_STEPS) break
  }
  return out
}

/**
 * 从正文里解析步骤（兜底用）。只认「## 步骤」段下的编号/项目符号行，找不到标题时
 * 退回全文的编号行；普通 prose 里的 "1. xxx" 不会被误当成流程（要求至少 2 条）。
 */
export function parseProcedureSteps(body: string): string[] {
  const lines = String(body ?? '').split(/\r?\n/)
  let start = lines.findIndex((l) => /^\s*#{1,3}\s*(步骤|Steps|做法)\s*$/iu.test(l))
  if (start < 0) start = 0
  const slice = start > 0 ? lines.slice(start + 1) : lines
  const found: string[] = []
  for (const line of slice) {
    if (/^\s*#{1,3}\s/u.test(line) && found.length > 0) break
    if (!/^\s*(?:\d+[.)、]|[-*•])\s+\S/u.test(line)) continue
    found.push(line)
    if (found.length >= MAX_PROCEDURE_STEPS) break
  }
  return found.length >= 2 ? cleanSteps(found) : []
}

/**
 * 渲染 procedure 的正文。没给步骤时沿用 P1 的一句话文案（旧条目、模型没拆解步骤时
 * 不能凭空造出一份流程）；给了步骤就写成可复制的编号列表。
 */
export function renderProcedureBody(text: string, boundary: string | undefined, steps: readonly string[]): string {
  const clean = cleanSteps(steps)
  const lines = [String(text ?? '').trim()]
  if (clean.length > 0) {
    lines.push('', '## 步骤')
    clean.forEach((step, i) => lines.push(`${i + 1}. ${step}`))
  }
  const b = String(boundary ?? '').trim()
  if (b !== '') lines.push('', `边界：${b}`)
  if (clean.length === 0) lines.push('', '（做法类：验证通过后才会进入注入；未验证前只在记忆页可见。）')
  return lines.join('\n') + '\n'
}

/** 标题：取第一句，压平空白并限长。playbook 注入与技能名都靠它。 */
export function procedureTitleOf(text: string, key = ''): string {
  const flat = String(text ?? '').replaceAll(/\s+/gu, ' ').trim()
  const cut = flat.split(/[。！？!?；;\n]/u)[0] ?? ''
  const title = (cut.trim() || flat || String(key ?? '').trim()).slice(0, MAX_TITLE_LENGTH)
  return title === '' ? 'procedure' : title
}

// ── playbook ────────────────────────────────────────────────────────────────

export interface PlaybookCandidate {
  kind: string
  status: string
  steps: readonly string[]
  successes: number
  harmful: number
  needsReview?: string
}

/**
 * 能不能升 playbook。治理表给的是 `core → playbook`（procedure 成功 ≥ 3 次），所以
 * **不认 active → playbook 的跳级**：常驻名额与步骤注入都变了，中间那次人工/统计确认
 * 不能省。harmful > 0 一律否：被纠正过的流程不该固化成技能。
 */
export function canPromotePlaybook(c: PlaybookCandidate): { ok: true } | { ok: false; reason: string } {
  if (c.kind !== 'procedure') return { ok: false, reason: 'not-a-procedure' }
  if (c.steps.length < 2) return { ok: false, reason: 'no-steps' }
  if (c.status === 'playbook') return { ok: false, reason: 'already-playbook' }
  if (c.status !== 'core') return { ok: false, reason: 'not-core' }
  if (c.successes < PLAYBOOK_SUCCESS_THRESHOLD) return { ok: false, reason: 'not-proven' }
  if (c.harmful > 0) return { ok: false, reason: 'harmful' }
  if (typeof c.needsReview === 'string' && c.needsReview !== '') return { ok: false, reason: 'needs-review' }
  return { ok: true }
}

/** 记一次执行结果。纯函数：改的是传进来的对象，方便单独测幂等与上限。 */
export function recordProcedureUse(
  proc: ProcedureState | undefined,
  ok: boolean,
  at: string,
): ProcedureState {
  const base: ProcedureState = proc ?? { steps: [], successes: 0, failures: 0 }
  return {
    ...base,
    successes: base.successes + (ok ? 1 : 0),
    failures: base.failures + (ok ? 0 : 1),
    ...(ok ? { lastSucceededAt: at } : { lastFailedAt: at }),
  }
}

// ── 技能草案 ────────────────────────────────────────────────────────────────

export interface SkillProposal {
  /** 稳定的草案 id = 技能名。 */
  name: string
  memoryId: string
  title: string
  description: string
  body: string
  steps: string[]
  boundary: string
  successes: number
  createdAt: string
  /** 已装 / 已回滚都留痕：界面据此显示状态，重复应用一律拒绝。 */
  installedAt?: string
  installedPath?: string
  installedRoot?: string
  rolledBackAt?: string
  lastError?: string
}

export interface LearnedSkill {
  name: string
  memoryId: string
  at: string
  path?: string
  root?: string
}

/** 生成合法的 kebab-case 技能名：中文标题会落空，用标题哈希兜底且可复现。 */
export function skillNameOf(key: string, title: string): string {
  const fromKey = toKebab(key || '')
  if (fromKey !== '') return fromKey.slice(0, 64)
  const hash = createHash('sha256').update(String(title)).digest('hex').slice(0, 8)
  return `learned-${hash}`
}

export interface SkillDraftInput {
  id: string
  key: string
  title: string
  description: string
  steps: readonly string[]
  boundary?: string
  successes: number
}

/**
 * 从一条 playbook 生成技能草案。**body 不含 frontmatter**：`skill-create` 自己会写
 * `name` / `description`，我们重复写一遍会得到两个 name 字段，解析器只认最后一个。
 */
export function skillDraftOf(input: SkillDraftInput): Omit<SkillProposal, 'createdAt' | 'installedAt' | 'installedPath' | 'installedRoot' | 'rolledBackAt' | 'lastError'> {
  const steps = cleanSteps(input.steps)
  const name = skillNameOf(input.key, input.title)
  const description = `${input.title}。按已验证的流程执行（成功 ${input.successes} 次）。来自自主记忆 ${input.id}。`.slice(0, 500)
  const lines = [
    `# ${input.title}`,
    '',
    `这份流程来自自主记忆 \`${input.id}\`，累计成功执行 ${input.successes} 次后由用户确认生成。`,
    '',
    '## 步骤',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ]
  const boundary = String(input.boundary ?? '').trim()
  if (boundary !== '') lines.push('', '## 边界', '', boundary)
  lines.push(
    '',
    '## 注意',
    '',
    '- 若项目文件或用户的当前指令与这里冲突，以它们为准。',
    '- 流程有变化时回到「记忆」页更新对应的自主记忆，再重新生成技能。',
  )
  return { name, memoryId: input.id, title: input.title, description, body: lines.join('\n') + '\n', steps, boundary, successes: input.successes }
}

/**
 * 写后 lint：技能文件必须能被宿主加载。
 *
 * 只信"文件写上了"是不够的 —— frontmatter 被截断、正文里的 `---` 提前关掉头部、
 * 或者技能名与声明名不一致，都会让清单里出现一条 `loadable: false` 的废技能。
 * 这里复用宿主同一个 `parseSkillDoc`，判据与加载路径同源。
 */
export function lintSkillText(
  text: string,
  expectedName: string,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, errors: ['empty file'] }
  if (text.includes('\u0000')) errors.push('NUL byte')
  const doc = parseSkillDoc(text)
  const declared = typeof doc.map.name === 'string' ? String(doc.map.name).trim() : ''
  const description = typeof doc.map.description === 'string' ? String(doc.map.description).trim() : ''
  if (declared === '') errors.push('missing name in frontmatter')
  else if (declared !== expectedName) errors.push(`name mismatch: ${declared} != ${expectedName}`)
  if (description === '') errors.push('missing description in frontmatter')
  if (String(doc.body ?? '').trim() === '') errors.push('empty body')
  if (parseProcedureSteps(String(doc.body ?? '')).length < 2) errors.push('fewer than 2 steps in body')
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/** 宽松读草案：单份坏掉不该让整个列表打不开。 */
function normalizeProposal(raw: any): SkillProposal | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.name !== 'string' || typeof raw.body !== 'string') return null
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(raw.name)) return null
  return {
    name: raw.name,
    memoryId: typeof raw.memoryId === 'string' ? raw.memoryId : '',
    title: typeof raw.title === 'string' ? raw.title : raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    body: raw.body,
    steps: cleanSteps(Array.isArray(raw.steps) ? raw.steps : []),
    boundary: typeof raw.boundary === 'string' ? raw.boundary : '',
    successes: Math.max(0, Math.floor(Number(raw.successes) || 0)),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    ...(typeof raw.installedAt === 'string' ? { installedAt: raw.installedAt } : {}),
    ...(typeof raw.installedPath === 'string' ? { installedPath: raw.installedPath } : {}),
    ...(typeof raw.installedRoot === 'string' ? { installedRoot: raw.installedRoot } : {}),
    ...(typeof raw.rolledBackAt === 'string' ? { rolledBackAt: raw.rolledBackAt } : {}),
    ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
  }
}

function normalizeLearned(raw: any): LearnedSkill[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.skills) ? raw.skills : []
  const out: LearnedSkill[] = []
  for (const x of list) {
    if (!x || typeof x !== 'object' || typeof x.name !== 'string') continue
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(x.name)) continue
    out.push({
      name: x.name,
      memoryId: typeof x.memoryId === 'string' ? x.memoryId : '',
      at: typeof x.at === 'string' ? x.at : '',
      ...(typeof x.path === 'string' ? { path: x.path } : {}),
      ...(typeof x.root === 'string' ? { root: x.root } : {}),
    })
  }
  return out
}

export interface ProcedureSkillDeps {
  /** `memoriesService.autoAccess.stateDir`：与 episode / dream 同一根。 */
  stateDir: string
  /** 技能域的 op 表（用 `skill-create` / `skill-delete` / `skill-state`，与界面同一条路）。 */
  skillsOps: Record<string, (args: any) => Promise<any>>
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>
  now?(): number
  message(e: unknown): string
}

export interface ProcedureSkillStore {
  list(): Promise<{ proposals: SkillProposal[]; learned: LearnedSkill[] }>
  learned(): Promise<LearnedSkill[]>
  propose(input: SkillDraftInput): Promise<{ ok: true; proposal: SkillProposal } | { ok: false; error: string }>
  /** `confirm` 必须是界面确认卡传下来的 true；后端不替用户点头。 */
  apply(name: string, confirm: boolean): Promise<{ ok: true; name: string; path: string } | { ok: false; error: string; rolledBack: boolean }>
  rollback(name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>
}

/**
 * 草案与 learned 名单的存储。
 *
 * 为什么用「目录 + 一份 json」而不是单个文件：草案各自独立，写一份坏一份不该毁掉
 * 其它提议；`learned-skills.json` 只有几十条，整体原子写最省事，也是技能页徽章唯一
 * 要读的东西。
 */
export function createProcedureSkillStore(deps: ProcedureSkillDeps): ProcedureSkillStore {
  const nowIso = (): string => new Date(deps.now ? deps.now() : Date.now()).toISOString()
  const dir = (): string => join(deps.stateDir, 'evolution', 'procedures')
  const learnedPath = (): string => join(deps.stateDir, 'evolution', 'learned-skills.json')
  const proposalPath = (name: string): string => join(dir(), `${name}.json`)

  const readLearned = async (): Promise<LearnedSkill[]> => {
    try {
      return normalizeLearned(JSON.parse(await readFile(learnedPath(), 'utf8')))
    } catch {
      return []
    }
  }
  const writeLearned = async (rows: LearnedSkill[]): Promise<void> => {
    await mkdir(join(deps.stateDir, 'evolution'), { recursive: true })
    await writeFileAtomically(learnedPath(), JSON.stringify({ version: 1, skills: rows }, null, 2) + '\n', { mode: 0o600 })
  }
  const readProposal = async (name: string): Promise<SkillProposal | null> => {
    try {
      return normalizeProposal(JSON.parse(await readFile(proposalPath(name), 'utf8')))
    } catch {
      return null
    }
  }
  const writeProposal = async (p: SkillProposal): Promise<void> => {
    await mkdir(dir(), { recursive: true })
    await writeFileAtomically(proposalPath(p.name), JSON.stringify(p, null, 2) + '\n', { mode: 0o600 })
  }

  /** 同名技能是否已经存在：宁可拒绝，也绝不覆盖用户自己写的技能。 */
  const skillExists = async (name: string): Promise<boolean> => {
    try {
      const r = await deps.skillsOps['skill-state']!({})
      const roots: any[] = Array.isArray(r?.data?.roots) ? r.data.roots : []
      return roots.some((root) => (Array.isArray(root?.skills) ? root.skills : []).some((s: any) =>
        String(s?.declaredName || s?.name || '') === name || String(s?.name || '') === name))
    } catch {
      // 查不到就当存在：写进去可能覆盖，比"这次点不动"代价大得多。
      return true
    }
  }

  /** 写完再让技能清单认一次：清单读不到 / loadable=false 都算不可加载。 */
  const loadable = async (name: string): Promise<boolean> => {
    try {
      const r = await deps.skillsOps['skill-state']!({})
      const roots: any[] = Array.isArray(r?.data?.roots) ? r.data.roots : []
      const hit = roots.flatMap((root) => (Array.isArray(root?.skills) ? root.skills : []))
        .find((s: any) => String(s?.declaredName || s?.name || '') === name || String(s?.name || '') === name)
      return Boolean(hit) && hit.loadable !== false
    } catch {
      return false
    }
  }

  const removeSkill = async (root: string, name: string): Promise<string | undefined> => {
    try {
      const r = await deps.skillsOps['skill-delete']!({ root, name })
      if (r && r.ok === false) return String(r.error || 'skill-delete failed')
      return undefined
    } catch (e) {
      return deps.message(e)
    }
  }

  return {
    async learned() {
      return readLearned()
    },

    async list() {
      let names: string[] = []
      try {
        names = (await readdir(dir())).filter((n) => n.endsWith('.json'))
      } catch {
        return { proposals: [], learned: await readLearned() }
      }
      const proposals: SkillProposal[] = []
      for (const file of names) {
        const p = await readProposal(file.slice(0, -5))
        if (p) proposals.push(p)
      }
      proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
      return { proposals, learned: await readLearned() }
    },

    async propose(input) {
      return deps.withWriteLock(async () => {
        const steps = cleanSteps(input.steps)
        if (steps.length < 2) return { ok: false as const, error: '需要至少 2 个步骤才能生成技能' }
        const draft = skillDraftOf({ ...input, steps })
        const prev = await readProposal(draft.name)
        // 已装过的不重新出草案：同名再建会被 createSkill 拒，界面上会变成一颗永远点不动的按钮。
        if (prev?.installedAt) return { ok: false as const, error: `技能 ${draft.name} 已经生成过` }
        const proposal: SkillProposal = {
          ...draft,
          createdAt: nowIso(),
          ...(prev?.rolledBackAt ? { rolledBackAt: prev.rolledBackAt } : {}),
        }
        try {
          await writeProposal(proposal)
        } catch (e) {
          return { ok: false as const, error: deps.message(e) }
        }
        return { ok: true as const, proposal }
      })
    },

    async apply(name, confirm) {
      if (confirm !== true) return { ok: false as const, error: '生成技能必须经用户确认', rolledBack: false }
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) return { ok: false as const, error: 'invalid skill name', rolledBack: false }
      return deps.withWriteLock(async () => {
        const p = await readProposal(name)
        if (!p) return { ok: false as const, error: `没有这份草案：${name}`, rolledBack: false }
        if (p.installedAt) return { ok: false as const, error: `技能 ${name} 已经生成过`, rolledBack: false }
        if (await skillExists(name)) return { ok: false as const, error: `已存在同名技能 ${name}，不覆盖`, rolledBack: false }

        let created: { name: string; path: string; root: string } | null = null
        const fail = async (reason: string): Promise<{ ok: false; error: string; rolledBack: boolean }> => {
          let rolledBack = false
          if (created) {
            const err = await removeSkill(created.root, created.name)
            rolledBack = err === undefined
            if (err) reason += `（回滚也失败：${err}）`
          }
          await writeProposal({
            ...p,
            rolledBackAt: nowIso(),
            ...(created ? { installedPath: created.path, installedRoot: created.root } : {}),
            lastError: reason,
          }).catch(() => undefined)
          return { ok: false, error: reason, rolledBack }
        }

        try {
          const r = await deps.skillsOps['skill-create']!({ name, description: p.description, body: p.body })
          if (!r || r.ok === false) return fail(String(r?.error || 'skill-create failed'))
          const data = r.data ?? {}
          const path = typeof data.path === 'string' ? data.path : ''
          const root = typeof data.root === 'string' ? data.root : 'dsh'
          if (path === '') return fail('skill-create 没返回文件路径，无法校验')
          created = { name: String(data.name || name), path, root }

          // ① 回读 lint：与宿主加载同源的 frontmatter 解析 + 步骤完整性。
          let text: string
          try {
            text = await readFile(path, 'utf8')
          } catch (e) {
            return fail(`技能文件读不回来：${deps.message(e)}`)
          }
          const lint = lintSkillText(text, created.name)
          if (!lint.ok) return fail(`lint 未通过：${lint.errors.join('; ')}`)
          // ② 清单认得出、且不是 loadable=false：文件对了但目录形态/命名不对时这一步会拦住。
          // 用 createSkill 回的**规范化名字**（而不是请求里的 name），两者可能因命名规整而不同。
          if (!(await loadable(created.name))) return fail('技能清单里找不到这条，或它不可加载')

          await writeProposal({ ...p, installedAt: nowIso(), installedPath: path, installedRoot: root, rolledBackAt: undefined, lastError: undefined })
          const rows = await readLearned()
          if (!rows.some((x) => x.name === name)) rows.push({ name, memoryId: p.memoryId, at: nowIso(), path, root })
          await writeLearned(rows)
          return { ok: true as const, name, path }
        } catch (e) {
          return fail(deps.message(e))
        }
      })
    },

    async rollback(name) {
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) return { ok: false as const, error: 'invalid skill name' }
      return deps.withWriteLock(async () => {
        const rows = await readLearned()
        const hit = rows.find((x) => x.name === name)
        if (!hit) return { ok: false as const, error: `${name} 不是本功能生成的技能，不能回滚` }
        const err = await removeSkill(hit.root || 'dsh', name)
        if (err) return { ok: false as const, error: err }
        await writeLearned(rows.filter((x) => x.name !== name))
        const p = await readProposal(name)
        if (p) await writeProposal({ ...p, installedAt: undefined, rolledBackAt: nowIso() })
        return { ok: true as const, name }
      })
    },
  }
}
