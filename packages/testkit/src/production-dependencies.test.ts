import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Release images install production dependencies only. Every module a service loads must
 * therefore import only packages its own package declares under `dependencies`: a missing
 * one works in the monorepo (everything is installed) and fails in the image.
 */
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ENTRYPOINTS = ["cli", "controller", "worker", "connector-gmail", "tool-runner"].map((app) =>
	join(ROOT, "apps", app, "src", "main.ts"),
);

const PackageJsonSchema = z.looseObject({
	name: z.string(),
	exports: z.record(z.string(), z.string()).optional(),
	dependencies: z.record(z.string(), z.string()).optional(),
});
type PackageJson = z.infer<typeof PackageJsonSchema>;

function packageOf(file: string): Readonly<{ dir: string; json: PackageJson }> {
	let dir = dirname(file);
	while (!existsSync(join(dir, "package.json"))) {
		dir = dirname(dir);
	}
	return {
		dir,
		json: PackageJsonSchema.parse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))),
	};
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}

function workspaceEntry(specifier: string): string {
	const name = packageName(specifier);
	const folder = name.replace("@agent-gateway/", "");
	for (const group of ["packages", "apps"]) {
		const dir = join(ROOT, group, folder);
		if (existsSync(join(dir, "package.json"))) {
			const { json } = packageOf(join(dir, "package.json"));
			const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
			const target = json.exports?.[subpath];
			if (target === undefined) {
				throw new Error(`${specifier} is not exported by ${name}`);
			}
			return join(dir, target);
		}
	}
	throw new Error(`workspace package ${name} not found`);
}

type Problem = Readonly<{ file: string; imports: string; declaredIn: string }>;

/** Walks the modules reachable from the entrypoints and lists undeclared imports. */
function undeclaredImports(): Problem[] {
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const seen = new Set<string>();
	const pending = [...ENTRYPOINTS];
	const problems: Problem[] = [];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		if (seen.has(file)) {
			continue;
		}
		seen.add(file);
		const owner = packageOf(file);
		// A script's shebang line is not TypeScript.
		const source = readFileSync(file, "utf8").replace(/^#!.*\n/, "");
		for (const { path } of transpiler.scanImports(source)) {
			if (path.startsWith(".")) {
				pending.push(resolve(dirname(file), path));
				continue;
			}
			if (path.startsWith("node:") || path === "bun") {
				continue;
			}
			const name = packageName(path);
			if (owner.json.dependencies?.[name] === undefined) {
				problems.push({
					file: file.slice(ROOT.length + 1),
					imports: name,
					declaredIn: owner.json.name,
				});
			}
			if (name.startsWith("@agent-gateway/")) {
				pending.push(workspaceEntry(path));
			}
		}
	}
	return problems;
}

describe("production dependencies", () => {
	it("every module a service loads imports only its package's dependencies", () => {
		expect(undeclaredImports()).toEqual([]);
	});
});
