# ADR-017. Gmail connector polls by default; Pub/Sub notifications are optional

- Status: Accepted
- Date: 2026-09-27
- Amends: [ADR-016](016-gmail-connector.md) (topology and credential)

## Context

ADR-016 made Gmail's Pub/Sub push notifications the connector's only way to learn of new
mail. That setup takes:
- a Cloud project with the Gmail and Pub/Sub APIs;
- a topic with a publisher grant for Gmail's service account;
- a pull subscription;
- an OAuth consent that also grants the `pubsub` scope, which is as broad as the operator's
  Pub/Sub permissions.

For one mailbox and an agent that sorts mail, a delay of a minute is fine, and the setup is
the main obstacle to using the connector at all.

An IMAP client (for example himalaya with a Gmail app password) was considered and rejected.
Gmail offers IMAP only with full mailbox access (an app password, or the `mail.google.com`
scope), so the credential could send and delete mail. The connector's guarantee that it has
no send permission would be gone.

## Decision

- **Polling is the default.** Without `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUBSUB_SUBSCRIPTION` the
  connector creates no watch and pulls nothing. It reads the mailbox's history every
  `GMAIL_SYNC_SECONDS`, 60 by default: the same sync as ADR-016's reconciliation, with the
  same cursor, transactions, full sync, account binding and normalization.
- **The credential grants exactly `gmail.readonly` when polling.** `gateway gmail authorize`
  asks for it alone; a token with any other scope, `pubsub` included, is refused on every
  refresh. The only Google setup left is an OAuth client (a Cloud project with the Gmail API
  and a published consent screen).
- **Pub/Sub stays as an option.** With both settings the connector behaves as in ADR-016:
  - it renews the watch and pulls notifications;
  - it records each notification before acknowledging it;
  - it syncs every 300 seconds besides.
  The consent then needs `gateway gmail authorize --pubsub` and grants exactly
  `gmail.readonly` and `pubsub`.
- Health follows the mode. The connector's readiness has Pub/Sub and watch checks only with
  notifications. The connector records its mode and sync interval on the mailbox
  (`gmail_mailboxes.mode`, `sync_seconds`, migration `0009_gmail_mode`), so `gateway health`
  checks the watch only in Pub/Sub mode and judges freshness by that connector's own
  interval, also after the mode was switched.
- `GMAIL_SYNC_SECONDS` replaces ADR-016's `GMAIL_RECONCILE_SECONDS`; a connector started with
  the old name refuses to start instead of silently using the default.

## Consequences

- New mail reaches `@mail-follower` within the polling interval, not seconds. Every poll is
  one `history.list` call, far within Gmail's quota.
- The credential of a polling connector can do less than in ADR-016: it cannot touch Pub/Sub.
- Switching modes needs a new consent, since the scopes must match the mode exactly. The
  mailbox's cursor stays and continues where it was.
