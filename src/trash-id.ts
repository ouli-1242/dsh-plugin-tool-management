// 回收站条目 id：**一个生成器，五个域共用**（2026-10-15 smoke-test P1-7）。
//
// 为什么单独一个文件：`hub.ts` 引了 `skills/core.js` 的 `resolveDshHome`，所以技能域不能反过来
// 引 `hub.ts` 取这个函数 —— 那正好把 2026-10-01 剥层拆掉的那个运行时环重新接上（见 core.ts
// 头部的层注释）。放到这一叶模块里，两边都只向下引，不产生环。
//
// 形状：时间戳 base36 + uuid 前 8 位。统一它不是为了审美 —— 五个域的 `*_manager_remove` 都按
// `action=list` 给出的 id 做 restore，模型跨域操作时认得这一种形状就够。此前技能域另写了一套
// `${Date.now()}-${randomUUID()}`（十进制时间戳 + 完整 uuid），拿到的是另一种长相。
//
// 读写都是**向后兼容**的：读侧只校验「单个合法路径段」（`entryPath` / `isValidSegment`），
// 两种形状都过；磁盘上已有的旧条目照旧能列、能恢复。
import { randomUUID } from 'node:crypto'

export function newTrashId(): string {
  return Date.now().toString(36) + '-' + randomUUID().slice(0, 8)
}
