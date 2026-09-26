# Gmail connector setup and operation

The Gmail connector wakes `@mail-follower` for every email that reaches one inbox
([ADR-016](../adr/016-gmail-connector.md)). This guide covers the Google Cloud project, the
operator's consent and running the connector. It needs a Google account for the mailbox and a
Google Cloud project; the free tier covers one mailbox.

## Google Cloud project

With the [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in as the mailbox's
Google account (or an account that owns the project):

```bash
PROJECT=agent-gateway-mail           # an existing or new project id
gcloud projects create "$PROJECT"    # skip for an existing project
gcloud config set project "$PROJECT"
gcloud services enable gmail.googleapis.com pubsub.googleapis.com

# Gmail publishes the mailbox's changes to this topic.
gcloud pubsub topics create gmail-inbox
gcloud pubsub topics add-iam-policy-binding gmail-inbox \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher

# The connector pulls from this subscription. Unacknowledged notifications stay a week.
gcloud pubsub subscriptions create gmail-inbox-pull --topic=gmail-inbox \
  --ack-deadline=60 --message-retention-duration=7d
```

The account that authorizes the connector needs `roles/pubsub.subscriber` on the
subscription (a project owner has it). A project that holds nothing but this topic and
subscription keeps the connector's `pubsub` scope narrow.

## OAuth client

In the Google Cloud console, **APIs & Services**:

1. **OAuth consent screen**:
   - user type **External** (or Internal for a Workspace domain);
   - add yourself as a test user;
   - then **Publish app** to status **In production**. In "Testing" status Google issues
     refresh tokens that expire after seven days. An unpublished personal app shows the "Google
     hasn't verified this app" warning at consent; continue through **Advanced**.
2. **Credentials, Create credentials, OAuth client ID**, application type **Desktop app**. Note
   the client id and download the client secret.

## Consent

The consent grants exactly two scopes: `gmail.readonly` (read mail) and `pubsub` (pull the
notifications). The connector refuses a token with any other scope, so the token can never
send mail.

```bash
SECRETS=/run/secrets                 # locally e.g. ~/.agent-gateway/secrets (mode 0700)
export GMAIL_OAUTH_CLIENT_ID=<client id>
export GMAIL_OAUTH_CLIENT_SECRET_FILE=$SECRETS/gmail_oauth_client_secret
bun run gateway gmail authorize --out $SECRETS/gmail_refresh_token
```

The command prints Google's consent page, receives the answer on `http://127.0.0.1:<port>/`
and stores the refresh token (mode 0600). Open the page in a browser on the same machine. From
another machine, forward the port first (`ssh -L <port>:127.0.0.1:<port>`, with `--port <port>`
fixed). Running the command again replaces the token (rotation); restart the connector to use it. Revoke access at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Running the connector

The connector needs the database with migrations applied and a controller (which delivers its
alerts and runs `@mail-follower`).

```bash
export DATABASE_URL=postgres://gateway:gateway@127.0.0.1:5432/gateway
export GMAIL_OAUTH_CLIENT_ID=<client id>
export GMAIL_OAUTH_CLIENT_SECRET_FILE=$SECRETS/gmail_oauth_client_secret
export GMAIL_REFRESH_TOKEN_FILE=$SECRETS/gmail_refresh_token
export GMAIL_PUBSUB_TOPIC=projects/$PROJECT/topics/gmail-inbox
export GMAIL_PUBSUB_SUBSCRIPTION=projects/$PROJECT/subscriptions/gmail-inbox-pull
bun run dev:connector-gmail
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `GMAIL_MAILBOX_ID` | `primary` | the Gateway's name for the mailbox, used in event ids and sources; not the address |
| `GMAIL_OAUTH_CLIENT_ID` | required | the OAuth client |
| `GMAIL_OAUTH_CLIENT_SECRET` | required | its secret (use `_FILE`) |
| `GMAIL_REFRESH_TOKEN_FILE` | required | file written by `gateway gmail authorize`; read once at start (restart after re-authorizing), must be mode 0600 |
| `GMAIL_PUBSUB_TOPIC` | required | `projects/<project>/topics/<topic>` the watch publishes to |
| `GMAIL_PUBSUB_SUBSCRIPTION` | required | `projects/<project>/subscriptions/<name>` the connector pulls |
| `GMAIL_RECONCILE_SECONDS` | `300` | sync interval without notifications |
| `HEALTH_PORT` / `HEALTH_HOST` | `8082` / `127.0.0.1` | connector health endpoints |

On its first start the connector creates the watch and starts the cursor at the mailbox's
present. Mail that was already there is not replayed.

The cursor belongs to the Google account it was started with. A credential authorized for
another account is refused (alert, nothing is read). To switch accounts on purpose, run
`bun run gateway gmail reset <mailbox-id>` and restart the connector: it starts the mailbox
anew at the new account's present. Stored events stay.

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

- `/health/ready` on the connector checks the database, the credential (`gmail_auth`), the
  pull (`pubsub`), the watch (`gmail_watch`) and the last sync (`gmail_sync`).
- `gateway gmail status` lists each mailbox's cursor, watch expiry, last notification and last
  sync; `gateway health` fails when a watch lapsed or a mailbox has not synced for three
  sync intervals (15 minutes by default).
- Alerts in `#gateway-alerts`:
  - the credential was refused (revoked, expired, or with other scopes): run
    `gateway gmail authorize` again;
  - the watch cannot be renewed and expires within two days;
  - notifications cannot be pulled (for example a missing `roles/pubsub.subscriber`);
  - the history was gone and recent inbox mail was re-read (after the connector was down for
    about a week).

Lost or duplicate notifications need nothing: the periodic sync finds what a lost notification
announced, and a duplicate one changes nothing.
