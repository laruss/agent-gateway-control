import { type DeploymentLock, holdDeploymentLock } from "@agent-gateway/db";
import { errorFields, type Logger } from "@agent-gateway/logging";

/** Services run as an unprivileged user: as root, a runtime's sandbox guards nothing. */
export function refuseRoot(uid: number | undefined = process.getuid?.()): void {
	if (uid === 0) {
		throw new Error("Gateway services do not run as root; start them as an unprivileged user");
	}
}

/**
 * What every service does before it starts: refuses root, and holds the deployment lock shared
 * for its lifetime, so `gateway db migrate` never runs under it. Losing the lock (the database
 * went away) stops the process; its supervisor starts it again once the database is back.
 */
export async function claimDeployment(
	log: Logger,
	connectionString: string,
): Promise<DeploymentLock> {
	refuseRoot();
	return holdDeploymentLock(connectionString, (error) => {
		log.error("deployment lock lost; exiting", errorFields(error));
		process.exit(1);
	});
}
