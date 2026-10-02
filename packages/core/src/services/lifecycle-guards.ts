import type { AgentConfig, AgentId } from "@agent-gateway/contracts";
import { agentLifecycle } from "@agent-gateway/db";
import { inArray } from "drizzle-orm";
import type { UnitOfWork } from "./deps.ts";
import { lifecycleOwnedAgentIds } from "./store.ts";

type Db = UnitOfWork["tx"]["db"];

// ---------------------------------------------------------------------------
// Shared by `admin.ts`'s own `applyConfig` and `management.ts`'s own `commitChangeIn` — the two
// committing paths an agent's configuration can change through (ADR-026). Kept in a module
// neither of them owns, rather than defined in one and imported by the other: Biome refuses the
// import cycle that would need (`management.ts` already imports `writeConfigRevisionIn` from
// `admin.ts`).
// ---------------------------------------------------------------------------

/**
 * Refuses a commit that drops a lifecycle-owned agent out of the active configuration any way but
 * `requestAgentRetire`'s own `remove_agent` (ADR-026): removing one any other way — a plain
 * console edit, a CLI import, a YAML `config apply`, `setAgentEnabled`'s own disable-as-removal
 * fallback — would leave its bot active in Mattermost and its lifecycle row stuck wherever it
 * already was, never `retiring`, since nothing here drives it there; retiring it afterwards then
 * fails ("does not exist", since `requestAgentRetire` only ever looks at the active configuration
 * this very commit just removed it from), and restoring it needs `retired`, which it never reached
 * either. `trustedAgentIds` is `requestAgentRetire`'s own agent id: its lifecycle row has not moved
 * to `retiring` yet at the point this runs (that update happens only after its own commit returns),
 * so it is trusted the same way `rejectUnownedBotSecretPaths` (`management.ts`) trusts a fresh
 * `create`'s — only `agent-lifecycle.ts`'s own internal `commitWithinLock` may pass it, never
 * `commitChange`, the public entry point every other caller uses; `applyConfig` never has a
 * trusted id of its own, so it always calls this with an empty set.
 */
export async function rejectLifecycleOwnedRemovals(
	db: Db,
	before: Readonly<AgentConfig[]>,
	after: Readonly<AgentConfig[]>,
	trustedAgentIds: ReadonlySet<AgentId>,
): Promise<Readonly<string[]>> {
	const afterIds = new Set(after.map((agent) => agent.id));
	const removedIds = before
		.map((agent) => agent.id)
		.filter((id) => !afterIds.has(id) && !trustedAgentIds.has(id));
	if (removedIds.length === 0) {
		return [];
	}
	const owned = await lifecycleOwnedAgentIds(db, removedIds);
	if (owned.size === 0) {
		return [];
	}
	const rows = await db
		.select({ agentId: agentLifecycle.agentId, status: agentLifecycle.status })
		.from(agentLifecycle)
		.where(inArray(agentLifecycle.agentId, [...owned]));
	return rows
		.filter((row) => row.status !== "retiring" && row.status !== "retired")
		.map(
			(row) =>
				`agent ${row.agentId} is lifecycle-owned and still '${row.status}'; removing it from the ` +
				"configuration this way would leave its Mattermost identity active — use " +
				`'gateway agents retire ${row.agentId}' instead`,
		);
}

/**
 * Refuses a commit that adds (or re-adds) an agent id whose lifecycle is `retiring`/`retired` any
 * way but `requestAgentRestore`'s own `add_agent` (ADR-026): a config import or rollback to a
 * revision that still names a retired agent, or any other `add_agent`/`replace_bundle` naming that
 * id, must not revive it in the active configuration outside the lifecycle's own path — doing so
 * leaves it `enabled: true` while its lifecycle row is still `retiring`/`retired` (the scheduler
 * refuses to run it either way, `requireAgentLifecycleReady`, but the owner's actual
 * `requestAgentRestore` call then fails with "already exists", since `add_agent`'s own check
 * refuses a configuration that already lists the id — restoring it the sanctioned way becomes
 * impossible until the bad commit is undone). `trustedAgentIds` is `requestAgentRestore`'s own
 * agent id, trusted the same way `rejectUnownedBotSecretPaths` trusts a fresh `create`'s: its
 * lifecycle row still reads `retired` at the point this runs (the restore's own update to `pending`
 * happens only after its commit returns), so without this it would refuse its own request;
 * `applyConfig` never has a trusted id of its own, so it always calls this with an empty set.
 */
export async function rejectRetiredAgentReadditions(
	db: Db,
	before: Readonly<AgentConfig[]>,
	after: Readonly<AgentConfig[]>,
	trustedAgentIds: ReadonlySet<AgentId>,
): Promise<Readonly<string[]>> {
	const beforeIds = new Set(before.map((agent) => agent.id));
	const addedIds = after
		.map((agent) => agent.id)
		.filter((id) => !beforeIds.has(id) && !trustedAgentIds.has(id));
	if (addedIds.length === 0) {
		return [];
	}
	const rows = await db
		.select({ agentId: agentLifecycle.agentId, status: agentLifecycle.status })
		.from(agentLifecycle)
		.where(inArray(agentLifecycle.agentId, addedIds));
	return rows
		.filter((row) => row.status === "retiring" || row.status === "retired")
		.map(
			(row) =>
				`agent ${row.agentId} is lifecycle-owned and '${row.status}'; adding it to the ` +
				"configuration this way would leave it enabled but never provisioned — use " +
				`'gateway agents restore ${row.agentId}' instead`,
		);
}

/**
 * Refuses a commit that changes a lifecycle-owned agent's `mattermost.token_secret_file` to a
 * different value (ADR-026): the field is server-generated for such an agent (first by its own
 * `create`, under `/run/bot-secrets/`) and never a path a client chooses — a console edit or CLI
 * import redirecting it would leave Mattermost delivery reading a file the provisioner never wrote
 * to, or racing one it is still mid-way through issuing a token for. Scoped to an agent id present
 * in both `before` and `after` (an actual edit of an already-active agent); an id `requestAgentCreate`
 * or `requestAgentRestore` itself is adding has no prior value to compare against here at all, and is
 * refused instead by `rejectUnownedBotSecretPaths`/`rejectRetiredAgentReadditions`, never this.
 * `trustedAgentIds` is `requestAgentRestore`'s own agent id even so, the same escape hatch the two
 * guards above already carry for it: its own commit migrates this very field to
 * `defaultBotSecretFile` as part of the same `add_agent` change set the restore commits — never an
 * `update_agent` for an id already present in `before` under today's code, so this trust is never
 * actually exercised, but kept so a restore can never end up refusing its own trusted migration
 * merely because of how its change set happens to be shaped; `applyConfig` never has a trusted id
 * of its own, so it always calls this with an empty set.
 */
export async function rejectLifecycleOwnedTokenPathChanges(
	db: Db,
	before: Readonly<AgentConfig[]>,
	after: Readonly<AgentConfig[]>,
	trustedAgentIds: ReadonlySet<AgentId>,
): Promise<Readonly<string[]>> {
	const beforeById = new Map(before.map((agent) => [agent.id, agent]));
	const changed = after.filter((agent) => {
		const prior = beforeById.get(agent.id);
		return (
			prior !== undefined &&
			!trustedAgentIds.has(agent.id) &&
			prior.mattermost.token_secret_file !== agent.mattermost.token_secret_file
		);
	});
	if (changed.length === 0) {
		return [];
	}
	const owned = await lifecycleOwnedAgentIds(
		db,
		changed.map((agent) => agent.id),
	);
	return changed
		.filter((agent) => owned.has(agent.id))
		.map(
			(agent) =>
				`agent ${agent.id}: token_secret_file is server-generated for a lifecycle-owned agent ` +
				"and cannot be changed directly",
		);
}
