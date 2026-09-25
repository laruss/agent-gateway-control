export type HealthCheck = Readonly<{ name: string; ok: boolean; detail: string }>;

export type HealthServerOptions = Readonly<{
	port: number;
	/** Loopback by default: health and metrics are for the host, not the network. */
	hostname?: string;
	/** Dependencies that must be healthy for the service to take work. */
	readiness: () => Promise<Readonly<HealthCheck[]>>;
	/** Prometheus text exposition. */
	metrics?: () => Promise<string>;
}>;

export type HealthServer = Readonly<{ port: number; stop: () => Promise<void> }>;

async function safeChecks(
	readiness: HealthServerOptions["readiness"],
): Promise<Readonly<HealthCheck[]>> {
	try {
		return await readiness();
	} catch (error) {
		return [
			{ name: "readiness", ok: false, detail: error instanceof Error ? error.message : "failed" },
		];
	}
}

/** `/health/live`, `/health/ready`, `/health/dependencies` and `/metrics`. */
export function startHealthServer(options: HealthServerOptions): HealthServer {
	const server = Bun.serve({
		port: options.port,
		hostname: options.hostname ?? "127.0.0.1",
		fetch: async (request) => {
			const { pathname } = new URL(request.url);
			switch (pathname) {
				case "/health/live":
					return Response.json({ status: "live" });
				case "/health/ready":
				case "/health/dependencies": {
					const checks = await safeChecks(options.readiness);
					const ok = checks.every((check) => check.ok);
					const body =
						pathname === "/health/ready" ? { status: ok ? "ready" : "not_ready" } : { checks };
					return Response.json(body, { status: ok ? 200 : 503 });
				}
				case "/metrics":
					return new Response(options.metrics === undefined ? "" : await options.metrics(), {
						headers: { "content-type": "text/plain; version=0.0.4" },
					});
				default:
					return new Response("not found", { status: 404 });
			}
		},
	});
	return {
		port: server.port ?? options.port,
		stop: async () => {
			await server.stop(true);
		},
	};
}
