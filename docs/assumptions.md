# Assumptions and constraints of the first version

Changing an assumption requires an ADR.

1. The home server runs Linux and supports Docker Engine + Docker Compose.
2. Single-node deployment, no High Availability.
3. Mattermost Team Edition is sufficient for the first version.
4. Mattermost and Agent Gateway are separate Compose projects joined by a shared internal Docker
   network.
5. Mattermost has a TLS domain. Gateway admin interfaces are reachable only locally or over VPN.
6. The MVP works in public and private channels and threads. Direct Messages are not supported
   ([ADR-006](adr/006-no-direct-messages-in-mvp.md)).
7. Every logical agent has its own Mattermost bot account
   ([ADR-005](adr/005-one-bot-per-agent.md)).
8. An AI runtime must offer legitimate non-interactive/API access on the home server. A
   consumer UI subscription alone is not enough.
9. If a runtime cannot be authenticated or run on the server, its adapter stays disabled and the
   core keeps working.
10. Development happens locally in a GitHub repository. The server never builds from source; it
    receives versioned release images and a release bundle.
11. The first version forbids, without human approval: payments, sending external email,
    production deploys, data deletion, publishing to external services, creating paid accounts.
12. The local workstation does not have to stay on: runtime workers run on the server. A remote
    runner is an optional future fallback.
13. The Gateway runtime is Bun and the package manager is bun workspaces
    ([ADR-008](adr/008-bun-biome-typescript7.md)).
14. Channels, owners and bots are configured by name. `gateway mattermost bootstrap` resolves
    names to Mattermost ids and stores them in the database; authorization (approvals, routing)
    always checks ids, never names.
