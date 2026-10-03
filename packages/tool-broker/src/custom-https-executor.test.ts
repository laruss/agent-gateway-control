import type { CustomHttpsDefinition } from "@agent-gateway/contracts";
import { CUSTOM_DEFINITION_VERSION_PARAM } from "@agent-gateway/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type CustomHttpsExecutorDeps,
	type CustomToolDefinitionLookup,
	executeCustomHttpsAction,
	parsedDefinitionLookup,
	type SecretResolver,
} from "./custom-https-executor.ts";
import { type EgressRequest, sendPinnedRequest } from "./egress.ts";
import {
	generateTestTls,
	type RunningTestServer,
	startTestHttpsServer,
	TEST_CUSTOM_TOOL_HOST,
	type TestTls,
} from "./testing-tls.ts";

function definition(overrides: Partial<CustomHttpsDefinition> = {}): CustomHttpsDefinition {
	return {
		host: TEST_CUSTOM_TOOL_HOST,
		pathTemplate: "/tickets/{id}",
		method: "POST",
		parameters: [
			{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			{
				name: "title",
				slot: "body",
				slotName: "title",
				type: "string",
				minLength: 1,
				maxLength: 200,
			},
		],
		secretSlots: [{ alias: "ticket_api_key", slot: "header", slotName: "x-api-key" }],
		idempotency: { headerName: "idempotency-key" },
		responseLimits: {
			maxResponseBytes: 65_536,
			allowedContentTypes: ["application/json"],
			timeoutMs: 2000,
			includeBodyPreview: true,
		},
		...overrides,
	};
}

const SECRET_VALUE = "super-secret-token";

describe("executeCustomHttpsAction", () => {
	let tls: TestTls;
	let server: RunningTestServer | null = null;

	beforeAll(() => {
		tls = generateTestTls();
	});

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	const secrets: SecretResolver = async (alias) => {
		if (alias !== "ticket_api_key") {
			throw new Error(`no secret for alias '${alias}'`);
		}
		return SECRET_VALUE;
	};

	/**
	 * Sends straight to the running test server's own loopback address, through `sendPinnedRequest`
	 * — never `sendEgressRequest`'s guard, which exists precisely to refuse a loopback address like
	 * this one. This executor's own tests exercise request building, secret substitution and
	 * response handling; the guard that decides whether an address may be connected to at all is
	 * `egress.test.ts`'s job, exercised there against fake resolvers with no server at all.
	 */
	function deps(lookup: CustomToolDefinitionLookup): CustomHttpsExecutorDeps {
		const running = server;
		if (running === null) {
			throw new Error("start the test server before building deps");
		}
		return {
			lookup,
			secrets,
			send: (request: EgressRequest) =>
				sendPinnedRequest(
					{ address: "127.0.0.1", family: 4 },
					{ ...request, port: running.port, ca: [tls.caCert] },
				),
		};
	}

	it("resolves the definition by (entry id, version), fills the secret header, and never leaks it", async () => {
		let seenApiKey: string | undefined;
		let seenIdempotency: string | undefined;
		let seenBody: string | undefined;
		server = await startTestHttpsServer(tls, (req, res) => {
			seenApiKey = req.headers["x-api-key"] as string | undefined;
			seenIdempotency = req.headers["idempotency-key"] as string | undefined;
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				seenBody = raw;
				res.writeHead(201, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "t-1", secret_echo: seenApiKey }));
			});
		});
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 3 ? definition() : null;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: "title", value: "Printer is on fire" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "3" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-1:hash", signal: new AbortController().signal },
		);
		expect(result.kind).toBe("succeeded");
		expect(seenApiKey).toBe(SECRET_VALUE);
		expect(seenIdempotency).toBe("tool-action:approval-1:hash");
		expect(seenBody).toBe(JSON.stringify({ title: "Printer is on fire" }));
		// The secret must never surface in the receipt, however the destination echoes it back.
		expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
	});

	it("refuses when the action's entry id has no matching definition (cross-entry/cross-namespace denial)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => res.end("unreachable"));
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.a-different-entry",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: "title", value: "x" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-2:hash", signal: new AbortController().signal },
		);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("refuses when the pinned version no longer matches any definition (edited since the approval)", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => res.end("unreachable"));
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: "title", value: "x" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "2" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-3:hash", signal: new AbortController().signal },
		);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("sends a GET with no body and the secret in a query parameter, not the path", async () => {
		let seenUrl: string | undefined;
		server = await startTestHttpsServer(tls, (req, res) => {
			seenUrl = req.url;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		const getDefinition = definition({
			method: "GET",
			pathTemplate: "/tickets/{id}",
			parameters: [
				{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			],
			secretSlots: [{ alias: "ticket_api_key", slot: "query", slotName: "api_key" }],
			idempotency: null,
		});
		const lookup: CustomToolDefinitionLookup = async () => getDefinition;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "../../etc/passwd" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-4:hash", signal: new AbortController().signal },
		);
		expect(result.kind).toBe("succeeded");
		// The path parameter is percent-encoded into exactly one segment: it can never add path
		// segments of its own, whatever characters it contains.
		expect(seenUrl).toContain("/tickets/..%2F..%2Fetc%2Fpasswd");
		expect(seenUrl).not.toContain("/etc/passwd");
		expect(seenUrl).toContain(`api_key=${SECRET_VALUE}`);
	});

	it("a missing secret file is a clean 'failed', never 'unknown': nothing was ever sent", async () => {
		let sent = false;
		server = await startTestHttpsServer(tls, (_req, res) => {
			sent = true;
			res.end("unreachable");
		});
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		const missingSecret: CustomHttpsExecutorDeps = {
			...deps(lookup),
			secrets: async (alias) => {
				throw new Error(`no secret file for alias '${alias}'`);
			},
		};
		// Would previously reject (the throw from `SecretResolver` propagating out of this function
		// uncaught) rather than resolve to a `failed` result — `processToolJob` then records that as
		// `unknown` (manual settlement) even though the request was never built, let alone sent.
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: "title", value: "x" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
				],
			},
			missingSecret,
			{ idempotencyKey: "tool-action:approval-5:hash", signal: new AbortController().signal },
		);
		expect(result.kind).toBe("failed");
		expect(sent).toBe(false);
	});

	it("a GET answered with a redirect is a clean 'failed': redirects are never followed and nothing but a read was at stake", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(302, { location: "https://elsewhere.example/ticket" });
			res.end();
		});
		const getDefinition = definition({
			method: "GET",
			pathTemplate: "/tickets/{id}",
			parameters: [
				{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			],
			secretSlots: [],
			idempotency: null,
		});
		const lookup: CustomToolDefinitionLookup = async () => getDefinition;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-6:hash", signal: new AbortController().signal },
		);
		expect(result).toEqual({
			kind: "failed",
			error: "the destination answered 302 (a redirect); redirects are not followed",
		});
	});

	it("a write answered with a server error (500) is 'unknown', not 'failed': it may already have acted on it", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "internal" }));
		});
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		await expect(
			executeCustomHttpsAction(
				{
					actionType: "custom.zendesk",
					actionParams: [
						{ name: "id", value: "123" },
						{ name: "title", value: "Printer is on fire" },
						{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
					],
				},
				deps(lookup),
				{ idempotencyKey: "tool-action:approval-8:hash", signal: new AbortController().signal },
			),
		).rejects.toThrow(/answered 500 after the write was sent.*unknown/);
	});

	it("a write answered with 408 (request timeout) is also 'unknown', like a 5xx", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(408, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "timeout" }));
		});
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		await expect(
			executeCustomHttpsAction(
				{
					actionType: "custom.zendesk",
					actionParams: [
						{ name: "id", value: "123" },
						{ name: "title", value: "Printer is on fire" },
						{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
					],
				},
				deps(lookup),
				{ idempotencyKey: "tool-action:approval-9:hash", signal: new AbortController().signal },
			),
		).rejects.toThrow(/answered 408 after the write was sent.*unknown/);
	});

	it("a write answered with a definitive 4xx (400) stays 'failed': the destination rejected it outright", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "bad request" }));
		});
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: "title", value: "Printer is on fire" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-10:hash", signal: new AbortController().signal },
		);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("a GET answered with a 500 stays 'failed': reads are never ambiguous", async () => {
		server = await startTestHttpsServer(tls, (_req, res) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "internal" }));
		});
		const getDefinition = definition({
			method: "GET",
			pathTemplate: "/tickets/{id}",
			parameters: [
				{ name: "id", slot: "path", slotName: "id", type: "string", minLength: 1, maxLength: 50 },
			],
			secretSlots: [],
			idempotency: null,
		});
		const lookup: CustomToolDefinitionLookup = async () => getDefinition;
		const result = await executeCustomHttpsAction(
			{
				actionType: "custom.zendesk",
				actionParams: [
					{ name: "id", value: "123" },
					{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
				],
			},
			deps(lookup),
			{ idempotencyKey: "tool-action:approval-11:hash", signal: new AbortController().signal },
		);
		expect(result).toMatchObject({ kind: "failed" });
	});

	it("a write answered with a redirect after it was fully sent is 'unknown': the destination may already have acted on it", async () => {
		server = await startTestHttpsServer(tls, (req, res) => {
			req.on("data", () => undefined);
			req.on("end", () => {
				// The classic post-redirect-get shape: a write the destination actually processed,
				// pointing at a result it will never actually be followed to.
				res.writeHead(303, { location: "https://elsewhere.example/ticket/t-1" });
				res.end();
			});
		});
		const lookup: CustomToolDefinitionLookup = async (entryId, version) =>
			entryId === "zendesk" && version === 1 ? definition() : null;
		await expect(
			executeCustomHttpsAction(
				{
					actionType: "custom.zendesk",
					actionParams: [
						{ name: "id", value: "123" },
						{ name: "title", value: "Printer is on fire" },
						{ name: CUSTOM_DEFINITION_VERSION_PARAM, value: "1" },
					],
				},
				deps(lookup),
				{ idempotencyKey: "tool-action:approval-7:hash", signal: new AbortController().signal },
			),
		).rejects.toThrow(/303.*redirect.*redirects are not followed/s);
	});
});

describe("parsedDefinitionLookup", () => {
	it("fills a field a definition stored before it existed lacks, instead of reading it as off", async () => {
		const { includeBodyPreview: _omitted, ...storedLimits } = definition().responseLimits;
		const stored = { ...definition(), responseLimits: storedLimits };
		const lookup = parsedDefinitionLookup(async () => stored);
		const parsed = await lookup("zendesk", 1);
		expect(parsed?.responseLimits.includeBodyPreview).toBe(true);
	});

	it("passes through a definition that does not exist", async () => {
		const lookup = parsedDefinitionLookup(async () => null);
		expect(await lookup("zendesk", 1)).toBeNull();
	});
});
