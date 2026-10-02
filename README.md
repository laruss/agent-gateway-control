# Agent Gateway

A self-hosted, deterministic control plane for an organization of AI agents that talk through
Mattermost. See [docs/about.md](docs/about.md).

## Requirements

- Bun 1.4+ (the exact version is pinned in `package.json#packageManager`)
- Docker (for integration tests via Testcontainers)

## Installing

A server installs a GitHub Release (container images and a bundle), not a checkout: see
[deploy/release/INSTALL.md](deploy/release/INSTALL.md).

## Development

```bash
bun install
bun run fix               # Biome --write + tsc typecheck
bun run test              # unit tests
bun run test:integration  # integration tests, needs Docker
bun run test:e2e          # Mattermost bridge against a real Mattermost, needs Docker
bun run schemas:generate  # regenerate config/schemas from Zod contracts
bun run db:generate       # new migration after a schema change
bun run dev:infra         # development PostgreSQL and Mattermost (Docker Compose)
bun run dev               # controller and a mock worker
bun run dev:connector-gmail  # Gmail connector (see the Gmail guide)
bun run gateway doctor    # admin CLI
```

See [local development](docs/operations/local-development.md) for the full walkthrough.

## Documentation

- [About](docs/about.md)
- [Project structure](docs/project-structure.md)
- [Assumptions](docs/assumptions.md)
- [Architecture decisions](docs/adr/README.md)
- [Threat model](docs/security/threat-model.md)
- [Local development](docs/operations/local-development.md)
- [Mattermost bootstrap and operation](docs/operations/mattermost.md)
- [Gmail connector setup and operation](docs/operations/gmail.md)
- [Approvals, the tool runner and budgets](docs/operations/approvals.md)
- [The tool catalog and effective permissions](docs/operations/tool-catalog.md)
- [Observability, alerts and retention](docs/operations/observability.md)
- [Backups of the Gateway database](docs/operations/backups.md)
- [Security scans](docs/operations/security-scans.md)
- [Releases](docs/operations/releases.md); installing on a server:
  [deploy/release/INSTALL.md](deploy/release/INSTALL.md)
- [The home server on an Apple silicon Mac](docs/operations/home-server.md)
- [Privacy notes](docs/security/privacy.md)
- [Implementation status](IMPLEMENTATION_STATUS.md)

## License

[MIT](LICENSE)
