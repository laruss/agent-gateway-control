import { memoryItems } from "@agent-gateway/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { AdminError, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { audit } from "./store.ts";

export const MEMORY_REVIEW_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type MemoryReviewStatus = (typeof MEMORY_REVIEW_STATUSES)[number];

/**
 * Serializes acceptances of one memory key until the transaction ends; the partial unique index
 * allows one accepted item per key.
 */
export async function lockMemoryKey(
	uow: UnitOfWork,
	namespace: string,
	key: string,
): Promise<void> {
	await uow.tx.client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
		`memory:${namespace}:${key}`,
	]);
}

/** Retires the accepted item of a key, so a newly accepted one takes its place. */
export async function supersedeMemory(
	uow: UnitOfWork,
	namespace: string,
	key: string,
): Promise<void> {
	await uow.tx.db
		.update(memoryItems)
		.set({ status: "superseded", supersededAt: uow.now })
		.where(
			and(
				eq(memoryItems.namespace, namespace),
				eq(memoryItems.key, key),
				eq(memoryItems.status, "accepted"),
			),
		);
}

export type MemoryFilter = Readonly<{
	status: MemoryReviewStatus | null;
	namespace: string | null;
	/** Oldest first when reviewing proposals, so none is buried under newer ones. */
	oldestFirst: boolean;
	limit: number;
	offset: number;
}>;

export async function listMemory(deps: ControlPlaneDeps, filter: MemoryFilter) {
	return inTransaction(deps, ({ tx }) =>
		tx.db
			.select({
				id: memoryItems.id,
				namespace: memoryItems.namespace,
				key: memoryItems.key,
				status: memoryItems.status,
				visibility: memoryItems.visibility,
				content: memoryItems.content,
				sourceRunId: memoryItems.sourceRunId,
				createdAt: memoryItems.createdAt,
			})
			.from(memoryItems)
			.where(
				and(
					filter.status === null ? undefined : eq(memoryItems.status, filter.status),
					filter.namespace === null ? undefined : eq(memoryItems.namespace, filter.namespace),
				),
			)
			.orderBy(
				filter.oldestFirst ? asc(memoryItems.createdAt) : desc(memoryItems.createdAt),
				asc(memoryItems.id),
			)
			.limit(filter.limit)
			.offset(filter.offset),
	);
}

/**
 * An operator's decision on a proposed memory item. Accepting supersedes the accepted item of
 * the same key; from the next turn on, every agent reading the namespace sees it.
 */
export async function decideMemory(
	deps: ControlPlaneDeps,
	id: string,
	decision: "accept" | "reject",
	actor: string,
): Promise<void> {
	await inTransaction(deps, async (uow) => {
		const { db } = uow.tx;
		const [item] = await db
			.select({ namespace: memoryItems.namespace, key: memoryItems.key })
			.from(memoryItems)
			.where(and(eq(memoryItems.id, id), eq(memoryItems.status, "proposed")))
			.for("update");
		if (item === undefined) {
			throw new AdminError(`memory item '${id}' does not exist or is not proposed`);
		}
		if (decision === "accept") {
			await lockMemoryKey(uow, item.namespace, item.key);
			await supersedeMemory(uow, item.namespace, item.key);
		}
		await db
			.update(memoryItems)
			.set({ status: decision === "accept" ? "accepted" : "rejected" })
			.where(eq(memoryItems.id, id));
		await audit(uow, actor, `memory.${decision}`, "memory", id, {
			namespace: item.namespace,
			key: item.key,
		});
	});
}
