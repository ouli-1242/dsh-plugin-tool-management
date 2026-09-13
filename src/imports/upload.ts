// src/imports/upload.ts —— 导入通道共享纯逻辑（无 I/O）：base64 解码、ZIP 解包、路径校验、落点规划。
// 两个使用方：子智能体（人设 = ~/.dsh/subagents/<名>.md）与场景记忆（<场景>/<名>.md，场景可为空 = 全局）。
// 约定：只认 .md；zip 内任意层级；隐藏项 / 绝对路径 / `..` 穿越 / 超限条目一律跳过并回报；
//       重名策略（跳过 or 覆盖）不在这里实现——由调用方按文件系统现状裁决（本项目取「跳过并报告」）。
import { unzipSync } from 'fflate'

export interface UploadFile { name?: unknown; data?: unknown }
export interface RawEntry { path: string; bytes: Uint8Array }
export interface ImportProblem { name: string; reason: string }

export const MAX_IMPORT_FILES = 200
export const MAX_IMPORT_ENTRY_BYTES = 8 * 1024 * 1024
export const MAX_IMPORT_TOTAL_BYTES = 32 * 1024 * 1024
export const MAX_IMPORT_ENTRIES = 2000
export const MAX_IMPORT_NAME_LENGTH = 64

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
    entries.push({ path: name, bytes })
  }
  return { entries, problems }
}

/** 单个名字段（人设名 / 记忆名 / 场景路径的一段）合法性：与宿主侧校验同口径。 */
export function isValidImportName(name: string): boolean {
  const s = String(name || '')
  return s.length > 0 && s.length <= MAX_IMPORT_NAME_LENGTH && s === s.trim() && !s.startsWith('.') && !/[\\/<>:"|?*]/.test(s)
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
  /** 仅 bundle：SKILL.md 的同层附件（名字平铺在 bundle 目录里，与 rules-attach 落点一致）。 */
  attachments?: MemoryAttachment[]
}

/** bundle 附件限额：与 rules-attach 同口径（名字平铺、单个 8 MiB 由 expandUploads 兜底、单包 32 个/16 MiB）。 */
const MAX_BUNDLE_ATTACHMENTS = 32
const MAX_BUNDLE_ATTACH_TOTAL = 16 * 1024 * 1024

/**
 * 记忆落点：
 * - 裸 `.md` → 落到 defaultScene（空串 = 全局：任何对话都注入）；zip 内带目录 → 目录路径即场景/分组。
 * - zip 内 `<场景路径>/<名>/SKILL.md` → bundle 记忆（目录末段是记忆名，其余前缀是场景）；同层非 `.md`
 *   文件作为附件一并带入（`.md` 不带——bundle 是叶子，塞进去不会被发现，静默降级反而误导）。
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

  // pass 1：认 bundle 目录（精确 SKILL.md；大小写变体只报跳过，不当 bundle 也不当 flat）。
  const bundleDocs = new Map<string, RawEntry>()
  for (const entry of entries) {
    const { dir, base } = split(entry.path)
    if (base !== 'SKILL.md' && base.toLowerCase() !== 'skill.md') continue
    if (base !== 'SKILL.md') { problems.push({ name: entry.path, reason: 'SKILL.md 大小写变体不导入（发现层只认精确 SKILL.md，且与 NTFS 大小写不敏感冲突），已跳过' }); continue }
    if (dir === '') { problems.push({ name: entry.path, reason: 'SKILL.md 在 zip 根层，没有目录名可作记忆名，已跳过' }); continue }
    bundleDocs.set(dir, entry)
  }

  // pass 2：bundle 附件（同层非 .md）；深层与同层 .md 明确回报，bundle 目录外的非 .md 维持旧口径静默忽略。
  const attachments = new Map<string, MemoryAttachment[]>()
  for (const entry of entries) {
    const { dir, base } = split(entry.path)
    if (base.toLowerCase().endsWith('.md')) continue
    const bundleDir = bundleDocs.has(dir) ? dir : [...bundleDocs.keys()].find((d) => dir.startsWith(d + '/'))
    if (!bundleDir) continue
    if (dir !== bundleDir) { problems.push({ name: entry.path, reason: 'bundle 只支持一层附件（SKILL.md 同层），子目录条目已跳过' }); continue }
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

  // pass 3：先规划 bundle 目标（含 SKILL.md 同层 .md 的明确跳过），再走 flat。
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
    if (base === 'SKILL.md') continue
    if (base.toLowerCase() === 'skill.md') continue // pass 1 已回报
    if ([...bundleDocs.keys()].some((d) => dir === d || dir.startsWith(d + '/'))) {
      problems.push({ name: entry.path, reason: 'bundle 目录内的非 SKILL.md 的 .md 不导入（bundle 是叶子，放进去不会被发现），已跳过' })
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
