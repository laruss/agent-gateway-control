# About

**Agent Gateway** is a self-hosted control plane for an organization of logical AI agents that
work asynchronously and communicate through Mattermost.

- Every agent is a separate Mattermost identity with its own role, prompt, permissions, memory
  and AI runtime (Codex, Claude Code, Grok, Kiro, OpenCode Go, Hermes).
- Agents wake each other explicitly through `@mention` and structured targets, and can wait for
  a reply or an external event without holding a model process: a "sleeping" agent is an
  `IDLE`/`WAITING` state in the database.
- The Gateway is deterministic and is not an LLM agent itself. It ingests events (Mattermost,
  Gmail, timers, webhooks), stores them in PostgreSQL, routes them, assembles context, queues
  runs, enforces policy and posts replies through a transactional outbox.
- High-risk actions (finance, external sends, deploys, deletions) are physically isolated and
  require human approval.
- Humans see all communication in Mattermost, can stop the system (`kill-all`), approve or deny
  actions, and investigate any run through the audit trail.

Code layout: [project-structure.md](project-structure.md).
Architecture decisions: [adr/](adr/README.md).
