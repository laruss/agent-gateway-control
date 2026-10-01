import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@agent-gateway/logging";
import { hashConsolePassword, writeSecretFile } from "@agent-gateway/service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConsolePasswordHash, startConsoleServer } from "./console-server.ts";
import { collectConsoleStatus, createConsoleStatusCache } from "./console-status.ts";
import { startTestGateway, type TestGateway } from "./test-gateway.ts";

const PASSWORD = "integration test console password";

function basicAuthHeader(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("the owner's console, wired against a real gateway (ADR-023)", () => {
	let gateway: TestGateway;
	let secretsDir: string;

	beforeAll(async () => {
		gateway = await startTestGateway();
		secretsDir = mkdtempSync(join(tmpdir(), "console-integration-"));
		writeSecretFile(join(secretsDir, "console_password_hash"), await hashConsolePassword(PASSWORD));
	});

	afterAll(async () => {
		await gateway?.stop();
		rmSync(secretsDir, { recursive: true, force: true });
	});

	it("fails closed when the hash secret is missing, before anything is served", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "console-integration-empty-"));
		try {
			expect(() => resolveConsolePasswordHash(emptyDir)).toThrow();
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});

	it("serves the real, authenticated cached projection over HTTP", async () => {
		const passwordHash = resolveConsolePasswordHash(secretsDir);
		const cache = createConsoleStatusCache((now) => collectConsoleStatus(gateway.pool, now));
		const server = startConsoleServer({
			port: 0,
			hostname: "127.0.0.1",
			passwordHash,
			cache,
			log: silentLogger,
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const auth = { authorization: basicAuthHeader("owner", PASSWORD) };

			const unauthenticated = await fetch(`${base}/`);
			expect(unauthenticated.status).toBe(401);

			const page = await fetch(`${base}/`, { headers: auth });
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain("Agent Gateway Console");
			// One of the example agents, seeded by `startTestGateway`, shows up on the real page.
			expect(html).toContain("director");

			const api = await fetch(`${base}/api/status`, { headers: auth });
			expect(api.status).toBe(200);
			const body = (await api.json()) as {
				state: string;
				status?: { agents: Array<{ status: { agentId: string } }> };
			};
			expect(body.state).toBe("ok");
			expect(body.status?.agents.some((a) => a.status.agentId === "director")).toBe(true);
		} finally {
			await server.stop();
		}
	});

	it("stops accepting connections once stopped", async () => {
		const passwordHash = resolveConsolePasswordHash(secretsDir);
		const cache = createConsoleStatusCache((now) => collectConsoleStatus(gateway.pool, now));
		const server = startConsoleServer({
			port: 0,
			hostname: "127.0.0.1",
			passwordHash,
			cache,
			log: silentLogger,
		});
		const base = `http://127.0.0.1:${server.port}`;
		await server.stop();
		await expect(fetch(`${base}/`)).rejects.toThrow();
	});
});
