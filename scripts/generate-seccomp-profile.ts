import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

/**
 * Writes the worker's seccomp profile: Docker's default profile (a pinned revision of
 * moby/profiles) plus the calls bubblewrap needs to confine a runtime's commands in an
 * unprivileged user namespace. Nothing else is added; capabilities stay dropped.
 */
const SOURCE =
	"https://raw.githubusercontent.com/moby/profiles/85e237f1fe229a0c61c9c7d8e743fa780d3b97ca/seccomp/default.json";
const SOURCE_SHA256 = "785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334";

/** Namespaces (clone with namespace flags, unshare, setns) and the sandbox's private mounts. */
const SANDBOX_SYSCALLS = ["clone", "unshare", "setns", "mount", "umount2", "pivot_root"];

const ProfileSchema = z.looseObject({ syscalls: z.array(z.looseObject({})) });

const response = await fetch(SOURCE);
if (!response.ok) {
	throw new Error(`fetching ${SOURCE} failed: ${response.status}`);
}
const text = await response.text();
const digest = createHash("sha256").update(text).digest("hex");
if (digest !== SOURCE_SHA256) {
	throw new Error(`${SOURCE} changed: sha256 ${digest}`);
}
const profile = ProfileSchema.parse(JSON.parse(text));
const sandboxed = {
	...profile,
	syscalls: [
		...profile.syscalls,
		{
			names: SANDBOX_SYSCALLS,
			action: "SCMP_ACT_ALLOW",
			comment:
				"agent-gateway: bubblewrap creates an unprivileged user namespace with private mounts for a runtime's commands",
		},
	],
};
const target = join(import.meta.dir, "..", "deploy", "images", "seccomp", "worker-sandbox.json");
await Bun.write(target, `${JSON.stringify(sandboxed, null, "\t")}\n`);
console.log(`wrote ${target}`);
