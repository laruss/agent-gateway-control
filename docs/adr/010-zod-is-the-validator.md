# ADR-010. Zod is the only validator; published JSON Schemas are structural

- Status: Accepted
- Date: 2026-09-24

## Context

Contracts are defined in Zod and exported as JSON Schema to `config/schemas/`. Many rules are
cross-field checks (`.check`, `.refine`): permission overlaps, finance ownership, approval
state invariants, sender-bound waits, memory visibility per namespace, trust labels per author,
unique keys and targets, artifact location, text safety. JSON Schema can express some of them
only with large `anyOf` constructions and cannot express others at all. Reviews repeatedly
found gaps between the two, and every gap was a place where a consumer validating only the
JSON Schema would accept a document the Gateway rejects.

## Decision

- The Zod schemas in `@agent-gateway/contracts` are the only authoritative validator. Every
  service validates with them; nothing trusts a document because it passed a JSON Schema.
- Published JSON Schemas are structural: they describe shape for editors (`yaml-language-server`
  in config examples), documentation and tooling. Each one carries a `$comment` stating this,
  and a test enforces it.
- The provider-facing `agent-turn-model-output.schema.json` is the exception in purpose, not
  in authority: it constrains the model's output shape (ADR-009), and Zod still validates every
  result.
- Where a cross-field rule is cheap to express (typed Mattermost post data per event type), the
  JSON Schema may carry it as a convenience; missing rules are not defects.

## Alternatives

- **Full parity between Zod and JSON Schema.** Not achievable for several rules; attempting it
  duplicates logic in two languages that drift apart.
- **JSON Schema as the source of truth.** Loses TypeScript types and the expressiveness of
  Zod refinements.

## Consequences

- External tools that need full validation must call into the contracts package (or a future
  `gateway config validate` CLI command) rather than a generic JSON Schema validator.
