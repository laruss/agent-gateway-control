# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
#
# The Claude Code worker, built by the operator (see README.md): Claude Code is proprietary and
# is not redistributed in a release image. This adds the pinned Claude Code binary, checked by
# SHA-256, to the release's gateway image.
#
#   docker buildx build --build-arg GATEWAY_IMAGE=<gateway image from images.lock> \
#     -t <your registry>/agent-gateway-worker-claude-code:<release> --push .

ARG GATEWAY_IMAGE
ARG TARGETARCH

FROM scratch AS claude-amd64
ADD --checksum=sha256:1859583ce32920595c61ef868bee52e1b1594f7486db209935e01f1e5e804ae2 \
	https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.283/linux-x64/claude \
	/claude

FROM scratch AS claude-arm64
ADD --checksum=sha256:346d294f0103d6fc0de11ac953579b5c62dfa90698a4cfc486b6f927c615e697 \
	https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/2.1.283/linux-arm64/claude \
	/claude

FROM claude-${TARGETARCH} AS claude

FROM ${GATEWAY_IMAGE}
USER root
# bubblewrap and socat back Claude Code's Bash sandbox; the gateway image's apt sources are a
# fixed Debian snapshot.
RUN apt-get -o Acquire::Check-Valid-Until=false update \
	&& apt-get install -y --no-install-recommends \
		bubblewrap=0.12.0-1~deb13u1 socat=1.8.0.3-1+deb13u1 \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/cache/debconf/*-old \
		/var/cache/ldconfig/aux-cache \
	&& install -d -m 0700 -o 10001 -g 10001 /var/lib/agent-gateway/claude-home \
		/var/lib/agent-gateway/workspaces
COPY --from=claude --chmod=0755 /claude /usr/local/bin/claude
ENV WORKER_ADAPTER=claude-code \
	WORKER_RUNTIME_VERSION=claude-code/2.1.283 \
	WORKER_WORKSPACE_ROOT=/var/lib/agent-gateway/workspaces \
	CLAUDE_CONFIG_DIR=/var/lib/agent-gateway/claude-home
LABEL org.opencontainers.image.title="agent-gateway-worker-claude-code" \
	io.github.laruss.agent-gateway.runtime="claude-code/2.1.283"
USER 10001:10001
CMD ["gateway-worker"]
