import { describe, expect, it } from "vitest";
import { assertConsoleOrigin } from "./console-auth.ts";

// ---------------------------------------------------------------------------
// `CONSOLE_ORIGIN` validation at startup (ADR-025): the session cookie is `__Host-`/`Secure`, so
// an `http:` origin pointed at a real host would carry it over plaintext; only a loopback host
// (console:dev's own Vite dev server) is exempt.
// ---------------------------------------------------------------------------

describe("assertConsoleOrigin", () => {
	it("accepts a plain https origin", () => {
		expect(assertConsoleOrigin("https://gateway.local")).toBe("https://gateway.local");
	});

	it("accepts http on localhost, with or without a port", () => {
		expect(assertConsoleOrigin("http://localhost")).toBe("http://localhost");
		expect(assertConsoleOrigin("http://localhost:5173")).toBe("http://localhost:5173");
	});

	it("accepts http on 127.0.0.1, with or without a port", () => {
		expect(assertConsoleOrigin("http://127.0.0.1")).toBe("http://127.0.0.1");
		expect(assertConsoleOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
	});

	it("rejects http on any other host", () => {
		expect(() => assertConsoleOrigin("http://gateway.local")).toThrow(/must use 'https:'/);
	});

	it("rejects a host that merely contains the loopback name as a substring", () => {
		expect(() => assertConsoleOrigin("http://localhost.attacker.example")).toThrow(
			/must use 'https:'/,
		);
		expect(() => assertConsoleOrigin("http://127.0.0.1.attacker.example")).toThrow(
			/must use 'https:'/,
		);
	});

	it("rejects a value with no scheme, a path, or a trailing slash", () => {
		expect(() => assertConsoleOrigin("gateway.local")).toThrow(/must be an origin/);
		expect(() => assertConsoleOrigin("https://gateway.local/")).toThrow(/must be an origin/);
		expect(() => assertConsoleOrigin("https://gateway.local/path")).toThrow(/must be an origin/);
	});

	it("rejects a scheme other than http/https", () => {
		expect(() => assertConsoleOrigin("ftp://gateway.local")).toThrow(/must be an origin/);
	});
});
