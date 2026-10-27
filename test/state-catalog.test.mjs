// 状态段缓存的 TTL 选择：空清单只影响「多久确认一次还是空的」，不能改变非空路径的新鲜度。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpStateCatalog } from '../lib/mcp/state-section.js'

/** 假时钟 + 行数据源；`tick` 让 `void revalidate()` 的后台重算落地。 */
function harness(rowsOf) {
  let time = 0
  let calls = 0
  const catalog = createMcpStateCatalog({
    rows: async () => {
      calls += 1
      return { ok: true, rows: rowsOf() }
    },
  }, { now: () => time, ttlMs: 3000, emptyTtlMs: 60_000 })
  return {
    catalog,
    advance: (ms) => { time += ms },
    calls: () => calls,
    tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

const oneRow = () => [{ id: 'mcp-a', serverName: 'a', toolCount: 1, enabledToolCount: 1, liveToolCount: 1, liveEnabledToolCount: 1 }]

test('空清单：ttlMs 到点不重算，emptyTtlMs 到点才重算', async () => {
  const h = harness(() => [])
  await h.catalog.warm()
  assert.equal(h.calls(), 1)

  h.advance(3001)
  h.catalog.text()
  await h.tick()
  assert.equal(h.calls(), 1, '空清单不该按 ttlMs 重算')

  h.advance(60_000)
  h.catalog.text()
  await h.tick()
  assert.equal(h.calls(), 2, 'emptyTtlMs 到点后应重算一次')
})

test('非空清单：仍按 ttlMs 重算', async () => {
  const h = harness(oneRow)
  await h.catalog.warm()
  assert.equal(h.calls(), 1)

  h.advance(3001)
  h.catalog.text()
  await h.tick()
  assert.equal(h.calls(), 2, '有行时新鲜度契约不变')
})

test('refresh() 无视两种 TTL，立即重算', async () => {
  const h = harness(() => [])
  await h.catalog.warm()
  assert.equal(h.calls(), 1)

  h.advance(1)
  await h.catalog.refresh()
  assert.equal(h.calls(), 2)
})
