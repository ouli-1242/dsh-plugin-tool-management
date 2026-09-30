// 快捷提示词域的 HTTP ops（实现见 ../prompts/quick-service.ts）。
//
// 与 `ops/prompts.ts` 的差别不是"少写了几条"，而是**这个域没有宿主状态**：不写
// `~/.dsh/AGENTS.md`、不参与场景同步、没有"生效中"。所以这里既不需要 `withAgentsMdSync`
// 也不需要引用探测 —— 反过来，正因为它是纯侧车读写，才更要老老实实进 `op-registry`
// 的写门禁清单（配了令牌的宿主上，免令牌请求不该能改用户存好的文字）。

import type { createQuickPromptsService } from '../prompts/quick-service.js'

type QuickServiceLike = ReturnType<typeof createQuickPromptsService>

export function buildQuickPromptOps(quick: QuickServiceLike): Record<string, (args: any) => Promise<any>> {
  const text = (args: any, key: string): string | undefined =>
    args && typeof args[key] === 'string' ? String(args[key]) : undefined
  return {
    // 列表连正文一起回（客户端点用时手里就得有那段字，见 quick-service.ts 头注）。
    'quickprompt-list': async () => quick.list(),
    'quickprompt-create': (args: any) => quick.create(
      String((args && args.id) || ''),
      text(args, 'content') ?? '',
      text(args, 'description'),
    ),
    // 改名不牵连任何别处：快捷提示词不被场景绑定、不被引用，改完就是改完了。
    'quickprompt-update': (args: any) => quick.update(
      String((args && args.id) || ''),
      text(args, 'content') ?? '',
      args && args.nextId !== undefined ? String(args.nextId) : undefined,
      text(args, 'description'),
    ),
    'quickprompt-remove': (args: any) => quick.remove(String((args && args.id) || '')),
    // 启停只改侧车的 `enabled`（在不在对话框 `/` 菜单里出现），正文一个字不动。
    // `enabled` 必须是真布尔：省略它不叫"打开"，而是调用方写错了，静默按某一种处理会
    // 让界面与落盘各说各话。
    'quickprompt-toggle': (args: any) => (args && typeof args.enabled === 'boolean')
      ? quick.setEnabled(String((args && args.id) || ''), args.enabled === true)
      : Promise.resolve({ ok: false, error: '缺少 enabled（true / false）' }),
    'quickprompt-trash-list': () => quick.trashList(),
    'quickprompt-trash-restore': (args: any) => quick.trashRestore(String((args && args.id) || '')),
    'quickprompt-trash-delete': (args: any) => quick.trashDelete(String((args && args.id) || '')),
  }
}
