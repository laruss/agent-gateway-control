import { describe, expect, it } from "vitest";
import { startHealthServer } from "./health.ts";

describe("health server", () => {
	it("redacts and bounds check details, including a failing readiness", async () => {
		const server = startHealthServer({
			port: 0,
			readiness: async () => [
				{
					name: "postgres",
					ok: false,
					detail: `connect postgres://gateway:hunter2secret@db:5432/gateway failed for ops@example.org ${"x".repeat(2000)}`,
				},
			],
			metrics: async () => "gateway_test 1\n",
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const response = await fetch(`${base}/health/dependencies`);
			expect(response.status).toBe(503);
			const text = await response.text();
			expect(text).not.toContain("hunter2secret");
			expect(text).not.toContain("ops@example.org");
			expect(text).toContain("postgres://[redacted]@db:5432");
			const body: { checks: { detail: string }[] } = JSON.parse(text);
			expect(body.checks[0]?.detail.length).toBeLessThanOrEqual(500);
			expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({ status: "not_ready" });
			expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: "live" });
			expect(await (await fetch(`${base}/metrics`)).text()).toBe("gateway_test 1\n");
		} finally {
			await server.stop();
		}
	});

	it("redacts a readiness that throws", async () => {
		const server = startHealthServer({
			port: 0,
			readiness: async () => {
				throw new Error("Authorization: Bearer abcdefghijklmnop1234");
			},
		});
		try {
			const text = await (
				await fetch(`http://127.0.0.1:${server.port}/health/dependencies`)
			).text();
			expect(text).not.toContain("abcdefghijklmnop1234");
		} finally {
			await server.stop();
		}
	});
});
