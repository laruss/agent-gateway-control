import { loadLocalSchema, releasesToCertify } from "@agent-gateway/db";

/**
 * Prints MIGRATIONS.md for a release bundle: the migrations the release ships, their kinds,
 * and which earlier releases may still run after this release migrated the database.
 */
const version = process.argv[2];
if (version === undefined) {
	throw new Error("usage: migrations-report.ts <version>");
}
const local = await loadLocalSchema();
const pgbossSchema = local.pgbossSchema;
const certified = releasesToCertify(local, version).filter((release) => release !== version);
const lines = [
	`# Database migrations of release ${version}`,
	"",
	"`gateway db migrate` of this release applies the migrations below that the database does",
	"not have yet, then certifies the releases that may run on the result. A release starts only",
	"against a database it is certified for (see UPGRADE.md and ROLLBACK.md).",
	"",
	certified.length === 0
		? "**Rollback without a restore:** none. After this release migrated the database, an earlier release refuses to start on it; going back means restoring the pre-upgrade backup."
		: `**Rollback without a restore:** releases ${certified.join(", ")} keep running on the database this release migrated.`,
	"",
	"Kinds: `expand` keeps the previous release working; `contract` breaks it; `pre-release`",
	"came before the first release. An earlier release on another pg-boss schema version is never",
	`certified: this release runs on pg-boss schema ${pgbossSchema}.`,
	"",
	"| # | Migration | Kind | First shipped in |",
	"|---|-----------|------|------------------|",
];
let index = 0;
for (const migration of local.migrations) {
	const release =
		local.releases.find((r) => local.migrations.findIndex((m) => m.tag === r.head) >= index)
			?.version ?? version;
	lines.push(`| ${index} | \`${migration.tag}\` | ${migration.kind} | ${release} |`);
	index += 1;
}
console.log(lines.join("\n"));
