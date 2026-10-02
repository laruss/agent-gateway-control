import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ---------------------------------------------------------------------------
// The owner's console SPA (ADR-025): built to static assets the controller serves from its own
// listener (`apps/controller/src/console-server.ts`), never a separate deployed service. `bun run
// console:dev` proxies `/api/*` to the controller's console port so the same relative API calls
// the built app makes work unchanged in development; `bun run console:build` is the only thing
// the release image actually uses (`deploy/images/Dockerfile`).
// ---------------------------------------------------------------------------

const CONSOLE_DEV_PROXY_TARGET = process.env.CONSOLE_DEV_PROXY_TARGET ?? "http://127.0.0.1:8084";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	build: {
		// No source maps in the production output (never served by the controller), and no
		// module-preload polyfill inline script: the CSP this app ships under forbids inline
		// `<script>` content entirely (`script-src 'self'`), and every supported browser already
		// has native modulepreload support.
		sourcemap: false,
		modulePreload: { polyfill: false },
	},
	server: {
		proxy: {
			"/api": CONSOLE_DEV_PROXY_TARGET,
		},
	},
});
