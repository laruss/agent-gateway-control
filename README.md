# Agent Gateway

A self-hosted, deterministic control plane for an organization of AI agents that talk through
Mattermost. See [docs/about.md](docs/about.md).

## Requirements

- Bun 1.4+ (the exact version is pinned in `package.json#packageManager`)
- Docker (for integration tests via Testcontainers)

## Development

```bash
bun install
bun run fix               # Biome --write + tsc typecheck
bun run test              # unit tests
bun run test:integration  # integration tests, needs Docker
bun run schemas:generate  # regenerate config/schemas from Zod contracts
bun run db:generate       # new migration after a schema change
bun run dev:infra         # development PostgreSQL (Docker Compose)
bun run dev               # controller and a mock worker
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
- [Implementation status](IMPLEMENTATION_STATUS.md)
