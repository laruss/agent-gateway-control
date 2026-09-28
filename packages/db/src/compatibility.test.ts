import { DEVELOPMENT_VERSION } from "@agent-gateway/logging";
import { describe, expect, it } from "vitest";
import {
	checkCompatibility,
	type LocalMigration,
	type LocalSchema,
	loadLocalSchema,
	releasesToCertify,
} from "./compatibility.ts";

const migration = (tag: string, kind: LocalMigration["kind"]): LocalMigration => ({
	tag,
	hash: `hash-${tag}`,
	kind,
});

const local = (
	migrations: Readonly<LocalMigration[]>,
	releases: LocalSchema["releases"] = [],
): LocalSchema => ({ folder: "/unused", migrations, releases });

const base = [migration("0000", "pre-release"), migration("0001", "expand")];
const hashes = (schema: LocalSchema) => schema.migrations.map((m) => m.hash);

describe("checkCompatibility", () => {
	const schema = local(base);

	it("needs a migrated database", () => {
		expect(checkCompatibility(schema, undefined, "0.1.0")).toMatchObject({
			ok: false,
			reason: "not-migrated",
		});
		expect(checkCompatibility(schema, { hashes: [], certified: [] }, "0.1.0")).toMatchObject({
			reason: "not-migrated",
		});
	});

	it("reports pending migrations", () => {
		const state = { hashes: ["hash-0000"], certified: ["0.1.0"] };
		expect(checkCompatibility(schema, state, "0.1.0")).toMatchObject({
			ok: false,
			reason: "pending",
			detail: "1 pending migration(s)",
		});
	});

	it("refuses a history that differs from the shipped one", () => {
		const state = { hashes: ["hash-0000", "other"], certified: ["0.1.0"] };
		expect(checkCompatibility(schema, state, "0.1.0")).toMatchObject({
			ok: false,
			reason: "diverged",
		});
	});

	it("runs a release only where it is certified", () => {
		const state = { hashes: hashes(schema), certified: ["0.1.0"] };
		expect(checkCompatibility(schema, state, "0.1.0").ok).toBe(true);
		expect(checkCompatibility(schema, state, "0.2.0")).toMatchObject({
			ok: false,
			reason: "uncertified",
		});
	});

	it("runs a release on a newer history it is certified for", () => {
		const newer = { hashes: [...hashes(schema), "hash-0002"], certified: ["0.1.0", "0.2.0"] };
		expect(checkCompatibility(schema, newer, "0.1.0")).toEqual({
			ok: true,
			detail: "certified for 1 newer migration(s)",
		});
		expect(checkCompatibility(schema, { ...newer, certified: ["0.2.0"] }, "0.1.0")).toMatchObject({
			ok: false,
			reason: "uncertified",
		});
	});

	it("runs a development build on exactly its own history", () => {
		expect(
			checkCompatibility(schema, { hashes: hashes(schema), certified: [] }, DEVELOPMENT_VERSION).ok,
		).toBe(true);
		const newer = { hashes: [...hashes(schema), "hash-0002"], certified: [DEVELOPMENT_VERSION] };
		expect(checkCompatibility(schema, newer, DEVELOPMENT_VERSION)).toMatchObject({
			ok: false,
			reason: "uncertified",
		});
	});
});

describe("releasesToCertify", () => {
	it("certifies the migrating release and the published ones its later migrations keep working", () => {
		const schema = local(
			[...base, migration("0002", "expand"), migration("0003", "expand")],
			[
				{ version: "0.1.0", head: "0001" },
				{ version: "0.2.0", head: "0002" },
			],
		);
		expect(releasesToCertify(schema, "0.3.0")).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
	});

	it("does not certify a release a later contract migration breaks", () => {
		const schema = local(
			[...base, migration("0002", "contract"), migration("0003", "expand")],
			[
				{ version: "0.1.0", head: "0001" },
				{ version: "0.2.0", head: "0002" },
			],
		);
		expect(releasesToCertify(schema, "0.3.0")).toEqual(["0.2.0", "0.3.0"]);
	});

	it("certifies a release migrating its own head", () => {
		const schema = local(base, [{ version: "0.1.0", head: "0001" }]);
		expect(releasesToCertify(schema, "0.1.0")).toEqual(["0.1.0"]);
	});
});

describe("the shipped migrations", () => {
	it("all have a kind, and every published release a known head in order", async () => {
		const schema = await loadLocalSchema();
		expect(schema.migrations.length).toBeGreaterThan(0);
		expect(schema.migrations.at(-1)?.tag).toBe("0014_schema_state");
		// Migrations after the first release are never pre-release.
		const firstRelease = schema.releases[0];
		if (firstRelease !== undefined) {
			const head = schema.migrations.findIndex((m) => m.tag === firstRelease.head);
			expect(schema.migrations.slice(head + 1).every((m) => m.kind !== "pre-release")).toBe(true);
		}
	});
});
