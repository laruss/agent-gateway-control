# ADR-009. Model output is separate from the turn result and fits strict structured output

- Status: Accepted
- Date: 2026-09-24

## Context

Runtimes such as Codex (`--output-schema`) and Claude Code (`--json-schema`) constrain the final
model answer with a JSON Schema. Provider strict mode accepts only a subset of JSON Schema: every
property must be required, every object needs `additionalProperties: false`, and `oneOf`,
`propertyNames` and open records are not supported. The original `AgentTurnResult` draft mixed fields the
model writes with fields only the adapter or the Tool Broker can know (`runId`, `usage`,
`session`, `sideEffectReceipts`).

## Decision

- `AgentTurnModelOutput` is what the model produces: `publicMessages`, `nextState`,
  `publicSummary`, `memoryProposals`, `artifacts`. The Zod schema is shaped for strict mode:
  nullable instead of optional, `anyOf` unions, no records.
- The provider-facing JSON Schema (`config/schemas/agent-turn-model-output.schema.json`) is
  generated from Zod and reduced by `toProviderSchema` to the subset both OpenAI and Anthropic
  accept: no length, size or numeric bounds, `minItems` only 0/1, no lookaround or range
  quantifiers in patterns, and
  only `date-time`, `date`, `time`, `uuid`, `email` formats. A linter test checks the published
  file against these rules independently.
- `AgentTurnResult` is the model output plus adapter metadata: `schemaVersion`, `runId`,
  `usage`, `session`.
- `sideEffectReceipts` are removed from the result. Receipts are written only by the Tool Broker
  and the outbox; a model claiming that a payment succeeded carries no weight.
- Approval `actionParams` are a list of `{name, value}` strings instead of an open object.
  The risk level is assigned by policy, not by the model.
- Schema validity is not authority. `checkTurnResultAuthority` checks a valid result against the
  run: run id, channel allowlist, addressable agents and their membership in the target
  channel (no self-targeting), attachable artifacts, wait senders and targets, writable memory
  namespaces, and approval requests only for actions the tool policy routes to a human.

## Alternatives

- **One schema for both, hand-edited for providers.** Drifts from the Zod source of truth.
- **Non-strict provider mode with repair.** More invalid outputs and repair turns, weaker
  guarantees.

## Consequences

- The provider schema is looser than Zod: bounds, refinements (unique targets, no broadcast
  mentions, no control characters) and some patterns are not expressible in it. Zod still validates every result; a violation triggers
  a single controlled repair attempt before the run fails.
- The controller must build `TurnAuthorityContext` for every run and reject results with issues.
