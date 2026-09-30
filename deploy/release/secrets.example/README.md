# Secrets layout

Every secret is a file of its own, mode `0600`, owned by the user the services run as
(uid `10001`); each directory is mode `0700`. A service mounts only its own directory, at
`/run/secrets`, read-only. No value appears here or in `gateway.env`.

```text
$GATEWAY_HOME/secrets/
  postgres/                 owned by uid 70 (the PostgreSQL image's user)
    postgres_password         the database owner's password
  controller/               the controller and the CLI
    database_url              postgres://gateway:<password>@gateway-postgres:5432/gateway
    gateway_routing_key       written by `gateway mattermost bootstrap`
    mm_gateway_listener_token written by bootstrap
    mm_<agent>_token          one per agent, written by bootstrap
    console_password_hash     optional; written by `gateway console password set`, required
                              only once CONSOLE_ENABLED=true (ADR-023)
  worker-codex/
    database_url              written by `gateway db create-role` (a role limited to Codex jobs)
    codex_api_key             optional, with CODEX_API_KEY_FILE
  worker-claude-code/
    database_url              as for Codex
    anthropic_api_key         or claude_code_oauth_token
  worker-mock/                only for the smoke test
    database_url
  gmail/
    database_url              a copy of the controller's (the connector writes events)
    gmail_oauth_client_id
    gmail_oauth_client_secret
    gmail_refresh_token       written by `gateway gmail authorize`
  tool-runner/
    database_url              a role limited with `gateway db grant-tool-runner`
```

`bin/init-home.sh` creates the directories, the database password and the controller's
`database_url`; INSTALL.md walks through the rest.
