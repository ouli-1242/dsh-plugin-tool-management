// test/approval-policy.test.mjs —— never 审批策略探测的回归测试（node --test）。
//
// 这个文件锁的是 2026-09-13 19:52 会话实测到的 bug：完全权限（approval=never）
// 会话里 pre-execute 的 never 探测返回 false，模型只收到通用的「用户拒绝」。
// 根因是 `ctx.approval` 在本插件里会抛 `cannot get property "approval" without
// inject`（inject 未声明 approval），被 try/catch 吞成 false。
//
// 探测通过后确认门怎么行为（口径：never = 用户已预先批准 → 直接放行）在 src/index.ts，
// 本文件只锁「探测本身」的真值表——它是那个决定的唯一输入。
//
// 复现形态必须用**兄弟 fiber**：服务由另一个插件 fiber 提供。若把 ApprovalService
// 直接建在 root 上，注册会落进 root fiber 的 store，而 root 是所有插件 fiber 的
// 祖先，`ctx.approval` 沿链就能找到，反而不抛——那样测不出真问题。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { isApprovalNever } from '../lib/approval-policy.js'

// ---------------------------------------------------------------- 测试脚手架

/** 按 dsh-user-approval 的会话契约造 fold 载体：overrideOf 只读 seq/eventAt。 */
const foldSession = () => {
  const events = []
  return {
    get seq() { return events.length },
    eventAt: (seq) => events[Number(seq)],
    append: (type, data) => events.push({ type, data }),
  }
}

/**
 * 起一个最小 cordis 应用：兄弟 fiber A 提供真实 ApprovalService，fiber B 当作
 * 「本插件」的上下文（inject 里没有 approval，与生产一致）。
 */
const mount = async (policy) => {
  const root = new Context()
  const ownerFork = root.plugin({
    name: 'approval-owner',
    apply(ctx) { new ApprovalService(ctx, { policy }) },
  })
  let probeCtx
  const probeFork = root.plugin({ name: 'tool-management-probe', apply(ctx) { probeCtx = ctx } })
  await ownerFork
  await probeFork
  assert.ok(probeCtx, 'probe 插件未获得上下文')
  return { root, ctx: probeCtx }
}

const execFor = (session) => ({ name: 'subagent_run', agent: { session } })

// -------------------------------------------------------------------- 用例

test('根因锁定：兄弟 fiber 里 ctx.approval 抛错，ctx.get("approval") 正常解析', async () => {
  const { ctx } = await mount('ask')
  assert.throws(() => ctx.approval)
  assert.equal(typeof ctx.get('approval'), 'object')
})

test('never 探测：会话 fold 为 never（完全权限预设的真实写法）→ true', async () => {
  const { ctx } = await mount('ask')
  const session = foldSession()
  setApprovalPolicy(session, 'never') // dsh-permission-presets 就是这么切的
  assert.equal(isApprovalNever(ctx, execFor(session)), true)
})

test('never 探测：ask 会话 → false（确认门照常弹出）', async () => {
  const { ctx } = await mount('ask')
  const session = foldSession()
  assert.equal(isApprovalNever(ctx, execFor(session)), false)
})

test('never 探测：全局默认 config.policy=never 且无会话 fold → true；会话 fold 可翻回 ask', async () => {
  const { ctx } = await mount('never')
  const session = foldSession()
  assert.equal(isApprovalNever(ctx, execFor(session)), true)
  setApprovalPolicy(session, 'ask') // 会话级覆盖优先于全局默认
  assert.equal(isApprovalNever(ctx, execFor(session)), false)
})

test('never 探测：无 agent/session 时退回 config.policy；两者都没有 → false', async () => {
  const never = await mount('never')
  assert.equal(isApprovalNever(never.ctx, { name: 'subagent_run' }), true)
  const ask = await mount('ask')
  assert.equal(isApprovalNever(ask.ctx, { name: 'subagent_run' }), false)
})

test('never 探测：服务缺失 / 读取抛错 / ctx 无 get → 一律 false（退回正常问询，不擅自放行）', () => {
  const bare = new Context() // 没有任何 approval provider
  assert.equal(isApprovalNever(bare, execFor(foldSession())), false)
  assert.equal(isApprovalNever(undefined, execFor(foldSession())), false)
  assert.equal(isApprovalNever({}, execFor(foldSession())), false)
  const throwing = { get: () => ({ effectivePolicy() { throw new Error('boom') } }) }
  assert.equal(isApprovalNever(throwing, execFor(foldSession())), false)
  const brokenSession = { get: () => ({ effectivePolicy: (s) => (s.seq === undefined ? undefined : 'never') }) }
  assert.equal(isApprovalNever(brokenSession, { name: 'subagent_run' }), false)
})
