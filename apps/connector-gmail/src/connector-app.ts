import {
	createGmailClient,
	createPubsubClient,
	createTokenSource,
	type GmailConnectorStatus,
	type GmailStore,
	type GoogleEndpoints,
	type OAuthClientCredentials,
	type RunningGmailConnector,
	startGmailConnector,
} from "@agent-gateway/connector-gmail";
import type { GmailMailboxId } from "@agent-gateway/contracts";
import {
	type ControlPlaneDeps,
	commitGmailDelta,
	loadGmailMailbox,
	raiseConnectorAlert,
	recordGmailNotification,
	recordGmailWatch,
	startGmailMailbox,
} from "@agent-gateway/core";
import { createPool, pendingMigrationCount } from "@agent-gateway/db";
import { errorFields, type Logger } from "@agent-gateway/logging";
import { createBoss, transactionalJobSink } from "@agent-gateway/queue";
import type { HealthCheck } from "@agent-gateway/service";

export type GmailConnectorAppOptions = Readonly<{
	connectionString: string;
	mailboxId: GmailMailboxId;
	topicName: string;
	subscription: string;
	client: OAuthClientCredentials;
	/** Read once at start; see `TokenSourceOptions.refreshToken`. */
	refreshToken: string;
	endpoints: GoogleEndpoints;
	log: Logger;
	clock?: () => Date;
	reconcileMs?: number;
	retryMinMs?: number;
	retryMaxMs?: number;
}>;

export type RunningGmailConnectorApp = Readonly<{
	deps: ControlPlaneDeps;
	connector: RunningGmailConnector;
	readiness: () => Promise<Readonly<HealthCheck[]>>;
	stop: () => Promise<void>;
}>;

/** The control plane behind one mailbox, over `core`. */
export function gmailStore(deps: ControlPlaneDeps, mailboxId: GmailMailboxId): GmailStore {
	return {
		state: async () => {
			const row = await loadGmailMailbox(deps, mailboxId);
			return {
				historyId: row?.historyId ?? null,
				accountHash: row?.accountHash ?? null,
				watchExpiresAt: row?.watchExpiresAt ?? null,
				watchRenewedAt: row?.watchRenewedAt ?? null,
				lastSyncAt: row?.lastSyncAt ?? null,
				startedAt: row?.createdAt ?? null,
			};
		},
		start: (historyId, account) => startGmailMailbox(deps, mailboxId, historyId, account),
		commit: (delta) => commitGmailDelta(deps, mailboxId, delta),
		recordNotification: (event) => recordGmailNotification(deps, mailboxId, event),
		recordWatch: (historyId, expiresAt, account) =>
			recordGmailWatch(deps, mailboxId, historyId, expiresAt, account),
		alert: (key, message) => raiseConnectorAlert(deps, key, message),
	};
}

/** The checks behind `/health/ready`; the connector's own come from its status. */
export function connectorChecks(
	status: GmailConnectorStatus,
	now: Date,
	reconcileMs: number,
): HealthCheck[] {
	const syncFresh =
		status.lastSyncAt !== null && now.getTime() - status.lastSyncAt.getTime() <= 3 * reconcileMs;
	return [
		{
			name: "gmail_auth",
			ok: status.authorized,
			detail: status.authorized
				? "authorized"
				: "credential refused; run 'gateway gmail authorize'",
		},
		{ name: "pubsub", ok: status.pulling, detail: status.pulling ? "pulling" : "not pulling" },
		{
			name: "gmail_watch",
			ok: status.watchExpiresAt !== null && status.watchExpiresAt > now,
			detail:
				status.watchExpiresAt === null
					? "no watch"
					: `expires ${status.watchExpiresAt.toISOString()}`,
		},
		{
			name: "gmail_sync",
			ok: syncFresh,
			detail:
				status.lastSyncAt === null ? "not synced yet" : `last ${status.lastSyncAt.toISOString()}`,
		},
	];
}

/**
 * The Gmail connector process: its own database pool and a pg-boss client (it only sends run
 * jobs, inside the ingest transactions), and the connector of one mailbox. It holds the Google
 * credential; the controller and the workers never see it.
 */
export async function startGmailConnectorApp(
	options: GmailConnectorAppOptions,
): Promise<RunningGmailConnectorApp> {
	const { log } = options;
	const pool = createPool(options.connectionString, 4);
	const pending = await pendingMigrationCount(pool);
	if (pending > 0) {
		await pool.end();
		throw new Error(`${pending} database migration(s) pending; run 'gateway db migrate' first`);
	}
	const boss = createBoss(options.connectionString, "client");
	boss.on("error", (error) => log.error("pg-boss error", errorFields(error)));
	await boss.start();
	const clock = options.clock ?? (() => new Date());
	const deps: ControlPlaneDeps = {
		pool,
		jobs: (tx) => transactionalJobSink(boss, tx.client),
		clock,
		random: Math.random,
		log,
	};
	const tokens = createTokenSource({
		client: options.client,
		refreshToken: options.refreshToken,
		endpoints: options.endpoints,
		clock,
	});
	const reconcileMs = options.reconcileMs ?? 5 * 60_000;
	// Cuts off Gmail calls in flight at shutdown, so a long sync does not hold the stop.
	const halt = new AbortController();
	const connector = startGmailConnector({
		mailboxId: options.mailboxId,
		topicName: options.topicName,
		gmail: createGmailClient(options.endpoints, tokens, halt.signal),
		pubsub: createPubsubClient(options.endpoints.pubsub, options.subscription, tokens),
		store: gmailStore(deps, options.mailboxId),
		log: log.child({ component: "gmail-connector" }),
		clock,
		reconcileMs,
		...(options.retryMinMs === undefined ? {} : { retryMinMs: options.retryMinMs }),
		...(options.retryMaxMs === undefined ? {} : { retryMaxMs: options.retryMaxMs }),
	});
	const readiness = async (): Promise<Readonly<HealthCheck[]>> => {
		const checks: HealthCheck[] = [];
		try {
			await pool.query("select 1");
			checks.push({ name: "postgres", ok: true, detail: "reachable" });
		} catch (error) {
			checks.push({
				name: "postgres",
				ok: false,
				detail: error instanceof Error ? error.message : "failed",
			});
		}
		return [...checks, ...connectorChecks(connector.status(), clock(), reconcileMs)];
	};
	return {
		deps,
		connector,
		readiness,
		stop: async () => {
			const stopped = connector.stop();
			halt.abort();
			await stopped;
			await boss.stop({ graceful: true, timeout: 10_000 });
			await pool.end();
		},
	};
}
