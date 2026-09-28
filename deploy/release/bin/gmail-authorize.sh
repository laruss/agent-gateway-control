#!/bin/sh
# Google's consent for the Gmail connector, from the release's gateway image:
#
#   bin/gmail-authorize.sh [--pubsub]
#
# Needs secrets/gmail/gmail_oauth_client_id and gmail_oauth_client_secret (the OAuth client of
# type "Desktop app"), and writes secrets/gmail/gmail_refresh_token. Google redirects the browser
# to http://127.0.0.1:$GMAIL_AUTHORIZE_PORT (default 8765) on this host: from another machine,
# forward the port first (`ssh -L 8765:127.0.0.1:8765 <this host>`), then open the printed URL.
set -eu
release_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home=${GATEWAY_HOME:-/srv/agent-gateway}
port=${GMAIL_AUTHORIZE_PORT:-8765}
image=$(jq -r .images.gateway "$release_dir/images.lock")
# The host's network only for the loopback callback; otherwise hardened like the stack.
exec docker run --rm -it --network host --user 10001:10001 --read-only --tmpfs /tmp \
	--cap-drop ALL --security-opt no-new-privileges:true \
	-v "$home/secrets/gmail:/run/secrets" \
	-e GMAIL_OAUTH_CLIENT_ID_FILE=/run/secrets/gmail_oauth_client_id \
	-e GMAIL_OAUTH_CLIENT_SECRET_FILE=/run/secrets/gmail_oauth_client_secret \
	"$image" gateway gmail authorize --port "$port" --out /run/secrets/gmail_refresh_token "$@"
