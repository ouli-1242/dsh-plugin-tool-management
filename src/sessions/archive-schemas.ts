// 归档账本文件的字段校验器（十个 schema）。
//
// 从 sessions/workspace.ts 整段搬来，一行未改。每个 schema 只管「这一份 JSON 读进来是不是
// 合法形状」，不认识注册表也不碰宿主 —— 写坏了统一抛 TypeError，由调用方决定是修复还是拒绝。
import type { HostResultRecord } from "./workspace.js";

export const sessionIdSchema = {
	parse(value: unknown): string {
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError(
				`sessionId must be a non-empty string, got ${String(value)}`,
			);
		return value;
	},
};
export const workspaceIdSchema = {
	parse(value: unknown): string {
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError(
				`workspaceId must be a non-empty string, got ${String(value)}`,
			);
		return value;
	},
};
export const archivedSetSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		const ids = value.archivedSessionIds;
		if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string"))
			throw new TypeError("archivedSessionIds must be a string array");
		return value;
	},
};
export const deletedSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			value.deleted !== true
		)
			throw new TypeError("deleted must be true");
		return value;
	},
};
export const archivedBatchTargetSchema = {
	// 校验通过后原样返回记录，调用方按 scope 判别式收窄（宿主返回值校验器，故返回 any）。
	parse(value: HostResultRecord): any {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("target must be an object");
		if (value.scope === "all" || value.scope === "ungrouped") return value;
		if (
			value.scope === "workspace" &&
			typeof value.workspaceId === "string" &&
			value.workspaceId.length > 0
		)
			return value;
		if (
			value.scope === "sessions" &&
			Array.isArray(value.sessionIds) &&
			value.sessionIds.length > 0 &&
			value.sessionIds.every((id: unknown) => typeof id === "string" && id.length > 0)
		)
			return value;
		throw new TypeError(
			"target.scope must be all, ungrouped, workspace with a non-empty workspaceId, or sessions with non-empty sessionIds",
		);
	},
};
export const unarchivedBatchSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		if (
			!Array.isArray(value.archivedSessionIds) ||
			value.archivedSessionIds.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIds must be a string array");
		if (
			!Array.isArray(value.unarchivedSessionIds) ||
			value.unarchivedSessionIds.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("unarchivedSessionIds must be a string array");
		return value;
	},
};
export const archivedWorkspaceBatchSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		if (
			!Array.isArray(value.archivedSessionIds) ||
			value.archivedSessionIds.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIds must be a string array");
		if (
			!Array.isArray(value.archivedSessionIdsAdded) ||
			value.archivedSessionIdsAdded.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIdsAdded must be a string array");
		return value;
	},
};
export const deletedBatchSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		for (const key of [
			"requestedSessionIds",
			"deletedSessionIds",
			"skippedSessionIds",
		]) {
			if (
				!Array.isArray(value[key]) ||
				value[key].some((id: unknown) => typeof id !== "string")
			)
				throw new TypeError(`${key} must be a string array`);
		}
		if (
			!Array.isArray(value.failures) ||
			value.failures.some(
				(failure: HostResultRecord) =>
					typeof failure !== "object" ||
					failure === null ||
					typeof failure.sessionId !== "string" ||
					typeof failure.message !== "string",
			)
		)
			throw new TypeError("failures must contain sessionId/message objects");
		return value;
	},
};
export const archivedSessionMetadataSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!Array.isArray(value.items)
		)
			throw new TypeError("result.items must be an array");
		if (
			value.items.some(
				(item: HostResultRecord) =>
					typeof item !== "object" ||
					item === null ||
					typeof item.sessionId !== "string" ||
					typeof item.createdAt !== "number" ||
					!Number.isFinite(item.createdAt),
			)
		)
			throw new TypeError("items must contain sessionId/createdAt objects");
		if (
			value.repairedSessionIds !== void 0 &&
			(!Array.isArray(value.repairedSessionIds) ||
				value.repairedSessionIds.some((id: unknown) => typeof id !== "string"))
		)
			throw new TypeError("repairedSessionIds must be a string array");
		return value;
	},
};