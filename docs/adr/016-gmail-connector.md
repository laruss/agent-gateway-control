# ADR-016. Gmail connector: watch, Pub/Sub pull, history cursor, read-only credential

- Status: Accepted
- Date: 2026-09-26

## Context

`@mail-follower` must wake once for every email that reaches the inbox. It must not miss mail
when a notification is late or lost, or while the connector is down. The Gateway runs on a
home server that should not open an inbound port. Mail is written by strangers, so it is the
most exposed prompt injection channel the Gateway has. The connector must not be able to
send mail at all.

## Decision

- **Topology.** Gmail `users.watch` publishes mailbox changes to a Cloud Pub/Sub topic. The
  connector reads them from a pull subscription, so no public endpoint is needed. The connector
  is a process of its own (`apps/connector-gmail`). It alone holds the Google credential; the
  controller and the workers never see it.
- **Plain REST, no Google SDK.** Every call is a `fetch`: Gmail, Pub/Sub, OAuth. Pub/Sub is
  read with synchronous pull (a long-polling request per batch) instead of gRPC streaming
  pull. For one mailbox, which gets at most one notification per second, the two behave the
  same. This avoids a large dependency tree and the gRPC stack under Bun, and a fake speaking
  the same wire format tests every path.
- **One credential, exactly two scopes.** The operator's OAuth consent (`gateway gmail
  authorize`: loopback redirect, PKCE, checked state) grants `gmail.readonly` and `pubsub`, and
  nothing else. Every token refresh checks the granted scopes. A credential with any other
  scope (sending, drafts, modification, full mail access) is refused and alerted, even though
  the connector would never use it. The Gmail client has no call that changes mail; `watch`
  only asks Gmail to publish notifications. The refresh token lives in a secret file (mode
  0600), is read once when the connector starts, and is never printed or logged; a new
  consent applies at the next start, where the account check below runs.
- **The history cursor is the source of truth.** A notification only says "the mailbox changed
  up to history id N". The connector:
  1. stores the notification as an event (`google.gmail.notification.received`, deduplicated
     by its Pub/Sub message id; record-only, it never routes);
  2. acknowledges it only after that commit;
  3. syncs: `history.list` from the cursor (messages added to the inbox, new or labelled INBOX
     later, e.g. by a filter or taken back from the archive), `messages.get` for each message,
     one `google.gmail.message.received` event per message, once however often it enters the
     inbox. History usually names messages by id only, so a message counts as received when
     history reports it added to the inbox; its current labels only leave out spam, trash,
     drafts, chats and the owner's own sent mail.
  Each history page is ingested and the cursor moved **in one transaction**
  (`gmail_mailboxes.history_id`; a compare-and-set on the old cursor, so concurrent syncs
  cannot both commit). A crash re-reads at most one page, and the deterministic event id
  `gmail-message:<mailbox>:<message id>` makes the second ingest a no-op. A restart resumes
  from the cursor; a first start begins at the mailbox's present without replaying old mail.
  The first watch creates that cursor, and syncing and pulling start only after it, so no
  second start races it. The cursor is bound to its account (a hash of the address): a
  credential of another account is refused until the operator resets the mailbox
  (`gateway gmail reset`). Every sync that reached the mailbox's present is recorded, also one
  that found nothing, so health and a later full sync know when the mailbox was last in step;
  a sync stopped halfway through the history does not count.
- **Reconciliation.** Gmail may delay or drop notifications, so the connector also syncs every
  five minutes without one. When the cursor is older than Gmail's history (HTTP 404, after
  about a week), a full sync lists the inbox since an hour before the last completed sync (or
  the cursor's creation), restarts the
  cursor at the mailbox's current history id and alerts, in the same transaction. It reads at most the latest 500
  messages, so a long outage does not wake agents for thousands of old mails; the alert says
  when older mail was left unread.
- **Watch lifecycle.** The watch is renewed daily and whenever it expires within two days;
  Gmail stops notifying after seven days. A failed renewal near expiry alerts. While there is
  no watch, mail still arrives through the periodic sync.
- **Normalized, external-untrusted events.** The contract enforces `external-untrusted` on
  every Gmail event. `data` holds only fields that do not change after delivery:
  - addresses and subject from the headers, with MIME encoded words decoded;
  - the body as plain text, converted from the HTML part (what a reader sees; empty for an
    HTML part with images only), and from the text/plain part only when there is no HTML: a
    sender cannot show a harmless HTML version and put instructions in the plain one;
  - attachments described by name, type and size, never their content.
  The HTML conversion removes active and embedded content (scripts, styles, frames, forms,
  media, SVG) and content hidden from the reader, and flags the removal
  (`hidden_text_removed`). A hiding rule it does not resolve (under a `@media` condition, an
  unreadable selector, beyond 2000 rules) keeps its text and marks the mail
  (`hidden_text_suspected`), so the agent is warned instead of reading it as plain text.
  Hidden means: by inline style or by a top-level rule of the mail's
  own stylesheet (the element its selector's last compound names: tag, classes, id; rules
  inside `@media` and similar apply to some screens only and are ignored), CSS escapes
  decoded, `display:none`, `visibility:hidden`, transparency, a font of 1 px or less,
  zero size with the overflow cut off, off-screen positioning, text in the background colour,
  the `hidden` attribute. It keeps link targets next to their text, so a
  phishing check can compare them. All text is stripped of control, bidi and invisible
  characters and bounded (16 000 characters of body; HTML is read up to 2 million characters
  and 256 levels of nesting, so a crafted mail cannot stall the sync). One correlation per Gmail thread
  (`gmail-thread:<mailbox>:<thread id>`). The event contract binds the envelope to the data:
  source `gmail://<mailbox>`, id and correlation from the message and its thread, so no Gmail
  event can claim another correlation.
- **Waking.** `@mail-follower` subscribes to `google.gmail.message.received` with an untargeted
  wake rule. A notification never wakes anyone. Routing, coalescing and the loop guards apply
  as to every event. Each received mail starts a new cascade in its thread's correlation, as a
  new human post does, so a long mail thread does not use up one cascade budget for good; the
  hourly and per-thread limits still bound it.
- **Health.** The connector serves `/health/ready`: database, credential, pull, watch and sync
  freshness. `gateway gmail status` and `gateway health` show each mailbox's watch and last
  sync. Alerts cover a refused credential, a watch that cannot be renewed, notifications that
  cannot be pulled, a message that cannot be normalized, and a history gap.

## Consequences

- An email reaches a model only as data marked external-untrusted. The model's result is still
  checked against the agent's authority, so an email that talks the model into a finance
  action or a secret gets a refused run, `deny` policy decisions and an alert, and nothing is
  published. Secrets are never in the turn input. The integration tests show this.
- The `pubsub` scope is as broad as the operator's IAM permissions: a token of a project owner
  may manage every topic and subscription that owner can. This was chosen over a service
  account to keep one credential. A dedicated Google account, or a project that holds only the
  topic and the subscription, narrows it.
- A Google OAuth app in "Testing" status issues refresh tokens that expire after seven days. A
  personal deployment publishes the app ("In production", unverified). Google then warns on
  the consent page, and the token lasts until it is revoked.
- Mail that arrived and left the inbox between two syncs (read on the phone and archived at
  once) is still an event: history reports the addition. Spam, trash, drafts and chats are not.
- A full sync lists the inbox by message date, so an old message moved into the inbox during
  a week-long outage is not found. Listing the whole inbox instead would wake agents for all
  the mail that was there before the connector started.
- The hidden-text rules are heuristics. They cover the common tricks; unusual CSS can still
  hide text from the reader. The body always stays external-untrusted data.
- Attachment content is never read. Scanning and handing attachments to tools is left to the
  Tool Broker (Phase 7).
- Replies and forwarding are not part of the MVP. `mail.send` stays a tool that requires human
  approval in the agent policy, and no deliverer for it exists.
