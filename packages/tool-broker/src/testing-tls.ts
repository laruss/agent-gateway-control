import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A local HTTPS test server and a throwaway CA, for exercising a custom HTTPS tool's egress
 * (`egress.ts`) without any external network: the server's own certificate names this exact host,
 * which a test's egress call sets as its SNI/`Host` (`EgressRequest.host`) while an injected
 * resolver points it at the server's actual loopback address.
 */
export const TEST_CUSTOM_TOOL_HOST = "custom-tool.test";

export type TestTls = Readonly<{ caCert: string; serverCert: string; serverKey: string }>;

export type TestCa = Readonly<{ certPem: string; keyPem: string }>;

function opensslRun(dir: string, args: Readonly<string[]>): void {
	execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * Generates a throwaway CA with the system `openssl` binary: no committed key material, nothing
 * reused between test runs. Separate from {@link generateServerCert} so a test can issue more than
 * one server certificate from the *same* CA — a hostname/certificate mismatch (the server's own
 * cert is genuinely CA-signed and trusted, just not for the name the client connects as) needs
 * exactly that, which a fresh CA per certificate (`generateTestTls` alone) cannot express.
 */
export function generateTestCa(): TestCa {
	const dir = mkdtempSync(join(tmpdir(), "agw-custom-tool-tls-ca-"));
	try {
		const caKey = join(dir, "ca-key.pem");
		const caCert = join(dir, "ca-cert.pem");
		opensslRun(dir, ["genrsa", "-out", caKey, "2048"]);
		opensslRun(dir, [
			"req",
			"-x509",
			"-new",
			"-key",
			caKey,
			"-days",
			"2",
			"-out",
			caCert,
			"-subj",
			"/CN=agent-gateway test CA",
		]);
		return { certPem: readFileSync(caCert, "utf8"), keyPem: readFileSync(caKey, "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A server certificate for `hostname`, signed by `ca`. */
export function generateServerCert(
	ca: TestCa,
	hostname: string,
): Pick<TestTls, "serverCert" | "serverKey"> {
	const dir = mkdtempSync(join(tmpdir(), "agw-custom-tool-tls-server-"));
	try {
		const caKey = join(dir, "ca-key.pem");
		const caCert = join(dir, "ca-cert.pem");
		writeFileSync(caKey, ca.keyPem);
		writeFileSync(caCert, ca.certPem);
		const serverKey = join(dir, "server-key.pem");
		const serverCsr = join(dir, "server.csr");
		const serverCert = join(dir, "server-cert.pem");
		const extFile = join(dir, "server-ext.cnf");
		opensslRun(dir, ["genrsa", "-out", serverKey, "2048"]);
		opensslRun(dir, [
			"req",
			"-new",
			"-key",
			serverKey,
			"-out",
			serverCsr,
			"-subj",
			`/CN=${hostname}`,
		]);
		writeFileSync(extFile, `subjectAltName=DNS:${hostname}\n`);
		opensslRun(dir, [
			"x509",
			"-req",
			"-in",
			serverCsr,
			"-CA",
			caCert,
			"-CAkey",
			caKey,
			"-CAcreateserial",
			"-out",
			serverCert,
			"-days",
			"2",
			"-extfile",
			extFile,
		]);
		return {
			serverCert: readFileSync(serverCert, "utf8"),
			serverKey: readFileSync(serverKey, "utf8"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Generates a CA and a server certificate for `hostname` in one call — the common case, a single
 * server identity nothing else needs to be signed by the same CA. No committed key material,
 * nothing reused between test runs. Throws with `openssl`'s own stderr if it is not on `PATH`
 * (every CI image and dev machine this project targets has it).
 */
export function generateTestTls(hostname: string = TEST_CUSTOM_TOOL_HOST): TestTls {
	const ca = generateTestCa();
	const server = generateServerCert(ca, hostname);
	return { caCert: ca.certPem, ...server };
}

export type TestHttpsHandler = (req: IncomingMessage, res: ServerResponse) => void;

export type RunningTestServer = Readonly<{
	port: number;
	requests: () => number;
	close: () => Promise<void>;
}>;

/** Starts an HTTPS server on loopback with an ephemeral port, using `tls`'s server certificate. */
export function startTestHttpsServer(
	tls: Pick<TestTls, "serverCert" | "serverKey">,
	handler: TestHttpsHandler,
): Promise<RunningTestServer> {
	let requests = 0;
	return new Promise((resolve, reject) => {
		const server = https.createServer({ cert: tls.serverCert, key: tls.serverKey }, (req, res) => {
			requests += 1;
			handler(req, res);
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("test server has no port"));
				return;
			}
			resolve({
				port: address.port,
				requests: () => requests,
				close: () => new Promise((res) => server.close(() => res())),
			});
		});
	});
}
