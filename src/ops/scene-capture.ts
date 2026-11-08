// 「把当前状态存成场景」这一个 op（面板与模型共用）。
//
// 为什么要有它：档案的四段（MCP / 技能 / 人设 / 快捷提示词）此前**只能手填** ——
// 模型要照着当前生效的样子存一份，就得先查一遍现状、再把勾选集拼出来；
// 拼错一个键就是「进场景时把某个服务器关掉了」。这里把「照现在的样子」变成一步。
//
// 与既有 op 的关系：建场景走 `rules-create-scene`（幂等 upsert），存档案走
// `scene-archive-save`（带 stale 校验与就地重应用）—— 本 op 只做**编排**，
// 不另写一份建场景 / 存档案的逻辑，免得两处口径分家。

import { captureArchive, type CaptureStateInput } from '../memories/archive.js'

/** 这一个 op 的依赖（全部显式传入，与 ops/compat.ts 同一纪律）。 */
export interface SceneCaptureDeps {
  /** 建场景记录（`rules-create-scene` 的正文）。 */
  createScene(args: any): Promise<any>
  /** 存档案（`scene-archive-save` 的正文）。 */
  saveArchive(args: any): Promise<any>
  /** 读当前生效状态。 */
  captureState(): Promise<CaptureStateInput>
  /** 错误 → 文案。 */
  message(e: unknown): string
}

/** 组装本域 op。 */
export function buildSceneCaptureOps(deps: SceneCaptureDeps): Record<string, (args: any) => Promise<any>> {
  return {
    /**
     * 把当前生效的状态存成一份新的场景档案。
     *
     * 采集的是**全局**状态（不含会话层覆盖）：会话覆盖是「这个对话看什么」，
     * 场景档案是机器级的，两者不是一回事。
     */
    'scene-capture': async (args: any): Promise<any> => {
      const name = String((args && args.name) || '').trim()
      if (name === '') return { ok: false, error: '缺少场景名' }
      // ① 建场景（幂等 upsert：已存在则按给的 label / description 更新）。
      const created = await deps.createScene({
        name,
        ...(args && args.label !== undefined ? { label: String(args.label) } : {}),
        ...(args && args.description !== undefined ? { description: String(args.description) } : {}),
      })
      if (!created || created.ok === false) return created
      // ② 采集当前状态。读失败时**不写档案**：宁可留一个空场景，也不要写一份
      //    少了一半的档案 —— 那份档案进场景时会关掉一半东西，比空场景危险得多。
      let state: CaptureStateInput
      try {
        state = await deps.captureState()
      } catch (e) {
        return {
          ok: false,
          error: '读取当前状态失败（场景「' + name + '」已建好，档案未写）：' + deps.message(e),
          scene: name,
          created: true,
        }
      }
      const archive = captureArchive(state)
      // ③ 存档案（引擎会按实时发现全集校验，失效的键丢掉并如实报 stale）。
      const saved = await deps.saveArchive({ scene: name, archive })
      if (!saved || saved.ok === false) {
        return {
          ok: false,
          error: '场景「' + name + '」已建好，但档案没写成功：' + ((saved && saved.error) || '未知原因'),
          scene: name,
          created: true,
        }
      }
      return {
        ok: true,
        scene: name,
        archive,
        // 引擎报出来的 stale（采集到、但存的时候已经失效的条目）原样带回。
        stale: Array.isArray(saved.stale) ? saved.stale : [],
        summary: {
          mcp: Object.keys(archive.mcp || {}).length,
          skills: (archive.skills || []).length,
          subagents: (archive.subagents || []).length,
          quickPrompts: (archive.quickPrompts || []).length,
        },
      }
    },
  }
}
