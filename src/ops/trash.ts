// 规则/记忆域的**回收站 ops**（2026-09-19 从 memories/service.ts 的 createMemoriesService 闭包抽出）。
//
// 删除进回收站、从回收站恢复、回收站列出与彻底删除。与记忆正文 ops 分域，
// 但共用 copyIntoMemoriesTrash 等入口，经 MemoriesOpsCtx 显式传入。

import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidTrashId } from '../hub.js'
import { LEGACY_BUNDLE_DOC, bundleDocName, isValidGroupSegment, isValidGroupPath, fail, MEMORIES_TRASH_DIR } from '../memories/constants.js'
import { readIndex, writeIndex } from '../memories/index-io.js'
import type { MemoriesOpsCtx } from './ctx.js'

/** 组装本域 op。rc 由 createMemoriesService 组装，契约见 ./ctx.ts。 */
export function buildTrashOps(rc: MemoriesOpsCtx) {
  const { buildProjected, copyIntoMemoriesTrash, invalidateSnapshot, locateRule, parseId, refuseOutsideRoot, memoriesRoot, stateDir } = rc

  async function rulesRemove(args: any): Promise<any> {
    const id = String((args && args.id) || '')
    const parts = parseId(id)
    if (!parts) return fail('error.rules.notFound', `规则不存在：${id}`)
    const located = await locateRule(parts.group, parts.name)
    if (!located) return fail('error.rules.notFound', `规则不存在：${id}`)
    // 删除前确认落点仍在根内（realpath 口径）：`located` 是顺着磁盘发现的，中间目录可能是链接。
    const denied = await refuseOutsideRoot(located.entryPath)
    if (denied) return denied
    const trashId = await copyIntoMemoriesTrash(located, parts.group, parts.name)
    if (located.kind === 'bundle') await rm(located.entryPath, { recursive: true, force: true })
    else await rm(located.docPath, { force: true })
    const index = await readIndex(stateDir)
    delete index.rules[id]
    await writeIndex(stateDir, index)
    invalidateSnapshot()
    return { ok: true, trashId }
  }

  async function rulesRestore(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const trashDir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    let manifest: { group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string }
    try {
      manifest = JSON.parse(await readFile(join(trashDir, 'manifest.json'), 'utf8')) as typeof manifest
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.group !== 'string' || !isValidGroupSegment(manifest.name)) {
      return fail('error.rules.notFound', `回收站条目损坏：${trashId}`)
    }
    // 恢复目标已存在（期间用户重建了同名规则）→ 拒绝，避免覆盖。
    const conflict = await locateRule(manifest.group, manifest.name)
    if (conflict) {
      return fail('error.rules.exists', `同名记忆已存在：${conflict.id}，请先移除后再恢复`)
    }
    const form = manifest.form === 'bundle' ? 'bundle' : 'flat'
    if (form === 'bundle') {
      await mkdir(join(memoriesRoot, manifest.group), { recursive: true })
      const { cp } = await import('node:fs/promises')
      await cp(join(trashDir, 'bundle'), join(memoriesRoot, manifest.group, manifest.name), { recursive: true })
    } else {
      await mkdir(join(memoriesRoot, manifest.group), { recursive: true })
      await copyFile(join(trashDir, 'rule.md'), join(memoriesRoot, manifest.group, manifest.name + '.md'))
    }
    await rm(trashDir, { recursive: true, force: true })
    invalidateSnapshot()
    return { ok: true, rule: await buildProjected(manifest.group ? `${manifest.group}/${manifest.name}` : manifest.name) }
  }

  /**
   * 记忆回收站列表（只读）：`<stateDir>/memories-trash/<trashId>/`（`rulesRemove` 移入，
   * `rulesRestore` 恢复）。损坏或内容缺失的条目跳过，不让一个坏条目挡住整份列表。
   */
  async function rulesTrashList(): Promise<any> {
    const root = join(stateDir, MEMORIES_TRASH_DIR)
    let ids: string[] = []
    try {
      ids = await readdir(root)
    } catch {
      return { ok: true, entries: [] } // 目录不存在 = 回收站为空
    }
    const entries: Array<{ trashId: string; group: string; name: string; form: 'flat' | 'bundle'; deletedAt: string; bytes: number }> = []
    for (const trashId of ids) {
      if (!isValidTrashId(trashId)) continue
      const dir = join(root, trashId)
      try {
        const st = await lstat(dir)
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
        if (!manifest || typeof manifest.name !== 'string' || !isValidGroupSegment(manifest.name)) continue
        const group = typeof manifest.group === 'string' ? manifest.group : ''
        if (group !== '' && !isValidGroupPath(group)) continue
        const form: 'flat' | 'bundle' = manifest.form === 'bundle' ? 'bundle' : 'flat'
        let bytes = 0
        try {
          const bundleDoc = form === 'bundle'
            ? join(dir, 'bundle', bundleDocName(manifest.name))
            : join(dir, 'rule.md')
          bytes = (await stat(bundleDoc)).size
        } catch {
          // 兼容旧回收站条目（正文仍叫 SKILL.md）；仍读不到就按 0 计，恢复时由 rulesRestore 兜底报错。
          if (form === 'bundle') {
            try { bytes = (await stat(join(dir, 'bundle', LEGACY_BUNDLE_DOC))).size } catch { /* 内容缺失 */ }
          }
        }
        entries.push({ trashId, group, name: manifest.name, form, deletedAt: String(manifest.deletedAt || ''), bytes })
      } catch { /* 损坏条目跳过 */ }
    }
    entries.sort((a, b) => (a.deletedAt === b.deletedAt ? b.trashId.localeCompare(a.trashId) : b.deletedAt.localeCompare(a.deletedAt)))
    return { ok: true, entries }
  }

  /** 永久删除回收站条目（不可恢复）。 */
  async function rulesTrashRemove(args: any): Promise<any> {
    const trashId = String((args && args.trashId) || '')
    if (!isValidTrashId(trashId)) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    const dir = join(stateDir, MEMORIES_TRASH_DIR, trashId)
    try {
      const st = await lstat(dir)
      if (!st.isDirectory()) return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    } catch {
      return fail('error.rules.notFound', `回收站条目不存在：${trashId}`)
    }
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  }

  return { rulesRemove, rulesRestore, rulesTrashList, rulesTrashRemove }
}
