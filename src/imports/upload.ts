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
            if (count > MAX_IMPORT_ENTRIES) return false
            if (!info.name.endsWith('/') && info.originalSize > MAX_IMPORT_ENTRY_BYTES) return false
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
        if (!normalized.toLowerCase().endsWith('.md')) continue // zip 内只取 .md（其余文件如附件一律不带入）
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

/** 人设落点：**只看文件名**（zip 内的目录层级忽略），一个 .md 一个人设。 */
export function planPersonaImport(entries: RawEntry[]): { targets: PersonaTarget[]; problems: ImportProblem[] } {
  const targets: PersonaTarget[] = []
  const problems: ImportProblem[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const base = entry.path.slice(entry.path.lastIndexOf('/') + 1)
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

export interface MemoryTarget { group: string; name: string; bytes: Uint8Array }

/**
 * 记忆落点：zip 内带目录 → 目录路径即场景/分组；裸 .md → 落到 defaultScene
 * （空串 = 全局：任何对话都注入）。bundle（`SKILL.md`）本轮不支持，跳过并回报。
 */
export function planMemoryImport(entries: RawEntry[], defaultScene: string): { targets: MemoryTarget[]; problems: ImportProblem[] } {
  const fallback = String(defaultScene || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
  const targets: MemoryTarget[] = []
  const problems: ImportProblem[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const idx = entry.path.lastIndexOf('/')
    const dir = idx >= 0 ? entry.path.slice(0, idx) : ''
    const base = entry.path.slice(idx + 1)
    const name = base.slice(0, -3) // 去掉 .md
    if (name.toLowerCase() === 'skill') {
      problems.push({ name: entry.path, reason: 'SKILL.md（bundle 形态）暂不支持导入，已跳过' })
      continue
    }
    if (!isValidImportName(name)) {
      problems.push({ name: entry.path, reason: '记忆名不合法（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）' })
      continue
    }
    const group = dir || fallback
    if (!isValidImportGroup(group)) { problems.push({ name: entry.path, reason: '场景名不合法，已跳过' }); continue }
    const id = group ? `${group}/${name}` : name
    if (seen.has(id)) { problems.push({ name: entry.path, reason: '同批次重名，已跳过' }); continue }
    seen.add(id)
    targets.push({ group, name, bytes: entry.bytes })
  }
  return { targets, problems }
}
