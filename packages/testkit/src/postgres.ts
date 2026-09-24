import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** Exact tag; the deploy/ Compose files (Phase 1) must use the same version. */
export const POSTGRES_IMAGE = "postgres:17.6-alpine";

export type TestPostgres = Readonly<{
	connectionString: string;
	stop: () => Promise<void>;
}>;

/** Starts a throwaway PostgreSQL container for integration tests. */
export async function startTestPostgres(): Promise<TestPostgres> {
	const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
		.withDatabase("gateway_test")
		.withUsername("gateway")
		.withPassword("gateway")
		.start();

	return {
		connectionString: container.getConnectionUri(),
		stop: async () => {
			await container.stop();
		},
	};
}
