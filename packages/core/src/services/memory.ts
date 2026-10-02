import { agentLifecycle, agents, memoryItems } from "@agent-gateway/db";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { AdminError, inTransaction } from "./admin.ts";
import type { ControlPlaneDeps, UnitOfWork } from "./deps.ts";
import { audit } from "./store.ts";

export const MEMORY_REVIEW_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type MemoryReviewStatus = (typeof MEMORY_REVIEW_STATUSES)[number];

type Db = UnitOfWork["tx"]["db"];

/**
 * Every retiring or already-retired agent's own private namespace (`agents.config` keeps its last
 * configuration even once disabled, ADR-024): such an agent can never run again from the moment
 * retirement is requested, so its private memory can never be loaded into a turn from then on, but
 * it is also kept out of this listing surface explicitly, rather than relying only on nothing ever
 * reading it — the same "excluded from any listing/console read" ADR-026 asks for. Left to the
 * existing retention to expire on its own schedule; shared memory the agent wrote and that was
 * accepted is organization-owned and stays.
 */
async function retiredPrivateNamespaces(db: Db): Promise<ReadonlySet<string>> {
	const rows = await db
		.select({ config: agents.config })
		.from(agents)
		.innerJoin(agentLifecycle, eq(agentLifecycle.agentId, agents.id))
		.where(inArray(agentLifecycle.status, ["retiring", "retired"]));
	return new Set(rows.map((row) => row.config.memory.private_namespace));
}

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
	return inTransaction(deps, async ({ tx }) => {
		const excluded = [...(await retiredPrivateNamespaces(tx.db))];
		return tx.db
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
					excluded.length === 0 ? undefined : notInArray(memoryItems.namespace, excluded),
				),
			)
			.orderBy(
				filter.oldestFirst ? asc(memoryItems.createdAt) : desc(memoryItems.createdAt),
				asc(memoryItems.id),
			)
			.limit(filter.limit)
			.offset(filter.offset);
	});
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
