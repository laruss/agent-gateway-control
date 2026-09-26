# ADR-015. Grok, Kiro, OpenCode and Hermes: tools only where confined; runtime health

- Status: Accepted
- Date: 2026-09-26

## Context

Four more agent CLIs join Codex and Claude Code (ADR-014): Grok Build (`grok`), the Kiro CLI
(`kiro-cli`), OpenCode with its Go subscription (`opencode`) and Hermes Agent (`hermes`). Each
has a headless mode. None confines its tools the way Codex and Claude Code do, as verified with
the installed versions:

- **Grok** sandboxes the whole CLI process, not each command. Its file tools and commands can
  read whatever the CLI reads, including its login in `GROK_HOME`. On macOS it cannot block a
  command's network, and its `strict` profile does not start where `/var/run/docker.sock` is a
  symlink.
- **Kiro** has no OS sandbox (its own is internal only). Its path settings (`allowedPaths`,
  `permissions.rules`) did not stop `read` from reading files outside the workspace.
- **OpenCode** has no OS sandbox. Its shell's children leave the process group, so a kill does
  not reach them. Its file tools honour `external_directory: deny`.
- **Hermes** runs terminal and file tools on the host. Reads are not restricted, and commands
  start their own sessions.

A failing runtime must also affect only its own agents, never the controller or other
workers, and the operator must see which runtime version each agent runs on.

## Decision

- **A built-in tool is granted only where the runtime confines it.** Every adapter declares
  `capabilities.confinedTools`. `confinedGrants` removes every other grant, whatever the
  policy says, and the prompt describes the removed tools as not available. The probe lists
  them as a policy risk, and the doctor skips the command check where commands are withheld.

  | Runtime | Granted built-in tools | Why the others are withheld |
  |---|---|---|
  | Codex, Claude Code | all (ADR-014) | |
  | Grok | web search, web fetch | file tools and commands can read the login |
  | Kiro | web search, web fetch | path rules do not confine the file tools |
  | OpenCode Go | read, write, web search, web fetch | its shell has no sandbox |
  | Hermes | web search (+ fetch with search) | tools run on the host unconfined |

  A tool that must not be offered is also named in the runtime's own deny list (Grok
  `--disallowed-tools`, OpenCode `permission`, Hermes `agent.disabled_toolsets`), in case a
  later CLI version ignores the allowlist. Grok's empty `--tools` means every tool, so "no
  tools" is one web tool that is then disabled.
- **The same isolation as ADR-014 otherwise.** Each call runs:
  - in its own process group, with a clean environment, in the run workspace;
  - with a home directory owned by the Gateway, never the operator's: `GROK_HOME`,
    `KIRO_HOME`, `OPENCODE_HOME`, `HERMES_HOME`. Before every call the adapter brings its
    configuration there to the expected content, atomically (`writeRuntimeFile`: a CLI starting
    at that moment never reads a missing or partial file), so no rules files, skills, plugins,
    MCP servers, hooks, memory, sub-agents, updates or telemetry load;
  - with an empty `HOME` of its own for Grok and Hermes, which would otherwise read the
    operator's Claude Code or Codex files;
  - for Hermes, without borrowing other CLIs' logins (`auth.adopt_external_logins: false`);
  - for Kiro, with the agent engine pinned (`v2`). Should the CLI still fall back to its
    default agent, the turn fails and its output is discarded;
  - for OpenCode, with the model always named: an agent without `runtime.model` uses
    `OPENCODE_MODEL`, and a turn without either fails instead of letting the CLI pick another
    provider. A workspace inside a git checkout is refused, since OpenCode's file tools may
    reach the whole checkout.
- **Structured output.**
  - Grok takes the result schema natively. Its constrained decoding matches a `pattern`
    against the whole string, so unanchored patterns are removed first
    (`withoutUnanchoredPatterns`; with `\S` every string became one character).
  - Kiro, OpenCode and Hermes have none (OpenCode's server option fails in 1.18.31). The
    prompt already carries the schema; `parseJsonAnswer` reads the final message, also inside
    a code fence, and validation plus the one repair apply as for every runtime.
- **Sessions.**
  - Grok, Kiro and Hermes resume by id from another working directory.
  - OpenCode does not: a resume from another directory hangs, and every attempt has its own
    workspace. Its adapter has `sessionResume: false` and deletes each turn's session.
  - Only a session handed back to the Gateway is kept: the adapters delete a new session
    whenever the turn stores none (stateless policy, a failure, a timeout or a cancel). Grok
    gets the id of a new session from the adapter, so its transcript is always found; Kiro and
    Hermes find it by the id in the CLI's output. The first session of a repaired turn and
    sessions the Gateway no longer offers expire: Grok removes idle sessions after seven days,
    and the Kiro and Hermes adapters prune sessions past the session lifetime on every probe.
- **Runtime health.**
  - A worker no longer exits when its probe fails. It reports `worker_status` heartbeats
    (`ready`, `unavailable`, `stopped`, with the runtime version and the probe detail) on its
    adapter's report queue, so it speaks only for that adapter. It takes jobs only while the
    probe passes, and probes again: every heartbeat while unavailable, every five minutes
    while ready (every minute with a pinned version).
  - The controller keeps the last heartbeat per worker (`runtime_workers`), dated by when the
    worker queued it: a late or out-of-order heartbeat never overrides a newer one, and one
    older than the stale window is ignored. An adapter is available when a worker of it
    reported `ready` within three heartbeats (90 s). A probe that throws counts as failed, and a
    ready worker whose runtime changes version takes jobs anew under the new version.
  - An enabled agent whose adapter is unavailable is **degraded**: `gateway agents list|show`,
    `gateway runtimes list` and `gateway health` show it. Its runs wait in its adapter's queue;
    nothing else changes. A change of availability is settled, and alerted once, only after it
    lasted 60 s (`runtime_availability.pending_since`), so a restart, a deploy or one failed
    probe raises nothing. Heartbeats and sweeps decide under one lock per adapter, and the
    alert key names the state that ended, so concurrent controllers never alert twice.
- **Pinned versions.** `WORKER_RUNTIME_VERSION` names the exact runtime version a worker was
  verified with. A different version makes the runtime unavailable instead of running an
  untested CLI. Every run records the version it ran on (ADR-011), and the heartbeats show the
  version of each worker.

## Consequences

- Agents on Grok, Kiro or Hermes cannot read or change a repository. Give them research,
  review of posted content and coordination work, or run them where a later phase confines
  them (a container per run, Phase 8).
- Web fetch runs on the worker host: it cannot read local files (Grok, Kiro and OpenCode refuse
  `file:` URLs, and none of the four returned a local file in the live suite), but it reaches the host's loopback and private addresses. Services there
  must require authentication, as the Gateway's own do.
- OpenCode's file tools are confined by its own permission check, not by the kernel. This is
  weaker than Codex and Claude Code, and the probe reports it.
- The adapters depend on CLI behaviour that changes between versions: Grok's empty tool
  list, Kiro's engines, OpenCode's session files. Pin the versions and run the doctor and the
  live suite before upgrading.
- Kiro meters credits, not tokens: its runs record no token usage. OpenCode Go and Hermes
  report no cost.
- A worker with a failing probe stays up; the heartbeat, the alert and `gateway runtimes list`
  show the failure. Only a worker that cannot remove a subscription it must drop cancels its
  turns and exits, and relies on its supervisor to start a clean one.
- Kiro reads agent definitions in the working directory (`.kiro/`) before `KIRO_HOME`. Today's
  workspaces start empty and Kiro agents cannot write files; workspaces with repository
  content must first refuse or remove such directories.
