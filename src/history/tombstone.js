//#region lib/types/tombstone.js
/**
 * 通用墓碑簿记：登记一个已删除 id，并按 FIFO 在上限处淘汰最旧项。
 * 工作区注册表（lib/history/workspace.js）在用；淘汰策略集中在这里，避免各处拷贝分叉。
 */
/**
 * 登记已删除 id 并执行上限淘汰。
 * @param {Set<string>} ids - 墓碑集合。
 * @param {string[]} order - 插入顺序队列（FIFO 淘汰依据）。
 * @param {string} id - 本次登记的 id。
 * @param {number} limit - 墓碑上限。
 * @returns {string[]} 被淘汰出集合的旧 id 列表，调用方据此清理附属簿记。
 */
function trackTombstone(ids, order, id, limit) {
	if (!ids.has(id)) {
		ids.add(id);
		order.push(id);
	}
	const evicted = [];
	while (order.length > limit) {
		const oldest = order.shift();
		// id 自身被挤出队列时保留在集合中：宁多挡不错放。
		if (oldest !== void 0 && oldest !== id) {
			ids.delete(oldest);
			evicted.push(oldest);
		}
	}
	return evicted;
}
//#endregion
export { trackTombstone };
