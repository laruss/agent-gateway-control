import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// The console's own `@/*` import alias (`apps/console/tsconfig.app.json`,
	// `apps/console/vite.config.ts`): no other workspace uses this prefix, so one repo-wide alias
	// is simpler than teaching Vitest about a per-directory one.
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./apps/console/src", import.meta.url)),
		},
	},
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["{apps,packages}/**/*.test.{ts,tsx}"],
					exclude: [
						"**/node_modules/**",
						"**/*.integration.test.ts",
						"**/*.e2e.test.ts",
						"**/*.live.test.ts",
					],
					// The console's component tests extend `expect` with jest-dom matchers and clean up
					// the DOM after each test; harmless for every other unit test, which never touches it.
					setupFiles: ["./apps/console/src/test-setup.ts"],
					// Adapter tests start fake CLI processes, several per test and many in parallel.
					testTimeout: 30_000,
				},
			},
			{
				test: {
					name: "integration",
					include: ["{apps,packages}/**/*.integration.test.ts"],
					testTimeout: 120_000,
					hookTimeout: 120_000,
					fileParallelism: false,
				},
			},
			{
				test: {
					name: "e2e",
					include: ["{apps,packages}/**/*.e2e.test.ts"],
					testTimeout: 180_000,
					hookTimeout: 360_000,
					fileParallelism: false,
				},
			},
			{
				test: {
					name: "live",
					include: ["{apps,packages}/**/*.live.test.ts"],
					testTimeout: 600_000,
					hookTimeout: 60_000,
					fileParallelism: false,
				},
			},
		],
	},
});
