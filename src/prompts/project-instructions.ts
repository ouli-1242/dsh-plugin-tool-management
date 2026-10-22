// 项目级 AGENTS.md 的发现与渲染—— **官方 dsh-agent-instructions 的同构实现**。
//
// ## 为什么必须自己实现一份
//
// 插件在官方载体（`carrier fact: carriesAgentsMd`）为真时整段跳过提示词域 —— 官方自己会送。
// 但"会话钉住了场景预设"时，我们要把**场景预设替换掉用户级那一条**、项目链照旧送，而官方
// 送的是"用户级 + 项目链"一整条，没法只换其中一半。于是这一份的职责很窄：
//   · 未钉住 + 官方在  → 官方送（本文件不参与）；
//   · 未钉住 + 官方不在（极简）→ 本文件送**项目链 + 用户级**（官方缺席时项目 AGENTS.md
//     没人读，这里补上）；
//   · 钉住 + 预设非空 → 本文件送**项目链 + 场景预设**（用户级槽位被替换）；
//   · 钉住 + 预设为空 → 项目链 + 用户级（退化，不丢东西）。
//
// ## 与官方逐字对齐的六条（改这里之前先读官方 lib/index.js）
//
//   1. 候选名：`AGENTS.md` / `CLAUDE.md`，本地覆盖层 `AGENTS.local.md` / `CLAUDE.local.md`；
//   2. 项目根：向上找最近的 `.git`，找不到就是 cwd 自己（官方 `findProjectRoot`）；
//   3. 祖先链：root → cwd 逐级（含两端），每级按"主候选在前、本地覆盖层在后"取全部存在的；
//   4. 同目录去重：**按 trim 后的内容**去重（官方 `dedupInstructionFilesByDirectory`）；
//   5. 每段正文前缀 `Instructions from: <displayPath>`，displayPath 对项目文件是**项目根相对**路径；
//   6. 段间空行分隔（整条的外框由注入通道的框架加，见 context-inject-frame.ts）。
//
// 差异只有一处、且是有意的：**预算超了从"最宽"的那一头丢**（与官方 `renderInstructionContext`
// 同方向：更具体的优先保留）。官方还做了一件事 —— 把最具体那份按字节二分截断；我们不截断，
// 整份丢。理由是截断过的指令文件是"半条规则"，模型照着做可能正好做反；宁可少一层。
//
// ## 与官方不共享代码的理由
//
// 官方包是**只读**的（AGENTS.md 的硬约束），而我们需要的只是一个"发现 + 拼接"的纯函数。
// 引官方包的内部函数会绑死它的模块布局；抄一份候选名常量、在兼容页做一次探测（对比两边的
// 文件清单），代价比绑死小得多 —— 候选名漂移时探测会当场报出来。

import { readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** 主候选（与官方 `DEFAULT_INSTRUCTION_FILE_CANDIDATES` 同序）。 */
export const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

/** 本地覆盖层候选（与官方 `DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES` 同序）。 */
export const LOCAL_INSTRUCTION_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const

/** 项目根判据（与官方 `DEFAULT_PROJECT_ROOT_MARKERS` 一致）。 */
export const PROJECT_ROOT_MARKERS = ['.git'] as const

/** 单个源文件上限（官方 `DEFAULT_MAX_SOURCE_BYTES` = 1 MiB）。超了整份跳过。 */
export const MAX_SOURCE_BYTES = 1048576

/**
 * 渲染预算（字节）。
 *
 * 官方那条是插件配置项（`maxBytes`，必填）；我们这一份是**兜底通道**，只在官方不在场或
 * 会话钉住预设时才用，取与插件别处同一个 64 KiB（`memories/service.ts` 的 AGENTS_MD_MAX_BYTES）。
 */
export const DEFAULT_MAX_BYTES = 65536

/** 一条被发现的指令文件。 */
export interface InstructionFile {
  absolutePath: string
  /** 展示路径：项目文件用**项目根相对**路径（官方同款）。 */
  displayPath: string
  content: string
}

/** 读一个文件；不存在 / 不是普通文件 / 超过源上限 → `null`（官方同样静默跳过）。 */
function readInstructionFile(abs: string): string | null {
  try {
    const st = statSync(abs)
    if (!st.isFile()) return null
    if (st.size > MAX_SOURCE_BYTES) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * 向上找最近的项目根（含 `.git` 的那一级）；找不到返回 `cwd` 自己。
 *
 * 与官方 `findProjectRoot` 逐字同判据 —— 注意**与 `nearestProjectRoot`（skills/skill-roots.ts）
 * 的差别**：那个找不到时返回 `null`（没有项目根就不读项目技能），这个返回 cwd（项目指令按
 * "没有项目就是当前目录"处理，否则一个非 git 目录里的 AGENTS.md 永远读不到）。
 */
export function findInstructionProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        statSync(join(current, marker))
        return current
      } catch { /* 这一级没有这个标记 */ }
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 从 root 到 cwd 的**含两端**目录链（官方 `ancestorChain`）。 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * 发现项目级指令文件（**不含用户级**）。按官方顺序：祖先链由宽到窄，每级主候选在前、
 * 本地覆盖层在后；同目录同内容去重。
 *
 * @returns 按"宽 → 窄"排列（后者优先，与官方渲染顺序一致）
 */
export function discoverProjectInstructions(cwd: string): InstructionFile[] {
  const root = findInstructionProjectRoot(cwd)
  const out: InstructionFile[] = []
  // 每个目录各记一份"已收的内容"：官方按**目录**去重，不是全局去重 ——
  // 同一份内容出现在两个目录时两份都要留（它们说的是不同层级的规则）。
  const seenByDir = new Map<string, Set<string>>()
  for (const dir of ancestorChain(root, cwd)) {
    let digests = seenByDir.get(dir)
    if (digests === undefined) {
      digests = new Set<string>()
      seenByDir.set(dir, digests)
    }
    for (const candidates of [INSTRUCTION_CANDIDATES, LOCAL_INSTRUCTION_CANDIDATES]) {
      for (const candidate of candidates) {
        const abs = join(dir, candidate)
        const content = readInstructionFile(abs)
        if (content === null) continue
        const digest = content.trim()
        if (digests.has(digest)) continue
        digests.add(digest)
        out.push({ absolutePath: abs, displayPath: relative(root, abs), content })
      }
    }
  }
  return out
}

/** 渲染结果：正文 + 实际收进正文的文件（界面据此显示"读到了哪几份"）。 */
export interface ProjectInstructionsRender {
  text: string
  files: Array<{ path: string; displayPath: string }>
  /** 因预算被丢掉的（从**最宽**那一头开始丢，与官方同方向）。 */
  omitted: string[]
}

/** 一段正文（与官方 `sectionText` 逐字同形）。 */
function sectionText(file: InstructionFile): string {
  return 'Instructions from: ' + file.displayPath + '\n\n' + file.content
}

/**
 * 渲染成一段可直接注入的正文。
 *
 * @param files 已发现的文件（宽 → 窄）
 * @param maxBytes 预算；超了从**最宽**的那一头丢（更具体的优先保留）
 */
export function renderProjectInstructions(
  files: readonly InstructionFile[],
  maxBytes: number = DEFAULT_MAX_BYTES,
): ProjectInstructionsRender {
  const kept = [...files]
  const omitted: string[] = []
  const build = (): string => kept.map(sectionText).join('\n\n')
  // 从最宽那一头丢：`kept[0]` 是最宽的项目根级文件，最具体的在末尾。
  while (kept.length > 0 && Buffer.byteLength(build(), 'utf8') > maxBytes) {
    const dropped = kept.shift()
    if (dropped === undefined) break
    omitted.push(dropped.displayPath)
  }
  const text = kept.length === 0 ? '' : build()
  return {
    text,
    files: kept.map((file) => ({ path: file.absolutePath, displayPath: file.displayPath })),
    omitted,
  }
}
