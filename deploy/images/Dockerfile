# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
#
# The Gateway release images (see docs/operations/releases.md). Build from the repository root:
#
#   docker buildx build -f deploy/images/Dockerfile --target gateway \
#     --build-arg GATEWAY_VERSION=X.Y.Z --build-arg GATEWAY_COMMIT=<sha> .
#
# Targets:
#   gateway        controller, CLI, Gmail connector, tool runner and the mock worker
#   worker-codex   the worker with the Codex CLI and its code-mode host (Apache-2.0) and its
#                  bubblewrap (LGPL-2.0+)
#
# Every input is pinned: the base image by digest, Debian packages by version from a fixed
# snapshot, JavaScript dependencies by bun.lock, downloaded CLIs by checksum. Built with
# SOURCE_DATE_EPOCH and rewritten timestamps, the same inputs give the same image.

ARG BUN_IMAGE=oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
# Debian packages come from this snapshot of the archive, never from the moving mirrors.
ARG DEBIAN_SNAPSHOT=20260925T000000Z
ARG TARGETARCH

FROM ${BUN_IMAGE} AS base
ARG DEBIAN_SNAPSHOT
RUN printf '%s\n' \
		"Types: deb" \
		"URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
		"Suites: trixie trixie-updates" \
		"Components: main" \
		"Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp" \
		"" \
		"Types: deb" \
		"URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
		"Suites: trixie-security" \
		"Components: main" \
		"Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp" \
		> /etc/apt/sources.list.d/debian.sources

FROM base AS deps
ARG SOURCE_DATE_EPOCH
WORKDIR /opt/agent-gateway
COPY package.json bun.lock tsconfig.base.json LICENSE ./
COPY apps apps
COPY packages packages
COPY deploy/images/bin/ scripts/backup-gateway-db.sh /out/bin/
# Production dependencies only, exactly as locked; no install scripts run. Every file then
# gets the commit's time: the build rewrites only later timestamps, and a checkout's own
# timestamps must not reach the image.
RUN bun install --frozen-lockfile --production --ignore-scripts \
	&& rm -rf /root/.bun \
	&& test -n "${SOURCE_DATE_EPOCH}" \
	&& find /opt/agent-gateway /out -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM base AS gateway
# The PostgreSQL client tools serve `gateway backup check` (pg_restore) and the backup script.
# A snapshot's Release file has expired by design; its signature is still verified.
RUN apt-get -o Acquire::Check-Valid-Until=false update \
	&& apt-get install -y --no-install-recommends \
		postgresql-client-17=17.11-0+deb13u1 \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/cache/debconf/*-old \
		/var/cache/ldconfig/aux-cache
# One fixed unprivileged user for every service; the services refuse to run as root.
RUN groupadd --gid 10001 gateway \
	&& useradd --uid 10001 --gid 10001 --home-dir /home/gateway --create-home \
		--shell /usr/sbin/nologin gateway
COPY --from=deps /opt/agent-gateway /opt/agent-gateway
COPY --from=deps /out/bin/ /usr/local/bin/
ARG GATEWAY_VERSION
ARG GATEWAY_COMMIT
# A release image always knows its version: an image reporting 0.0.0 is a build error.
RUN test -n "${GATEWAY_VERSION}" && test -n "${GATEWAY_COMMIT}" \
	&& echo "${GATEWAY_VERSION}" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
ENV GATEWAY_VERSION=${GATEWAY_VERSION} \
	GATEWAY_COMMIT=${GATEWAY_COMMIT} \
	NODE_ENV=production \
	# Health endpoints listen inside the container network; Compose publishes none of them.
	HEALTH_HOST=0.0.0.0 \
	# Bun would write its transpiler cache next to the sources; the root filesystem is read-only.
	BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
	HOME=/home/gateway
LABEL org.opencontainers.image.title="agent-gateway" \
	org.opencontainers.image.description="Agent Gateway: controller, CLI, Gmail connector, tool runner" \
	org.opencontainers.image.source="https://github.com/laruss/agent-gateway-control" \
	org.opencontainers.image.licenses="MIT" \
	org.opencontainers.image.version="${GATEWAY_VERSION}" \
	org.opencontainers.image.revision="${GATEWAY_COMMIT}"
WORKDIR /home/gateway
USER 10001:10001
CMD ["gateway", "version"]

# The Codex CLI, per architecture: the release archive of openai/codex, checked by SHA-256.
# Releases build both, each on a runner of its own platform.
FROM scratch AS codex-amd64
ADD --checksum=sha256:aff46539a83aff86e3c62c592bce2c50d95391f9df289afaf03a50c01d14533d \
	https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-x86_64-unknown-linux-musl.tar.gz \
	/tmp/codex.tar.gz
ADD --checksum=sha256:74bb868f29e845da36ab287b88459a5fbb1fa4e16ff59837660312eaf0b33f3a \
	https://github.com/openai/codex/releases/download/rust-v0.156.1/bwrap-x86_64-unknown-linux-musl.tar.gz \
	/tmp/bwrap.tar.gz
ADD --checksum=sha256:a929daa9f6a0bddc00c0c9e6402df117b125acd96f9d554f6c99c32c7e66c608 \
	https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz \
	/tmp/code-mode-host.tar.gz

FROM scratch AS codex-arm64
ADD --checksum=sha256:558e12aaa6dacb335ec47240bf9721db8a54746806d64f01185a403f44f79b72 \
	https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-aarch64-unknown-linux-musl.tar.gz \
	/tmp/codex.tar.gz
ADD --checksum=sha256:42803e6a0f5557bb32fbef636aa9efa805eb5a108c28a670e83fd1a0e1c672aa \
	https://github.com/openai/codex/releases/download/rust-v0.156.1/bwrap-aarch64-unknown-linux-musl.tar.gz \
	/tmp/bwrap.tar.gz
ADD --checksum=sha256:40198138b03798ffa8c0da4c827a8ca5896774ea104b7110c2a2c0c7560cbe94 \
	https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz \
	/tmp/code-mode-host.tar.gz

FROM codex-${TARGETARCH} AS codex-archive

FROM base AS codex-files
COPY --from=codex-archive /tmp/codex.tar.gz /tmp/bwrap.tar.gz /tmp/code-mode-host.tar.gz /tmp/
ADD --checksum=sha256:d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc \
	https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/LICENSE /licenses/LICENSE
ADD --checksum=sha256:9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915 \
	https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/NOTICE /licenses/NOTICE
# bubblewrap as Codex builds it from its vendored sources (codex-rs/vendor/bubblewrap at the same
# tag): Codex falls back to a sandbox without /proc, which a container does not let it mount,
# only with its own build.
ADD --checksum=sha256:b7993225104d90ddd8024fd838faf300bea5e83d91203eab98e29512acebd69c \
	https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/codex-rs/vendor/bubblewrap/COPYING \
	/licenses/bubblewrap/COPYING
RUN mkdir /out && tar --no-same-owner -xzf /tmp/codex.tar.gz -C /out && tar --no-same-owner -xzf /tmp/bwrap.tar.gz -C /out \
	&& tar --no-same-owner -xzf /tmp/code-mode-host.tar.gz -C /out \
	&& mv /out/codex-code-mode-host-* /out/codex-code-mode-host \
	&& mv /out/codex-*-unknown-linux-musl /out/codex && mv /out/bwrap-* /out/bwrap \
	&& chmod 0755 /out/codex /out/bwrap /out/codex-code-mode-host \
	&& printf '%s\n' \
		"bubblewrap, built by OpenAI from https://github.com/openai/codex/tree/rust-v0.156.1/codex-rs/vendor/bubblewrap" \
		"(upstream https://github.com/containers/bubblewrap), licensed under the LGPL-2.0-or-later (COPYING)." \
		> /licenses/bubblewrap/SOURCE \
	&& mkdir -p -m 0700 /state/codex-home /state/workspaces

FROM gateway AS worker-codex
# bubblewrap confines the commands Codex runs (ADR-014); the worker's seccomp profile lets it
# create its namespaces (deploy/images/seccomp/worker-sandbox.json).
# Codex runs the model's commands through its code-mode host, which it looks for next to itself.
COPY --from=codex-files /out/codex /out/bwrap /out/codex-code-mode-host /usr/local/bin/
COPY --from=codex-files /licenses/ /usr/share/doc/codex/
# New volumes take the ownership of these directories: the worker's, mode 0700.
COPY --from=codex-files --chown=10001:10001 /state/ /var/lib/agent-gateway/
ENV WORKER_ADAPTER=codex \
	# The exact version this image was verified with; any other makes the runtime unavailable.
	WORKER_RUNTIME_VERSION=codex-cli/0.156.1 \
	WORKER_WORKSPACE_ROOT=/var/lib/agent-gateway/workspaces \
	CODEX_HOME=/var/lib/agent-gateway/codex-home
LABEL org.opencontainers.image.title="agent-gateway-worker-codex" \
	org.opencontainers.image.description="Agent Gateway worker with the Codex CLI" \
	org.opencontainers.image.licenses="MIT AND Apache-2.0 AND LGPL-2.0-or-later" \
	io.github.laruss.agent-gateway.runtime="codex-cli/0.156.1"
CMD ["gateway-worker"]
