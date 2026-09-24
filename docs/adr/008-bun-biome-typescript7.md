# ADR-008. Bun as runtime and package manager, Biome, TypeScript 7

- Status: Accepted
- Date: 2026-09-24
- Replaces the initial choice: Node.js 24 + pnpm + ESLint/Prettier

## Context

The project rules require bun instead of npm/pnpm and validation through `bun run fix`
(Biome + `tsc`). The initial stack choice was Node.js 24 LTS and pnpm workspaces.

## Decision

- **Runtime:** Bun for the controller, workers, CLI, tests and production images (`oven/bun`,
  pinned by digest). The Bun version is pinned in `packageManager`.
- **Monorepo:** bun workspaces, `bun.lock` lockfile, packages named `@agent-gateway/*`.
  TypeScript runs directly; internal packages need no build step.
- **Lint/format:** Biome. Ignore/suppression directives are forbidden.
- **Typecheck:** TypeScript 7 (`tsc`), strict mode, `noUncheckedIndexedAccess`.
- **Tests:** Vitest, run under Bun with `bun --bun vitest`.
- **YAML:** the built-in `Bun.YAML`, no extra dependency.

Compatibility was verified by the Phase 0 smoke test: pg-boss 12, Drizzle ORM (node-postgres),
`pg` and Testcontainers work under Bun 1.4, and transactional enqueue is confirmed.

## Alternatives

- **Node.js 24 with bun only as the package manager.** Maximum ecosystem compatibility, but two
  runtimes across dev/prod and a conflict with the project rules.
- **Node.js + pnpm.** Conflicts with the project rules.

## Consequences

- AI runtime CLIs (Codex, Claude Code, etc.) run as child processes and do not depend on the
  Gateway runtime; their compatibility is verified in Phases 4-5.
- If a library turns out to be incompatible with Bun, a new ADR records the justification for
  the fallback.
- `bunx vitest` without `--bun` runs Vitest under Node; use only the `bun run test*` scripts.
