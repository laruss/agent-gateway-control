# ADR-013. Turn context: stored threads, run summaries, reviewed shared memory

- Status: Accepted
- Date: 2026-09-26

## Context

A turn needs more than its trigger: the thread it belongs to, what earlier runs in that thread
did, and what the agent has learned. The model must never receive the whole Mattermost history,
another agent's private memory, secrets or chain-of-thought. Threads can be long, posts can be
edited or deleted, and a turn resumed by a wait timeout carries no post at all. Context is
assembled inside the scheduling transaction, so it cannot depend on Mattermost being reachable.

## Decision

- **Threads come from stored events, not from Mattermost.** Every post in a managed channel is
  already an event (ADR-012). The scheduler folds the events of the turn's thread: edits
  applied, deleted posts left out (a deleted root keeps its author with an empty message), the
  trigger and inbox posts not repeated (a carried root leaves `rootPost` empty). The newest posts that fit the budget (40 posts, 24 000
  characters, 4 000 per post) are included, oldest first, with the count of those left out. A
  thread is included only if its channel is one of the agent's allowed channels. A thread whose
  root was posted before its channel became managed has no root post, only its replies.
- **Carried posts are shown as they are now.** The trigger and inbox posts carry the text of
  their latest edit (and become internal-untrusted when software edited a human's post). Before a
  run is scheduled, pending inbox entries of deleted posts and of channels the agent is no longer
  allowed in are dropped (`dead`); an entry that already resolved a wait stays, with its current
  text, or an empty one when deleted or when its channel is no longer allowed. While no channel
  is resolved (no configuration, a team change before bootstrap) nothing is dropped. A post
  deleted before a wait saw it, or posted in a channel the agent is no longer allowed in, does
  not resolve the wait later; while no channel is resolved, missed answers are not matched.
- **The turn's thread.** It is the thread of the trigger post. A trigger without a post (a wait
  timeout) takes the thread of the run that created the wait; that run's snapshot records it
  (`context_snapshots.thread_ref`); a creating run without a thread (started by a connector
  event) that opened exactly one new root in the wait's conversation gives that root. Otherwise
  the first inbox post's thread is used. A turn
  resumed by a timeout may reply in its thread and wait on it again.
- **Waits on replies are bound to threads.** A correlation can span several threads (threads an
  agent starts inherit its cascade, ADR-012), so a `mattermost.thread.reply` wait records the
  run's threads of the waited-on conversation (`wait_subscriptions.thread_root_ids`); a reply
  matches only in one of them or in a thread the waiting run itself started (a root post whose
  event names the run as its cause). Waits on new root posts that mention the agent stay bound
  to the correlation only. A run that starts several threads in one conversation accepts the
  expected sender's reply in any of them: it cannot name a root that does not exist yet.
- **Thread summaries are built from run summaries, deterministically.** Every run's structured
  `publicSummary` is merged into its thread's summary (`thread_summaries`) when the run
  completes. The newest 8 runs are kept whole; older runs are compacted into their decisions and
  results, attributed to their agent, keeping the newest 24 lines of each. Rendering spends its
  8 000 characters on the newest runs first. No model call is involved, so compaction cannot
  fail, cost money or be steered by a prompt. A run that carried posts of more than one channel
  adds nothing to a thread summary: the summary is read by every agent of the thread's channel.
- **Previous summary.** The durable state carries the summary of the run that created the wait
  being resolved, else the agent's latest run in the same conversation; only a run whose thread
  is in a channel the agent may still read counts.
- **Memory stays inside namespaces.** A turn reads accepted items of the agent's own private
  namespace (`agents/<id>`) and of its configured shared namespaces, newest first within a budget
  (50 items, 20 000 characters). Items whose visibility contradicts their namespace are dropped
  even if the store returned them.
- **Private memory is accepted at once; shared memory is reviewed.** A proposal to the agent's
  own namespace supersedes the accepted item with the same key. A proposal to a shared
  namespace stays `proposed` until an operator accepts it (`gateway memory accept <id>`), because
  it reaches other agents' turns: a prompt-injected agent must not plant instructions for the
  rest of the organization. One accepted item per key is enforced by a partial unique index.
- **Waits name humans who are there.** `expectedSenderUserIds` must be people who posted in the
  run's threads or wrote the posts it carries, or the organization's owners
  (`TurnAuthorityContext.waitableUserIds`).
- **Trust order in the prompt.** `renderTurnPrompt` (runtime SDK) lays the input out in
  decreasing trust: runtime contract, organization, role, policies, durable state, trigger,
  thread, memory, other pending events, result schema. Everything a person, another agent, a
  connector or an earlier model turn wrote (the durable state included) is inside a `<data>`
  block with its trust label; `<` is escaped inside, so no content can close its block.

## Consequences

- Context assembly needs no network call and is reproducible from the database: the snapshot
  stores exactly what the runtime received.
- History from before a channel became managed is not in any thread context (it was never
  ingested). A thread of more than 1 000 replies is read from its newest 1 000.
- Thread summaries are only as good as the agents' public summaries; they never contain the
  posts themselves.
- Channel boundaries hold for what the Gateway assembles, not for what an agent knows. An agent
  allowed in several channels can carry information between them in its posts, its private
  memory and its summaries, and losing access to a channel does not erase what it learned there.
  Summary provenance is not tracked across runs; the checks above only keep the Gateway itself
  from moving content across a boundary.
- Shared memory needs operator attention: proposals accumulate until reviewed
  (`gateway memory list --status proposed`).
- Relevance ranking of memory (search, embeddings) is out of scope; the newest items win.
