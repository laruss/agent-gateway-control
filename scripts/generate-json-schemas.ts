import { join } from "node:path";
import { PUBLISHED_SCHEMAS, renderJsonSchema } from "@agent-gateway/contracts";

const outDir = join(import.meta.dir, "..", "config", "schemas");

for (const entry of PUBLISHED_SCHEMAS) {
	const target = join(outDir, entry.fileName);
	await Bun.write(target, renderJsonSchema(entry));
	console.log(`wrote ${target}`);
}
