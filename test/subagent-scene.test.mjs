// test/subagent-scene.test.mjs —— 场景档案对子智能体的绑定校验（设计 §3.3）回归测试。
//
// 锁的行为：启用场景的 subagents 并集为空 = 全部人设可用；非空 = 只放行交集，
// 且 `subagent_run` 对不在交集里的人设必须在**运行之前**结构化拒绝（「人设不可用」），
// 不能先把 task 送进子代理再报错（那会白烧 token）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterBySceneBinding,
  defineSubagentListTool,
  defineSubagentRunTool,
} from '../lib/subagents/tools.js'

const persona = (name, description = '') => ({ name, description, body: '# ' + name, path: name + '.md' })
const docs = [persona('echo-test', '回声验证人设'), persona('other-helper', '另一种人设')]

/** 记录 runSerial 是否被调用：被调用即代表校验放行了。 */
const makeService = (sceneLists) => {
  const calls = []
  return {
    calls,
    list: async () => docs,
    sceneLists: async () => sceneLists,
    runSerial: async (_agent, p, task) => {
      calls.push({ persona: p.name, task })
      return { text: 'ECHO:' + task, runId: 'r1', stopReason: 'completed' }
    },
  }
}

test('filterBySceneBinding：空绑定（无启用场景/场景未绑人设）→ 全部可用', async () => {
  assert.deepEqual(await filterBySceneBinding(docs, []), { allowed: docs, reason: null })
  assert.deepEqual(await filterBySceneBinding(docs, [[]]), { allowed: docs, reason: null })
})

test('filterBySceneBinding：多场景取并集；交集为空时给出绑定清单', async () => {
  const one = await filterBySceneBinding(docs, [['other-helper']])
  assert.deepEqual(one.allowed.map((d) => d.name), ['other-helper'])
  assert.equal(one.reason, null)

  const both = await filterBySceneBinding(docs, [['other-helper'], ['echo-test']])
  assert.deepEqual(both.allowed.map((d) => d.name), ['echo-test', 'other-helper'])

  const none = await filterBySceneBinding(docs, [['ghost']])
  assert.deepEqual(none.allowed, [])
  assert.match(none.reason, /ghost/)
})

test('subagent_run：场景只绑 other-helper 时跑 echo-test → 运行前拒绝「人设不可用」', async () => {
  const svc = makeService([['other-helper']])
  const tool = defineSubagentRunTool(svc)
  await assert.rejects(
    () => tool.execute({ agent: 'echo-test', task: '回声验证' }, { agent: { session: {} } }),
    (e) => /人设不可用: echo-test/.test(e.message) && /other-helper/.test(e.message),
  )
  assert.deepEqual(svc.calls, [], '拒绝必须发生在 runSerial 之前（不得白烧 token）')
})

test('subagent_run：未绑定任何场景 → 人设照常运行；非 completed 结果带 stopReason 前缀', async () => {
  const svc = makeService([])
  const tool = defineSubagentRunTool(svc)
  assert.equal(await tool.execute({ agent: 'echo-test', task: 'A' }, { agent: {} }), 'ECHO:A')
  assert.deepEqual(svc.calls, [{ persona: 'echo-test', task: 'A' }])

  const aborted = defineSubagentRunTool({
    list: async () => docs,
    sceneLists: async () => [],
    runSerial: async () => ({ text: 'partial', runId: 'r2', stopReason: 'aborted' }),
  })
  assert.equal(await aborted.execute({ agent: 'echo-test', task: 'B' }, { agent: {} }), '[stopReason: aborted]\npartial')
})

test('subagent_run：task 为空 / 缺 exec.agent → 结构化拒绝，不进入运行', async () => {
  const svc = makeService([])
  const tool = defineSubagentRunTool(svc)
  await assert.rejects(() => tool.execute({ agent: 'echo-test', task: '  ' }, { agent: {} }), /task 不能为空/)
  await assert.rejects(() => tool.execute({ agent: 'echo-test', task: 'x' }, {}), /缺少调用方 agent/)
  assert.deepEqual(svc.calls, [])
})

test('subagent_list：只列场景绑定的子集，并附绑定注意行；未绑定时列全部', async () => {
  const bound = defineSubagentListTool(makeService([['other-helper']]))
  const text = await bound.execute({})
  assert.match(text, /人设子智能体（1）/)
  assert.match(text, /other-helper/)
  assert.doesNotMatch(text, /echo-test/)

  const all = defineSubagentListTool(makeService([]))
  const allText = await all.execute({})
  assert.match(allText, /人设子智能体（2）/)
  assert.doesNotMatch(allText, /注意/)
})
