import type { AgentConfig } from "./agent-config.ts";
import { ROUTING_KEY_SECRET_FILE, toolPatternsOverlap } from "./common.ts";
import type { OrganizationConfig } from "./organization.ts";

export type ConfigBundle = Readonly<{
	organization: OrganizationConfig;
	agents: Readonly<AgentConfig[]>;
}>;

export type ConfigBundleIssue = Readonly<{
	agentId: string | null;
	message: string;
}>;

const FINANCE_TOOLS = "finance.*";
/** The only finance tool that may run without a human approval. */
const FINANCE_READ_ONLY_TOOL = "finance.read";

function financeIssues(agent: AgentConfig, financeAgentId: string): ConfigBundleIssue[] {
	const issues: ConfigBundleIssue[] = [];
	const { tools_allow, tools_require_human_approval, tools_deny } = agent.permissions;
	const touchesFinance = (pattern: string) => toolPatternsOverlap(pattern, FINANCE_TOOLS);

	if (agent.id !== financeAgentId) {
		for (const pattern of [...tools_allow, ...tools_require_human_approval].filter(
			touchesFinance,
		)) {
			issues.push({
				agentId: agent.id,
				message: `only '${financeAgentId}' may hold finance tools, found '${pattern}'`,
			});
		}
		if (!tools_deny.includes(FINANCE_TOOLS)) {
			issues.push({ agentId: agent.id, message: `tools_deny must contain '${FINANCE_TOOLS}'` });
		}
		return issues;
	}

	for (const pattern of tools_allow.filter(touchesFinance)) {
		if (pattern !== FINANCE_READ_ONLY_TOOL) {
			issues.push({
				agentId: agent.id,
				message: `finance action '${pattern}' must be in tools_require_human_approval, not tools_allow`,
			});
		}
	}
	return issues;
}

/**
 * Cross-file checks that a single-file schema cannot express.
 * Returns an empty list when the bundle is consistent.
 */
export function validateConfigBundle(bundle: ConfigBundle): Readonly<ConfigBundleIssue[]> {
	const issues: ConfigBundleIssue[] = [];
	const { organization } = bundle.organization;
	const { listener } = bundle.organization.mattermost;
	const channels = new Set(bundle.organization.mattermost.channels);
	const agentIds = new Set<string>();
	const usernames = new Set<string>();
	const secretFiles = new Set<string>([ROUTING_KEY_SECRET_FILE]);
	if (listener.token_secret_file === ROUTING_KEY_SECRET_FILE) {
		issues.push({
			agentId: null,
			message: `listener token file '${ROUTING_KEY_SECRET_FILE}' is reserved for the routing key`,
		});
	}
	secretFiles.add(listener.token_secret_file);

	if (organization.owner_mattermost_usernames.includes(listener.username)) {
		issues.push({
			agentId: null,
			message: `listener username '${listener.username}' collides with a human owner`,
		});
	}

	for (const agent of bundle.agents) {
		if (agentIds.has(agent.id)) {
			issues.push({ agentId: agent.id, message: `duplicate agent id '${agent.id}'` });
		}
		agentIds.add(agent.id);

		const { username } = agent.mattermost;
		if (username !== agent.id) {
			issues.push({
				agentId: agent.id,
				message: `Mattermost username '${username}' must equal the agent id`,
			});
		}
		if (usernames.has(username)) {
			issues.push({ agentId: agent.id, message: `duplicate Mattermost username '${username}'` });
		}
		usernames.add(username);

		if (username === listener.username) {
			issues.push({
				agentId: agent.id,
				message: `bot username '${username}' collides with the listener bot`,
			});
		}
		if (secretFiles.has(agent.mattermost.token_secret_file)) {
			issues.push({
				agentId: agent.id,
				message: `token secret file '${agent.mattermost.token_secret_file}' is used by another bot or the routing key`,
			});
		}
		secretFiles.add(agent.mattermost.token_secret_file);

		if (organization.owner_mattermost_usernames.includes(username)) {
			issues.push({
				agentId: agent.id,
				message: `bot username '${username}' collides with a human owner`,
			});
		}

		for (const channel of agent.mattermost.allowed_channels) {
			if (!channels.has(channel)) {
				issues.push({
					agentId: agent.id,
					message: `channel '${channel}' is not listed in organization mattermost.channels`,
				});
			}
		}

		if (agent.memory.private_namespace !== `agents/${agent.id}`) {
			issues.push({
				agentId: agent.id,
				message: `memory.private_namespace must be 'agents/${agent.id}'`,
			});
		}

		for (const rule of agent.wake_rules) {
			if (rule.target_agent_id !== undefined && rule.target_agent_id !== agent.id) {
				issues.push({
					agentId: agent.id,
					message: `wake rule for '${rule.event_type}' targets another agent '${rule.target_agent_id}'`,
				});
			}
		}

		issues.push(...financeIssues(agent, organization.finance_agent_id));
	}

	if (!agentIds.has(organization.finance_agent_id)) {
		issues.push({
			agentId: null,
			message: `finance_agent_id '${organization.finance_agent_id}' has no agent definition`,
		});
	}

	return issues;
}
