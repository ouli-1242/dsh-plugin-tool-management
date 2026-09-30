// 记忆导出的落盘映射：把「导出哪几条记忆」算成 zip 里的条目与缺失清单。
//
// 从 memories/service.ts 整段搬来，一行未改。它是纯函数（不碰磁盘）——flat / bundle 两种
// 形态与「场景名本身可含 /」的口径都写在它自己的注释里，那条口径两边必须一致。
import { dirname } from 'node:path'

/**
 * 记忆导出的落盘映射（`bundle-export` 的 `kind: 'memories'` 用，见 design-plan D14）。
 *
 * 记忆有两种形态（见文件头）：flat = `<场景>/<name>.md`，bundle = `<场景>/<name>/<name>.md`；
 * 而且**场景名本身可含 `/`**（多段场景名，见 `isValidGroupPath`）。所以「按 id 的最后一个
 * `/` 切出场景与名字、再拼 `.md`」是错的：bundle 会被读成 `<场景>/<name>.md` → 读不到 →
 * 该项目静默丢失（只在 `missing` 里留个名，界面按「导出成功」显示）。
 *
 * 这里一律按索引里那条规则自己的 `path` 与 `form` 决定；bundle 只交出目录，由调用方
 * 把目录内的文件全部打包（与技能分支同口径）。索引里没有、或已被同名 bundle 遮蔽的 id
 * 进 `missing`——遮蔽的 flat 不会被加载，导出去只会让人以为它能用。
 *
 * 纯函数（不碰磁盘），可直接断言。
 */
export function planMemoryExport(
  names: unknown,
  rules: unknown,
): { entries: Array<{ id: string; zip: string; abs: string; kind: 'file' | 'dir' }>; missing: string[] } {
  type Row = { id?: unknown; form?: unknown; path?: unknown; shadowed?: unknown }
  const list = Array.isArray(names) ? names.map((n) => String(n).trim()).filter(Boolean) : []
  const byId = new Map<string, Row>()
  for (const row of (Array.isArray(rules) ? rules : []) as Row[]) {
    const id = row && typeof row.id === 'string' ? row.id : ''
    if (id !== '') byId.set(id, row)
  }
  const entries: Array<{ id: string; zip: string; abs: string; kind: 'file' | 'dir' }> = []
  const missing: string[] = []
  for (const id of list) {
    const row = byId.get(id)
    const abs = row && typeof row.path === 'string' ? row.path : ''
    if (!row || abs === '' || row.shadowed === true) {
      missing.push(id)
      continue
    }
    entries.push(row.form === 'bundle'
      ? { id, zip: id, abs: dirname(abs), kind: 'dir' }
      : { id, zip: `${id}.md`, abs, kind: 'file' })
  }
  return { entries, missing }
}