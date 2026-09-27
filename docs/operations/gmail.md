# Gmail connector setup and operation

The Gmail connector wakes `@mail-follower` for every email that reaches one inbox
([ADR-016](../adr/016-gmail-connector.md), [ADR-017](../adr/017-gmail-polling-by-default.md)).
By default it polls the mailbox every minute and needs only an OAuth client that may read mail.
Pub/Sub push notifications are optional: they cut the delay to seconds, at the cost of a topic,
a subscription and a broader scope.

## OAuth client

Google issues OAuth clients per Cloud project, so one project is needed; nothing in it is
billed. In the [Google Cloud console](https://console.cloud.google.com/), signed in as the
mailbox's Google account:

1. Create a project (or pick one) and enable the **Gmail API** (APIs & Services, Library).
2. **OAuth consent screen**:
   - user type **External** (or Internal for a Workspace domain);
   - add yourself as a test user;
   - then **Publish app** to status **In production**. In "Testing" status Google issues
     refresh tokens that expire after seven days. An unpublished personal app shows the "Google
     hasn't verified this app" warning at consent; continue through **Advanced**.
3. **Credentials, Create credentials, OAuth client ID**, application type **Desktop app**. Note
   the client id and save the client secret to a file (mode 0600).

## Consent

The consent grants exactly `gmail.readonly`: reading mail. The connector refuses a token with
any other scope, so the token can never send, change or delete mail.

```bash
SECRETS=/run/secrets                 # locally e.g. ~/.agent-gateway/secrets (mode 0700)
export GMAIL_OAUTH_CLIENT_ID=<client id>
export GMAIL_OAUTH_CLIENT_SECRET_FILE=$SECRETS/gmail_oauth_client_secret
bun run gateway gmail authorize --out $SECRETS/gmail_refresh_token
```

The command prints Google's consent page, receives the answer on `http://127.0.0.1:<port>/`
and stores the refresh token (mode 0600). Open the page in a browser on the same machine. From
another machine, forward the port first (`ssh -L <port>:127.0.0.1:<port>`, with `--port <port>`
fixed). Running the command again replaces the token (rotation); restart the connector to use
it. Revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Running the connector

The connector needs the database with migrations applied and a controller (which delivers its
alerts and runs `@mail-follower`).

```bash
export DATABASE_URL=postgres://gateway:gateway@127.0.0.1:5432/gateway
export GMAIL_OAUTH_CLIENT_ID=<client id>
export GMAIL_OAUTH_CLIENT_SECRET_FILE=$SECRETS/gmail_oauth_client_secret
export GMAIL_REFRESH_TOKEN_FILE=$SECRETS/gmail_refresh_token
bun run dev:connector-gmail
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `GMAIL_MAILBOX_ID` | `primary` | the Gateway's name for the mailbox, used in event ids and sources; not the address |
| `GMAIL_OAUTH_CLIENT_ID` | required | the OAuth client |
| `GMAIL_OAUTH_CLIENT_SECRET` | required | its secret (use `_FILE`) |
| `GMAIL_REFRESH_TOKEN_FILE` | required | file written by `gateway gmail authorize`; read once at start (restart after re-authorizing), must be mode 0600 |
| `GMAIL_SYNC_SECONDS` | `60`, `300` with Pub/Sub | how often the history is read: the polling interval, or with Pub/Sub the sync that finds what a lost notification announced |
| `GMAIL_PUBSUB_TOPIC` / `GMAIL_PUBSUB_SUBSCRIPTION` | unset | both set: push notifications (see below) |
| `HEALTH_PORT` / `HEALTH_HOST` | `8082` / `127.0.0.1` | connector health endpoints |

On its first start the connector starts the cursor at the mailbox's present. Mail that was
already there is not replayed.

The cursor belongs to the Google account it was started with. A credential authorized for
another account is refused (alert, nothing is read). To switch accounts on purpose, run
`bun run gateway gmail reset <mailbox-id>` and restart the connector: it starts the mailbox
anew at the new account's present. Stored events stay.

## Optional: Pub/Sub push notifications

With notifications, new mail reaches the Gateway within seconds instead of within the polling
interval. They need a topic that Gmail publishes to and a subscription the connector pulls.
With the [gcloud CLI](https://cloud.google.com/sdk/docs/install), in the same project:

```bash
PROJECT=<project id>
gcloud config set project "$PROJECT"
gcloud services enable pubsub.googleapis.com
gcloud pubsub topics create gmail-inbox
gcloud pubsub topics add-iam-policy-binding gmail-inbox \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
# Unacknowledged notifications stay a week.
gcloud pubsub subscriptions create gmail-inbox-pull --topic=gmail-inbox \
  --ack-deadline=60 --message-retention-duration=7d
```

Then consent again with `--pubsub` (the token also gets the `pubsub` scope, and the connector
then refuses one without it) and set both settings:

```bash
bun run gateway gmail authorize --pubsub --out $SECRETS/gmail_refresh_token
export GMAIL_PUBSUB_TOPIC=projects/$PROJECT/topics/gmail-inbox
export GMAIL_PUBSUB_SUBSCRIPTION=projects/$PROJECT/subscriptions/gmail-inbox-pull
```

The account that authorizes needs `roles/pubsub.subscriber` on the subscription (a project
owner has it). The `pubsub` scope is as broad as that account's Pub/Sub permissions; a project
that holds nothing but this topic and subscription keeps it narrow. The connector then renews
the watch daily and records every notification before acknowledging it.

## What reaches the agent

Each inbox message becomes one `google.gmail.message.received` event, labelled
`external-untrusted`. The event holds the sender, recipients, subject, the body as plain text
and a description of each attachment (name, type, size). The body comes from the HTML part
when there is one (what a reader sees), converted to text, with scripts, styles, forms,
frames, media and hidden text removed. Spam, trash, drafts and chats are
skipped, and so is the owner's own sent mail. Mail moved into the inbox later (by a filter,
from the archive) counts when it arrives there, once per message. Attachment content is
never read.

`@mail-follower` (`config/examples/agents/mail-follower.yaml`) wakes on these events, sorts the
mail and posts to `#mail`. It has no tool that sends or forwards mail.

## Health and alerts

- `/health/ready` on the connector checks the database, the credential (`gmail_auth`) and the
  last sync (`gmail_sync`); with Pub/Sub also the pull (`pubsub`) and the watch
  (`gmail_watch`).
- `gateway gmail status` lists each mailbox's cursor, last sync and, with Pub/Sub, watch
  expiry and last notification; `gateway health` fails when a mailbox has not synced for
  three of its connector's sync intervals (the connector records its mode and interval) or,
  with Pub/Sub, its watch lapsed.
- Alerts in `#gateway-alerts`:
  - the credential was refused (revoked, expired, or with other scopes): run
    `gateway gmail authorize` again (with `--pubsub` when the connector uses Pub/Sub) and
    restart the connector;
  - with Pub/Sub: the watch cannot be renewed and expires within two days, or notifications
    cannot be pulled (for example a missing `roles/pubsub.subscriber`);
  - the history was gone and recent inbox mail was re-read (after the connector was down for
    about a week).

With Pub/Sub, lost or duplicate notifications need nothing: the periodic sync finds what a
lost notification announced, and a duplicate one changes nothing.
