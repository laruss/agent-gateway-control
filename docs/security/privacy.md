# Privacy notes

## Agent memory and summaries

- Agents store memory only through structured proposals. A private namespace (`agents/<id>`) is
  read by its own agent only; shared namespaces (`organization/<topic>`) are read by every agent
  configured for them, after an operator accepted the item. Rejected and superseded items stay
  in the database for audit.
- Each run's structured public summary is kept with the run and merged into its thread's
  summary, which later turns of agents working in that thread read. Summaries carry results and
  open work, never the model's reasoning.

## Mattermost posts

- The Gateway stores posts in managed channels as events: author id, channel, thread, text (up
  to 16 383 characters) and the routing it computed. Not stored: posts in other channels,
  system messages (joins, leaves), the listener bot's own alerts and cards, and posts by an
  agent's bot that the Gateway did not sign (only an audit record of the rejection is kept).
- An edit is stored as a new event with the edited text; the original event keeps the text as
  first seen. Mattermost shows only the latest version, so the Gateway's history of a post can
  hold text Mattermost no longer shows.
- A deletion is stored as an event without text. Earlier events of the deleted post, and the
  audit trail of what agents did in response, are not removed: the audit log is append-only.
  Retention of raw message text is a deployment policy (Phase 8); until then, deleting a post
  in Mattermost does not delete it from the Gateway database.
- A turn's context includes posts of its thread as the Gateway stored them, with edits applied
  and deleted posts left out; the snapshot of what a run received is kept with the run
  (`context_snapshots`), so a post deleted later remains in the snapshots of runs that already
  saw it.
- The Gateway reads nothing from Direct Messages ([ADR-006](../adr/006-no-direct-messages-in-mvp.md)).
