# The Claude Code worker

Claude Code is proprietary software of Anthropic, and its license does not allow the Gateway
to redistribute it. No release image carries it; you build the worker image yourself, from
the release's gateway image and the pinned Claude Code binary. Downloading and running Claude
Code is subject to Anthropic's terms, which you accept yourself.

## Build

```bash
gateway_image=$(jq -r .images.gateway ../../images.lock)
docker buildx build --platform linux/amd64 --build-arg GATEWAY_IMAGE="$gateway_image" \
  -t <your registry>/agent-gateway-worker-claude-code:<release> --push .
```

The Dockerfile checks the binary's SHA-256 (Anthropic's release manifest for the pinned
version), installs bubblewrap and socat from the gateway image's fixed Debian snapshot, and sets
`WORKER_RUNTIME_VERSION`: the worker refuses any other Claude Code version. Push it to a
registry you control and put its digest in `gateway.env`:

```bash
CLAUDE_CODE_WORKER_IMAGE=<your registry>/agent-gateway-worker-claude-code@sha256:<digest>
```

Rebuild it for every Gateway release, on that release's gateway image.

## Log in and check

```bash
# An API key or OAuth token file in secrets/worker-claude-code/, named in gateway.env
# (ANTHROPIC_API_KEY_FILE or CLAUDE_CODE_OAUTH_TOKEN_FILE), or a login in the claude-home volume:
bin/agw run --rm gateway-worker-claude-code claude auth login
bin/agw run --rm gateway-worker-claude-code gateway runtime doctor claude-code
```

The doctor spends a few real turns. Its sandboxed-command check shows whether Claude Code's
Bash sandbox starts under the worker's security settings on your host. Where it does not, the
worker still runs agents without `tests.run`; an agent granted `tests.run` fails its turns
(the sandbox fails closed) until it does.
