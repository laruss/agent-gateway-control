import { GenericContainer, Network, type StartedTestContainer, Wait } from "testcontainers";
import { POSTGRES_IMAGE } from "./postgres.ts";

/** The pinned Mattermost release (ESR) the bridge is tested against; amd64 only. */
export const MATTERMOST_IMAGE = "mattermost/mattermost-team-edition:11.7.11";

/** Throwaway credentials of a throwaway server. */
const PASSWORD = "Test-password-1!";

export type TestMattermostUser = Readonly<{ id: string; username: string; token: string }>;

export type TestMattermost = Readonly<{
	url: string;
	/** A system admin's personal access token, for bootstrap and test setup. */
	adminToken: string;
	teamId: string;
	/** Channel ids by name. */
	channels: ReadonlyMap<string, string>;
	/** Human accounts by username, logged in. */
	users: ReadonlyMap<string, TestMattermostUser>;
	stop: () => Promise<void>;
}>;

export type TestMattermostOptions = Readonly<{
	team: string;
	/** Channels to create; private when the name is in `privateChannels`. */
	channels: Readonly<string[]>;
	privateChannels?: Readonly<string[]>;
	/** Human accounts to create and add to every channel. */
	users: Readonly<string[]>;
}>;

type Json = Record<string, string | number | boolean | null | object>;

async function api(
	url: string,
	method: string,
	path: string,
	token: string | null,
	body?: object,
): Promise<Readonly<{ status: number; json: Json; headers: Headers }>> {
	const response = await fetch(`${url}/api/v4/${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	const json: Json = text === "" ? {} : JSON.parse(text);
	if (!response.ok) {
		throw new Error(`test Mattermost ${method} ${path}: HTTP ${response.status} ${text}`);
	}
	return { status: response.status, json, headers: response.headers };
}

function field(json: Json, name: string): string {
	const value = json[name];
	if (typeof value !== "string") {
		throw new Error(`test Mattermost response has no '${name}'`);
	}
	return value;
}

async function createUser(url: string, username: string, adminToken: string | null) {
	const created = await api(url, "POST", "users", adminToken, {
		email: `${username}@example.test`,
		username,
		password: PASSWORD,
	});
	const login = await api(url, "POST", "users/login", null, {
		login_id: username,
		password: PASSWORD,
	});
	const token = login.headers.get("token");
	if (token === null) {
		throw new Error(`test Mattermost login of '${username}' returned no token`);
	}
	return { id: field(created.json, "id"), username, token };
}

/**
 * A real Mattermost server with its own PostgreSQL on a private network, set up like a fresh
 * installation after the manual steps an operator takes before bootstrap: an admin, a team, the
 * managed channels and human accounts. Bots and tokens are left to the code under test.
 */
export async function startTestMattermost(options: TestMattermostOptions): Promise<TestMattermost> {
	const network = await new Network().start();
	const containers: StartedTestContainer[] = [];
	const stop = async () => {
		for (const container of containers.reverse()) {
			await container.stop();
		}
		await network.stop();
	};
	try {
		const database = await new GenericContainer(POSTGRES_IMAGE)
			.withNetwork(network)
			.withNetworkAliases("mattermost-db")
			.withEnvironment({
				POSTGRES_USER: "mattermost",
				POSTGRES_PASSWORD: "mattermost",
				POSTGRES_DB: "mattermost",
			})
			.withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
			.start();
		containers.push(database);
		const server = await new GenericContainer(MATTERMOST_IMAGE)
			.withPlatform("linux/amd64")
			.withNetwork(network)
			.withExposedPorts(8065)
			.withEnvironment({
				MM_SQLSETTINGS_DRIVERNAME: "postgres",
				MM_SQLSETTINGS_DATASOURCE:
					"postgres://mattermost:mattermost@mattermost-db:5432/mattermost?sslmode=disable",
				MM_SERVICESETTINGS_ENABLEBOTACCOUNTCREATION: "true",
				MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS: "true",
				MM_TEAMSETTINGS_ENABLEOPENSERVER: "true",
				MM_RATELIMITSETTINGS_ENABLE: "false",
				MM_LOGSETTINGS_CONSOLELEVEL: "ERROR",
				MM_PLUGINSETTINGS_ENABLE: "false",
			})
			.withWaitStrategy(
				Wait.forHttp("/api/v4/system/ping", 8065).forStatusCode(200).withStartupTimeout(240_000),
			)
			.start();
		containers.push(server);
		const url = `http://${server.getHost()}:${server.getMappedPort(8065)}`;

		// The first account on a fresh server becomes its system admin.
		const admin = await createUser(url, "sysadmin", null);
		const adminToken = field(
			(await api(url, "POST", `users/${admin.id}/tokens`, admin.token, { description: "test" }))
				.json,
			"token",
		);
		const teamId = field(
			(
				await api(url, "POST", "teams", adminToken, {
					name: options.team,
					display_name: options.team,
					type: "O",
				})
			).json,
			"id",
		);
		const channels = new Map<string, string>();
		for (const name of options.channels) {
			const created = await api(url, "POST", "channels", adminToken, {
				team_id: teamId,
				name,
				display_name: name,
				type: options.privateChannels?.includes(name) ? "P" : "O",
			});
			channels.set(name, field(created.json, "id"));
		}
		const users = new Map<string, TestMattermostUser>();
		for (const username of options.users) {
			const user = await createUser(url, username, adminToken);
			await api(url, "POST", `teams/${teamId}/members`, adminToken, {
				team_id: teamId,
				user_id: user.id,
			});
			for (const channelId of channels.values()) {
				await api(url, "POST", `channels/${channelId}/members`, adminToken, { user_id: user.id });
			}
			users.set(username, user);
		}
		return { url, adminToken, teamId, channels, users, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
