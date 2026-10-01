import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectConsoleStatus } from "./console-status.ts";
import { startTestGateway, type TestGateway } from "./test-gateway.ts";

describe("collectConsoleStatus against a real database (ADR-023)", () => {
	let gateway: TestGateway;

	beforeAll(async () => {
		gateway = await startTestGateway();
	});

	afterAll(async () => {
		await gateway?.stop();
	});

	it("collects the console projection, including the per-agent budget from the active configuration", async () => {
		const status = await collectConsoleStatus(gateway.pool, new Date());
		expect(status.agents.length).toBeGreaterThan(0);
		// `config/examples/organization.yaml` sets this budget; every agent gets the same one.
		for (const agent of status.agents) {
			expect(agent.budget).toEqual({ cost_usd: 5, tokens: 5_000_000 });
		}
	});

	it("fails instead of hanging when a statement is blocked past its own timeout, and leaves no client behind", async () => {
		// An ACCESS EXCLUSIVE lock on `agents`, held open on a separate connection, blocks the
		// collection's own read of that table until its 2 s statement timeout cancels it.
		const locker = await gateway.pool.connect();
		await locker.query("begin");
		await locker.query("lock table agents in access exclusive mode");
		try {
			await expect(collectConsoleStatus(gateway.pool, new Date())).rejects.toThrow();
		} finally {
			await locker.query("rollback");
			locker.release();
		}
		// The pool is still healthy afterward: a client was never leaked stuck mid-transaction.
		const status = await collectConsoleStatus(gateway.pool, new Date());
		expect(status.agents.length).toBeGreaterThan(0);
	}, 20_000);
});
