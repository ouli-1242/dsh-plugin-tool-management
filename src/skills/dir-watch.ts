// 目录监听：外部改动 200ms 防抖后通知失效（技能来源与规则根目录共用同一份实现）。
//
// 从 skills/service.ts 整段搬来，一行未改。为什么走 worker_threads 而不是 fs.watch(recursive)
// 写在它自己的注释里 —— Windows 上那条路会在目录被删除时静默卡死事件循环。
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

// ── 文件监听：外部改动自动失效 ────────────────────────────────────────────

/** 目录监听的句柄。`attached()` 说明监听到底挂上没有 —— 调用方据此决定能不能缓存。 */
export interface DirectoryWatch {
  /** 停止监听并清掉防抖定时器（幂等）。 */
  dispose(): void
  /**
   * 监听此刻是否真的挂着。
   *
   * 为什么要报这一位：调用方可能拿它当"磁盘变了我会被告知"的凭据去缓存扫描结果。
   * worker 建不出来 / 目录不存在 / 平台不支持 / worker 已崩溃时这里为 false ——
   * 那时缓存只能靠 TTL，不能当成"永不变化"。
   *
   * 是**函数**而不是属性：worker 的"已挂上"消息是异步回来的，返回句柄那一刻还拿不到。
   */
  attached(): boolean
}

/**
 * 监听目录，200ms 防抖后回调：在编辑器或其他工具里新增/修改/删除文件后，无需手动
 * 刷新即可看到变化。技能来源与记忆根目录共用。
 *
 * 为什么用 worker_threads：Windows 上 fs.watch(recursive) 的句柄在「被监听
 * 目录被删除」时会静默卡死事件循环（不触发 error、unref 也无效）——宿主
 * 进程将永远无法退出。把 watcher 放进独立的 worker 线程，主线程对 worker
 * unref()，无论目录发生什么，宿主与测试进程都能正常收尾；worker 内部失败
 * 也不影响主线程。目录不存在或平台不支持递归监听时静默跳过（`attached: false`）。
 *
 * 已知边界：worker 崩溃或某个目录监听失败**不会**回报（它只是少了一条变化通知）。
 * 所以依赖 `attached` 做缓存的调用方必须再叠一层 TTL —— 把"监听还在"当成前提，
 * 静默失效就会变成永久返回旧内容。
 */
export function watchDirectories(paths: string[], invalidate: () => void): DirectoryWatch {
  const valid = paths.filter((dir) => dir && existsSync(dir))
  if (!valid.length) return { dispose: () => {}, attached: () => false }
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try { invalidate() } catch { /* 失效失败不影响监听 */ }
    }, 200)
  }
  let worker: import('node:worker_threads').Worker | null = null
  let attached = false
  try {
    // eval 模式内联 worker 代码：无需额外文件与构建步骤。worker 事件循环独立，
    // 主线程 unref 后完全不参与宿主进程的退出判定。
    const src = `
      const { watch } = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      let live = 0;
      for (const dir of workerData.paths) {
        try {
          // persistent: true 是必需的：worker 里若唯一的句柄是 non-persistent 的 watch，
          // 事件循环当场空掉、worker 自己退出 —— 消息一条都收不到（实测）。不挡宿主退出
          // 靠的是主线程对 worker 的 unref()，不是这里的 persistent。
          const w = watch(dir, { recursive: true, persistent: true }, () => {
            try { parentPort.postMessage('change') } catch { /* worker 正在关闭 */ }
          });
          w.on('error', () => { /* 目录被移除等：忽略，不向主线程传播 */ });
          live += 1;
        } catch { /* 不可监听（权限/平台）时跳过该目录 */ }
      }
      parentPort.postMessage({ attached: live > 0 });
    `
    // `execArgv: []` 是必需的，不是洁癖：worker 默认**继承**父进程的 execArgv，
    // 而 eval 模式的代码是 CommonJS（用了 `require`）。父进程若带着 `--input-type=module`
    // （`node -e` / 测试用 `--input-type` 跑），那段代码会被当成 ESM 求值，
    // `require is not defined` —— 表现为"监听静默没挂上"，而这里的所有失败都是静默的。
    worker = new Worker(src, { eval: true, workerData: { paths: valid }, execArgv: [] })
    worker.unref()
    worker.on('message', (msg) => {
      if (msg && typeof msg === 'object' && 'attached' in msg) { attached = msg.attached === true; return }
      fire()
    })
    // 崩溃 / 意外退出必须把 `attached` 降回 false：否则调用方会一直以为监听还挂着，
    // 只靠 TTL 兜底，而重试逻辑（见记忆服务的 `ensureMemoriesWatch`）永远等不到复活机会。
    // `dispose()` 先 `removeAllListeners()`，所以主动终止不会走到这里。
    worker.on('error', () => { attached = false })
    worker.on('exit', () => { attached = false })
  } catch { /* worker 不可用时静默跳过，功能退化为依赖调用方自己的 TTL */ }
  return {
    attached: () => attached,
    dispose: () => {
      if (timer) { clearTimeout(timer); timer = null }
      if (worker) {
        const w = worker
        worker = null
        try { w.removeAllListeners(); w.terminate() } catch { /* ignore */ }
      }
    },
  }
}