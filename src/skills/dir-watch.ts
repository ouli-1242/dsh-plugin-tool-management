// 目录监听：外部改动 200ms 防抖后通知失效（技能来源与规则根目录共用同一份实现）。
//
// 从 skills/service.ts 整段搬来，一行未改。为什么走 worker_threads 而不是 fs.watch(recursive)
// 写在它自己的注释里 —— Windows 上那条路会在目录被删除时静默卡死事件循环。
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

// ── 文件监听：外部改动自动失效 ────────────────────────────────────────────

/**
 * 监听目录，200ms 防抖后回调：在编辑器或其他工具里新增/修改/删除文件后，无需手动
 * 刷新即可看到变化。技能来源与规则根目录共用（见 src/memories/service.ts 的场景记忆段缓存）。
 *
 * 为什么用 worker_threads：Windows 上 fs.watch(recursive) 的句柄在「被监听
 * 目录被删除」时会静默卡死事件循环（不触发 error、unref 也无效）——宿主
 * 进程将永远无法退出。把 watcher 放进独立的 worker 线程，主线程对 worker
 * unref()，无论目录发生什么，宿主与测试进程都能正常收尾；worker 内部失败
 * 也不影响主线程。目录不存在或平台不支持递归监听时静默跳过。
 */
export function watchDirectories(paths: string[], invalidate: () => void): () => void {
  const valid = paths.filter((dir) => dir && existsSync(dir))
  if (!valid.length) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try { invalidate() } catch { /* 失效失败不影响监听 */ }
    }, 200)
  }
  let worker: import('node:worker_threads').Worker | null = null
  try {
    // eval 模式内联 worker 代码：无需额外文件与构建步骤。worker 事件循环独立，
    // 主线程 unref 后完全不参与宿主进程的退出判定。
    const src = `
      const { watch } = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      for (const dir of workerData.paths) {
        try {
          const w = watch(dir, { recursive: true, persistent: false }, () => {
            try { parentPort.postMessage('change') } catch { /* worker 正在关闭 */ }
          });
          w.on('error', () => { /* 目录被移除等：忽略，不向主线程传播 */ });
        } catch { /* 不可监听（权限/平台）时跳过该目录 */ }
      }
    `
    worker = new Worker(src, { eval: true, workerData: { paths: valid } })
    worker.unref()
    worker.on('message', () => fire())
    worker.on('error', () => { /* worker 崩溃即失去监听；op 全量重扫天然兜底 */ })
  } catch { /* worker 不可用时静默跳过，功能退化为依赖 op 全量扫描 */ }
  return () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (worker) {
      const w = worker
      worker = null
      try { w.removeAllListeners(); w.terminate() } catch { /* ignore */ }
    }
  }
}