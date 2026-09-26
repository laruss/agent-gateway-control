import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["{apps,packages}/**/*.test.ts"],
					exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.e2e.test.ts"],
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
		],
	},
});
