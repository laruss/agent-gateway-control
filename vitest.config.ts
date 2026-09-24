import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["{apps,packages}/**/*.test.ts"],
					exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
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
		],
	},
});
