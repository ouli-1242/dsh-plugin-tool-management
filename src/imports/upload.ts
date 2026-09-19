// src/imports/upload.ts —— 导入通道共享纯逻辑（无 I/O）：base64 解码、ZIP 解包、路径校验、落点规划。
// 两个使用方：子智能体（人设 = ~/.dsh/tool-management/agents/<名>.md）与
// 场景记忆（~/.dsh/tool-management/memories/<场景>/<名>.md；场景留空 = 保留场景 global）。
// 约定：只认 .md；zip 内任意层级；隐藏项 / 绝对路径 / `..` 穿越 / 超限条目一律跳过并回报；
//       重名策略（跳过 or 覆盖）不在这里实现——由调用方按文件系统现状裁决（本项目取「跳过并报告」）。
//
// 两条限额的**口径**要分清（2026-09-19 审计 T-09）：`MAX_IMPORT_TOTAL_BYTES` 管的是
// **上传（编码后）**字节，管不住解压后的体积 —— 一个 8 MiB 条目 × 2000 条 ≈ 16 GiB 会在
// 单次 `unzipSync` 里被实体化。所以另有 `MAX_IMPORT_UNCOMPRESSED_BYTES` 管**解压后**的
// 累计量，在 filter 里按档案自报的 `info.originalSize` 累加。
import { unzipSync } from 'fflate'
import { isValidSegment } from '../paths.js'

export interface UploadFile { name?: unknown; data?: unknown }
export interface RawEntry { path: string; bytes: Uint8Array }
export interface ImportProblem { name: string; reason: string }

export const MAX_IMPORT_FILES = 200
export const MAX_IMPORT_ENTRY_BYTES = 8 * 1024 * 1024
/** 上传（编码后）总量：与传输层的 88 MiB 体限是同一层口径，防止一次请求塞进几百 MiB。 */
export const MAX_IMPORT_TOTAL_BYTES = 32 * 1024 * 1024
export const MAX_IMPORT_ENTRIES = 2000
export const MAX_IMPORT_NAME_LENGTH = 64
/**
 * 解压后累计上限（与技能上传器 `MAX_UPLOAD_TOTAL_BYTES = 64 MiB` 同层口径）。
 *
 * 为什么必须单列：单条目 8 MiB × 2000 条 ≈ 16 GiB 会在一次 `unzipSync` 里全部展开进内存 ——
 * 传输层与 `MAX_IMPORT_TOTAL_BYTES` 都只数**压缩后**的字节，一个数不到。
 * 已知前提：信任档案自报的 `info.originalSize`（fflate 不独立约束输出长度）；谎报只能让
 * 解压产物比申报的大，**不会**绕过这个上限之前的条目数门禁。
 */
export const MAX_IMPORT_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** base64 → 字节；容忍 `data:...;base64,` 前缀。 */
export function decodeBase64(data: unknown): Uint8Array {
  const text = typeof data === 'string' ? data : ''
  const clean = text.startsWith('data:') && text.indexOf(',') >= 0 ? text.slice(text.indexOf(',') + 1) : text
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

/** ZIP 魔数（PK\x03\x04）；不靠扩展名判断，改名的压缩包也能认出来。 */
export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/**
 * 归档条目路径归一化：反斜杠按 `/` 处理、丢弃 `.`/空段；
 * 绝对路径（`/foo`、`C:\foo`）、`..` 穿越、隐藏项（`.x`）→ null（跳过）。
 */
export function normalizeEntryPath(raw: string): string | null {
  const p = String(raw || '').replace(/\\/g, '/').trim()
  if (!p) return null
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    if (seg.startsWith('.')) return null
    if (seg.length > 255) return null
    parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

/**
 * 展开上传文件列表 → 扁平条目（zip 解包 + 路径校验 + 限额）。
 * 单个文件损坏/超限只记 problem，不阻断同批其余文件（部分成功语义）。
 */
export function expandUploads(files: unknown): { entries: RawEntry[]; problems: ImportProblem[] } {
  const all = Array.isArray(files) ? files : []
  const list = all.slice(0, MAX_IMPORT_FILES)
  const problems: ImportProblem[] = []
  const entries: RawEntry[] = []
  if (all.length > MAX_IMPORT_FILES) {
    problems.push({ name: `(其余 ${all.length - MAX_IMPORT_FILES} 个文件)`, reason: `一次最多导入 ${MAX_IMPORT_FILES} 个文件` })
  }
  let total = 0
  /** 解压后超限只报一次（与"超条目数"同口径，避免几千条问题刷屏）。 */
  let uncompressedReported = false
  for (const raw of list) {
    const file = (raw || {}) as UploadFile
    const name = String(file.name || '').trim() || '(未命名)'
    const bytes = decodeBase64(file.data)
    if (!bytes.length) { problems.push({ name, reason: '内容为空' }); continue }
    if (bytes.length > MAX_IMPORT_ENTRY_BYTES) {
      problems.push({ name, reason: `单个文件超过 ${MAX_IMPORT_ENTRY_BYTES >> 20} MiB` })
      continue
    }
    total += bytes.length
    if (total > MAX_IMPORT_TOTAL_BYTES) {
      problems.push({ name, reason: `合计超过 ${MAX_IMPORT_TOTAL_BYTES >> 20} MiB，其余文件已忽略` })
      break
    }
    if (isZipBytes(bytes)) {
      let unzipped: Record<string, Uint8Array>
      let uncompressed = 0
      try {
        let count = 0
        unzipped = unzipSync(bytes, {
          filter(info) {
            count += 1
            // 被 filter 丢掉的条目必须回报：静默丢弃会让用户以为「全都导入成功了」。
            // 2026-09-13 实测（限额验证批）：9 MiB 附件与第 2001 个条目都曾无声消失，
            // 响应里 imported=1 / skipped=[] —— 用户完全看不出少了东西。
            if (count > MAX_IMPORT_ENTRIES) {
              // 超条目数时只报一次，避免 2000+ 条问题刷屏。
              if (count === MAX_IMPORT_ENTRIES + 1) {
                problems.push({ name, reason: `zip 内条目超过 ${MAX_IMPORT_ENTRIES} 个，其余条目已忽略` })
              }
              return false
            }
            if (!info.name.endsWith('/') && info.originalSize > MAX_IMPORT_ENTRY_BYTES) {
              problems.push({ name: info.name, reason: `zip 内单条目超过 ${MAX_IMPORT_ENTRY_BYTES >> 20} MiB，已跳过` })
              return false
            }
            // 解压后累计：单条目与条目数都挡不住「2000 × 8 MiB」这种组合，只有累计量挡得住。
            // 目录条目不占解压预算（originalSize 为 0 且不产出内容）。
            if (!info.name.endsWith('/')) {
              uncompressed += info.originalSize
              if (uncompressed > MAX_IMPORT_UNCOMPRESSED_BYTES) {
                if (!uncompressedReported) {
                  uncompressedReported = true
                  problems.push({ name: info.name, reason: `zip 解压后合计超过 ${MAX_IMPORT_UNCOMPRESSED_BYTES >> 20} MiB，该条目及其后条目已忽略` })
                }
                return false
              }
            }
            return true
          },
        })
      } catch (e) {
        problems.push({ name, reason: 'ZIP 解压失败：' + message(e) })
        continue
      }
      for (const [entryName, content] of Object.entries(unzipped)) {
        if (entryName.endsWith('/')) continue
        const normalized = normalizeEntryPath(entryName)
        if (!normalized) { problems.push({ name: entryName, reason: '路径非法或隐藏项，已跳过' }); continue }
        // zip 内保留全部扩展名：bundle 导入需要 SKILL.md 的附件（图片等）；各 planner 自行取舍。
        entries.push({ path: normalized, bytes: content })
      }
      continue
    }
    if (!name.toLowerCase().endsWith('.md')) { problems.push({ name, reason: '只支持 .md 或 .zip' }); continue }
    // 非 zip 分支同样要走 `normalizeEntryPath`：客户端给的文件名是**外部输入**，
    // `"../../x.md"` / `".hidden/x.md"` 直接进 `RawEntry[]` 就把"隐藏项/穿越一律跳过"
    // 这条承诺交给下游 planner 兜着 —— 本模块的文件头正是这么承诺的（审计 T-10）。
    // 不变量该由承诺方强制：新增的第三个消费者不该靠"运气好下游也查了"才安全。
    const normalized = normalizeEntryPath(name)
    if (!normalized) { problems.push({ name, reason: '路径非法或隐藏项，已跳过' }); continue }
    entries.push({ path: normalized, bytes })
  }
  return { entries, problems }
}

/** 单个名字段（人设名 / 记忆名 / 场景路径的一段）合法性：谓词收敛到 `../paths.ts`。 */
export function isValidImportName(name: string): boolean {
  return isValidSegment(String(name || ''), MAX_IMPORT_NAME_LENGTH)
}

/** 场景/分组路径合法性：逐段校验（空串 = 根/全局，合法）。 */
export function isValidImportGroup(group: string): boolean {
  const s = String(group || '')
  if (s === '') return true
  const segs = s.split('/')
  return segs.length > 0 && segs.every((seg) => isValidImportName(seg))
}

export interface PersonaTarget { name: string; bytes: Uint8Array }

/** 人设落点：**只看文件名**（zip 内的目录层级忽略），一个 .md 一个人设；zip 里顺带的非 .md（如附件）忽略。 */
export function planPersonaImport(entries: RawEntry[]): { targets: PersonaTarget[]; problems: ImportProblem[] } {
  const targets: PersonaTarget[] = []
  const problems: ImportProblem[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const base = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    if (!base.toLowerCase().endsWith('.md')) continue
    const name = base.slice(0, -3) // 去掉 .md
    if (!isValidImportName(name)) {
      problems.push({ name: entry.path, reason: '人设名不合法（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）' })
      continue
    }
    if (seen.has(name)) { problems.push({ name: entry.path, reason: '同批次重名，已跳过' }); continue }
    seen.add(name)
    targets.push({ name, bytes: entry.bytes })
  }
  return { targets, problems }
}

export interface MemoryAttachment { name: string; bytes: Uint8Array }
export interface MemoryTarget {
  group: string
  name: string
  bytes: Uint8Array
  kind: 'flat' | 'bundle'
  /** 仅 bundle：正文（`<名>.md`）的同层附件（名字平铺在 bundle 目录里，与 rules-attach 落点一致）。 */
  attachments?: MemoryAttachment[]
}

/** bundle 附件限额：与 rules-attach 同口径（名字平铺、单个 8 MiB 由 expandUploads 兜底、单包 32 个/16 MiB）。 */
const MAX_BUNDLE_ATTACHMENTS = 32
const MAX_BUNDLE_ATTACH_TOTAL = 16 * 1024 * 1024

/**
 * 记忆落点：
 * - 裸 `.md` → 落到 defaultScene（空串 = 全局：任何对话都注入）；zip 内带目录 → 目录路径即场景/分组。
 * - zip 内 `<场景路径>/<名>/<名>.md` → bundle 记忆（目录末段是记忆名，正文文件名与目录名一致，
 *   其余前缀是场景）；同层非 `.md` 文件作为附件一并带入（`.md` 不带——bundle 是叶子，塞进去不会被发现，
 *   静默降级反而误导）。旧导出包里正文可能仍叫 `SKILL.md`，也认（只读兼容）。
 * - zip 根层的裸 `SKILL.md` 没有目录名可当记忆名 → 跳过并回报；`SKILL.md` 的大小写变体也跳过
 *   （发现层只认精确 `SKILL.md`，NTFS 大小写不敏感下两者不能共存）。
 */
export function planMemoryImport(entries: RawEntry[], defaultScene: string): { targets: MemoryTarget[]; problems: ImportProblem[] } {
  const fallback = String(defaultScene || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
  const targets: MemoryTarget[] = []
  const problems: ImportProblem[] = []
  const seen = new Set<string>()

  const split = (path: string): { dir: string; base: string } => {
    const idx = path.lastIndexOf('/')
    return { dir: idx >= 0 ? path.slice(0, idx) : '', base: path.slice(idx + 1) }
  }

  // pass 1：认 bundle 目录（`<目录名>.md` 是正文；旧导出包的 `SKILL.md` 也认，只读兼容）。
  const bundleDocs = new Map<string, RawEntry>()
  const consumed = new Set<string>() // 已被 pass 1 认领（或已回报）的条目路径，pass 3 不再当 flat 处理
  for (const entry of entries) {
    const { dir, base } = split(entry.path)
    const dirName = dir === '' ? '' : dir.slice(dir.lastIndexOf('/') + 1)
    const isLegacyCaseVariant = base.toLowerCase() === 'skill.md' && base !== 'SKILL.md'
    if (isLegacyCaseVariant) {
      problems.push({ name: entry.path, reason: 'SKILL.md 大小写变体不导入（发现层只认精确 SKILL.md，且与 NTFS 大小写不敏感冲突），已跳过' })
      consumed.add(entry.path)
      continue
    }
    // 一级目录恒为场景（与发现层 `discover`/`probeSceneFilesSync` 同口径）：`1/1.md` 是
    // 「场景 1 的记忆 1」的 flat 正文，**不是**根层 bundle「1」——bundle 只认目录至少两段
    // （`<场景>/<名>/<名>.md`）。认错会写出发现层根本读不到、且会把整个场景目录吃成叶子的形态。
    const isRootSkill = base === 'SKILL.md' && dir === ''
    if (isRootSkill) {
      // zip 根层的裸 SKILL.md：没有目录名可作记忆名。
      problems.push({ name: entry.path, reason: 'SKILL.md 在 zip 根层，没有目录名可作记忆名，已跳过' })
      consumed.add(entry.path)
      continue
    }
    const isLegacyDoc = base === 'SKILL.md' && dir.includes('/')
    const isNamedDoc = dir.includes('/') && base === `${dirName}.md`
    if (!isLegacyDoc && !isNamedDoc) continue
    consumed.add(entry.path)
    const existing = bundleDocs.get(dir)
    if (existing) {
      // 同一目录里同时出现 `<目录名>.md` 与旧的 `SKILL.md`（少见）：`<目录名>.md` 优先。
      const { base: existingBase } = split(existing.path)
      if (isNamedDoc && existingBase !== `${dirName}.md`) bundleDocs.set(dir, entry)
      continue
    }
    bundleDocs.set(dir, entry)
  }

  // pass 2：bundle 附件（同层非 .md）；深层与同层 .md 明确回报，bundle 目录外的非 .md 维持旧口径静默忽略。
  const attachments = new Map<string, MemoryAttachment[]>()
  for (const entry of entries) {
    const { dir, base } = split(entry.path)
    if (base.toLowerCase().endsWith('.md')) continue
    const bundleDir = bundleDocs.has(dir) ? dir : [...bundleDocs.keys()].find((d) => dir.startsWith(d + '/'))
    if (!bundleDir) continue
    if (dir !== bundleDir) { problems.push({ name: entry.path, reason: 'bundle 只支持一层附件（正文同层），子目录条目已跳过' }); continue }
    if (!entry.bytes.length) { problems.push({ name: entry.path, reason: '附件内容为空，已跳过' }); continue }
    const name = base
    if (!isValidImportName(name)) { problems.push({ name: entry.path, reason: '附件名不合法，已跳过' }); continue }
    const list = attachments.get(bundleDir) || []
    if (list.length >= MAX_BUNDLE_ATTACHMENTS) { problems.push({ name: entry.path, reason: `附件超过 ${MAX_BUNDLE_ATTACHMENTS} 个，已跳过` }); continue }
    const total = list.reduce((sum, a) => sum + a.bytes.length, 0) + entry.bytes.length
    if (total > MAX_BUNDLE_ATTACH_TOTAL) { problems.push({ name: entry.path, reason: `附件合计超过 ${MAX_BUNDLE_ATTACH_TOTAL >> 20} MiB，已跳过` }); continue }
    list.push({ name, bytes: entry.bytes })
    attachments.set(bundleDir, list)
  }

  // pass 3：先规划 bundle 目标（含正文同层 .md 的明确跳过），再走 flat。
  for (const [dir, doc] of bundleDocs) {
    const segs = dir.split('/')
    const name = segs[segs.length - 1]
    const group = segs.slice(0, -1).join('/')
    if (!isValidImportName(name)) { problems.push({ name: doc.path, reason: 'bundle 名不合法（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头），已跳过' }); continue }
    if (!isValidImportGroup(group)) { problems.push({ name: doc.path, reason: '场景名不合法，已跳过' }); continue }
    const id = group ? `${group}/${name}` : name
    if (seen.has(id)) { problems.push({ name: doc.path, reason: '同批次重名，已跳过' }); continue }
    seen.add(id)
    targets.push({ group, name, bytes: doc.bytes, kind: 'bundle', attachments: attachments.get(dir) || [] })
  }
  for (const entry of entries) {
    const { dir, base } = split(entry.path)
    if (!base.toLowerCase().endsWith('.md')) continue
    if (consumed.has(entry.path)) continue // pass 1 已认领为 bundle 正文，或已回报为大小写变体/根层裸 SKILL.md
    if ([...bundleDocs.keys()].some((d) => dir === d || dir.startsWith(d + '/'))) {
      problems.push({ name: entry.path, reason: 'bundle 目录内的非正文 .md 不导入（bundle 是叶子，放进去不会被发现），已跳过' })
      continue
    }
    const name = base.slice(0, -3) // 去掉 .md
    if (!isValidImportName(name)) {
      problems.push({ name: entry.path, reason: '记忆名不合法（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）' })
      continue
    }
    const group = dir || fallback
    if (!isValidImportGroup(group)) { problems.push({ name: entry.path, reason: '场景名不合法，已跳过' }); continue }
    const id = group ? `${group}/${name}` : name
    if (seen.has(id)) { problems.push({ name: entry.path, reason: '同批次重名，已跳过' }); continue }
    seen.add(id)
    targets.push({ group, name, bytes: entry.bytes, kind: 'flat' })
  }
  return { targets, problems }
}
