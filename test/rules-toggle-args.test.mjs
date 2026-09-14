// rules-toggle 的入参口径：**enabled 必须显式给**。
//
// 旧实现缺省时"沿用当前值"，却照样刷新 updatedAt 并返回 ok:true —— 外部调用方按
// toggle（翻转）理解时会以为自己改了状态，实际什么都没改（界面不受影响：它一直显式
// 传值）。与 rules-set-active 同一条原则：参数缺失就明确拒绝，不猜。
//
// 断言只有两条，都是行为：**被拒 + 没写盘**。消息文案不锁（改文案不该弄红测试）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRulesService } from '../lib/rules/service.js'

async function makeService() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-rules-toggle-'))
  const stateDir = join(base, 'tool-management')
  const service = createRulesService({}, { rulesRoot: join(stateDir, 'memories'), stateDir, scenesDir: join(stateDir, 'scenes') })
  return { stateDir, service }
}

test('rules-toggle：缺 enabled 时明确拒绝，且不写盘、不改 updatedAt', async () => {
  const { stateDir, service } = await makeService()
  await service.ops['rules-create-scene']({ name: '办公' })
  await service.ops['rules-create']({ group: '办公', name: '甲', body: '甲正文' })
  await service.ops['rules-toggle']({ id: '办公/甲', enabled: false })

  const readIndex = async () => JSON.parse(await readFile(join(stateDir, 'rules-index.json'), 'utf8'))
  const before = await readIndex()
  assert.equal(before.rules['办公/甲'].enabled, false, '前置：显式传值要真的生效')

  const rejected = await service.ops['rules-toggle']({ id: '办公/甲' })
  assert.equal(rejected.ok, false, '缺 enabled 必须失败，不能假装成功')
  assert.equal(rejected.code, 'error.rules.invalidArgs')

  const after = await readIndex()
  assert.deepEqual(after.rules['办公/甲'], before.rules['办公/甲'], '被拒的调用不许写盘（含 updatedAt）')
  assert.equal((await service.ops['rules-list']({})).rules.find((r) => r.id === '办公/甲').enabled, false, '状态照旧')

  // 显式传值照旧可用（两个方向都试）。
  assert.equal((await service.ops['rules-toggle']({ id: '办公/甲', enabled: true })).ok, true)
  assert.equal((await readIndex()).rules['办公/甲'].enabled, true)
})
