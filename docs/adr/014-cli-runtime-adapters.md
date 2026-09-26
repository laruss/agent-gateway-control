# ADR-014. CLI runtime adapters: confined processes, policy-mapped tools, optional sessions

- Status: Accepted
- Date: 2026-09-26

## Context

Codex and Claude Code are agent CLIs. They run a model that can call built-in tools, such as a
shell, file edits and web search, and they keep conversation history on disk. The Gateway
needs three things from them:

- one structured result per turn;
- a hard stop at the run's deadline or on cancellation;
- work confined to what the agent's policy grants.

A worker has credentials of its own, such as the database URL and its queue role. The model
must never see them, whatever the prompt says. Provider sessions make turns cheaper, but they
must never become the source of truth.

## Decision

- **Non-interactive CLIs, not SDKs or app servers.** Codex runs through `codex exec --json`
  with `--output-schema`. Claude Code runs through `claude -p --output-format json` with
  `--json-schema`. Both adapters work the same way:
  - the prompt goes to stdin, the result comes back on stdout;
  - there are no extra dependencies;
  - there is no long-lived server to secure.

  `modelOutputJsonSchema()` is accepted by both CLIs. Claude Code rejects the `$schema` key, so
  its adapter removes it. Zod still validates every result (ADR-009, ADR-010).
- **One process group per call.** A turn runs as its own process group
  (`runtime-sdk/process.ts`). On deadline, cancellation or kill-all the adapter sends SIGTERM to
  the whole group, then SIGKILL after a grace period. This stops shells and test runners the
  model started. `cancel(runId)` resolves only once the group is gone. Output is bounded per
  stream.
- **A clean environment.** The runtime process gets only `PATH`, `HOME`, the locale, `TMPDIR`,
  `TZ` and `USER`, plus the adapter's own variables: `CODEX_HOME`, `CODEX_API_KEY`,
  `CLAUDE_CONFIG_DIR` and the Anthropic credentials. Nothing else of the worker's environment
  reaches it. Credentials also stay out of the commands the model runs:
  - Codex commands inherit only the core variables (`shell_environment_policy.inherit=core`);
  - Claude Code scrubs credentials from Bash when Bash is granted
    (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which on Linux needs bubblewrap and fails closed
    without it).
- **No user customizations.**
  - Codex runs with `--ignore-user-config --ignore-rules --strict-config`. That still lists
    skills (the operator's and any in the workspace), so `skills.include_instructions=false` is
    set, and `project_doc_max_bytes=0` stops `AGENTS.md` from loading: a file written by an
    earlier call (the repair turn runs in the same workspace) never becomes instructions.
    Connectors, plugins, browsers, computer use, sub-agents, hooks, image generation and
    `view_image` (which reads files outside the command sandbox) are disabled by name; `--strict-config` rejects an unknown name, so an adapter is pinned to the
    CLI versions it was verified with.
  - Claude Code runs with `--safe-mode`, which drops CLAUDE.md, skills, plugins, hooks and MCP,
    plus `--strict-mcp-config` and `--disable-slash-commands`.
- **One workspace per attempt.** The worker creates `<root>/<agent>/run-<id>-<attempt>`
  (mode 0700, always empty) before the turn and removes it afterwards. The root and the agent
  directory must be real directories owned by the worker user. The runtime works only there:
  - Commands the model runs are confined by the OS sandbox, not only by the environment:
    - Codex runs them under a permission profile (`default_permissions`): system paths
      (`:minimal`) readable, the workspace readable (writable with `workspace.write` or
      `tests.run`), and
      everything else unreadable, including `/tmp`, `$TMPDIR`, the home directory and
      `CODEX_HOME` with the login. There is no network.
    - Claude Code runs Bash in its sandbox (`--settings`, `failIfUnavailable`, no unsandboxed
      retry). The home directory, `CLAUDE_CONFIG_DIR`, the workspace root with other runs and
      `/run/secrets` are unreadable; writes go only to the workspace; there is no network.
    - Temporary files stay private to the call. Codex commands get `<workspace>/.tmp` as
      `TMPDIR` (`shell_environment_policy.set`). Claude Code gets a short per-call
      `/tmp/agw-*` directory, removed afterwards, as `TMPDIR` and `CLAUDE_CODE_TMPDIR`: for a
      long path it would hand Bash the shared `/tmp/claude-<uid>` instead. The rest of `/tmp`
      and the worker's `$TMPDIR` are unreadable to Claude's Bash.
  - Claude Code's file tools are confined to the workspace by `--restricted`.

  Git worktrees per run, and capturing their diffs, come with repository configuration later.
- **Built-in tools come from the Gateway tool policy** (`nativeToolGrants`). Access is
  fail-closed: anything not granted is denied.

  | Gateway tool | Codex | Claude Code |
  |---|---|---|
  | `repository.read` | workspace readable (no shell: see below) | Read, Grep, Glob |
  | `workspace.write` (implies read) | workspace writable (file edits) | Edit, Write, NotebookEdit |
  | `tests.run` (implies read; commands write the workspace) | shell | Bash (sandboxed) |
  | `web.search` | `web_search=live` | WebSearch |
  | `web.fetch` | none | WebFetch |

  Codex reads files only through its shell, and a shell runs any program, so it gets one only
  with `tests.run` (`--disable shell_tool --disable unified_exec` otherwise): `repository.read`
  alone gives a Codex agent no file access. An explicit deny or approval of `repository.read`
  withholds writing and commands too, and one of `workspace.write` withholds commands.
  Claude Code gets only the granted tools (`--tools`, `""` for none), and
  `--permission-mode dontAsk --permission-prompts none` denies everything else. The prompt names the granted built-in tools in plain words.
  Posting, memory, mail and finance never become runtime tools: they go through
  the structured result and the Gateway.
- **Sessions are an optional cache.** Under `resumable-if-available` the controller offers the
  agent's stored session in the run job, but only for the same configuration version and the
  same conversations (the trigger's and those of every carried inbox event) it was stored for: a transcript holds everything its earlier
  turns saw. The worker uses it only when all of these hold:
  - it came from the same adapter and the same runtime version;
  - it has not expired (the adapters set seven days).

  When a resumed call fails for any reason other than cancellation (the session is gone,
  corrupt or too long, or the CLI reports it in an unknown way), the turn starts fresh. The input always carries the full canonical context, so nothing is lost.
  Under `stateless` nothing is kept (`--ephemeral`, `--no-session-persistence`). A repair turn
  always starts fresh.
- **Preflight.** `gateway runtime doctor <adapter>` configures the adapter like its worker and
  checks:
  - installation, exact version and login (without printing the account);
  - a real structured turn;
  - a granted command in the sandbox: it must copy a word from a workspace file into a new
    file, which only a shell can do. This fails where the sandbox cannot start, and warns when
    the command's temp directory outlives the call;
  - cancellation;
  - session resume;
  - policy risks.

  A worker refuses to start when its probe fails. The doctor must pass on the deployment host
  (the sandboxes differ between macOS and Linux; this phase was verified on macOS) before an
  agent is granted `tests.run`.
- **Tests.**
  - Every adapter passes the shared contract suite against a fake CLI, a bun script with the
    real wire format. This covers invalid output, timeout, the process group and the
    environment without a provider.
  - The live suite (`bun run test:live`) runs the doctor, a structured wait, workspace
    isolation and the tool allowlist against the real CLI. It spends real turns, so it runs only
    on demand.

## Consequences

- Granted commands can still read system paths. Codex allows a list (`:minimal`). Claude Code
  denies a list: everything but the home, config, secrets, temp and workspace-root
  directories stays readable, so a Claude worker must not share its user with credentials
  kept elsewhere (for example a `CODEX_HOME` outside the home). Secrets belong in the denied places only;
  the probe reports this as a policy risk. On Linux both sandboxes need their dependencies
  (bubblewrap); Claude Code refuses to start without them.
- `tests.run` on Codex runs with system paths only, so toolchains outside them (for example
  under the home directory) are not available to it.
- The adapters depend on CLI flags that change between versions. `--strict-config`, the
  contract suite and the doctor catch a breaking upgrade. Pin the CLI versions in worker images.
- Provider session files hold earlier prompts. They live in the adapter's `CODEX_HOME` or
  `CLAUDE_CONFIG_DIR`, which must be private to the worker.
- A command that starts a new session (`setsid`) escapes the process-group kill and can keep
  running, sandboxed, after its run ended. Only a per-run cgroup or container stops it
  (Phase 8).
- There is one stored session per agent and adapter. Interleaved conversations replace each
  other's session, so a resume hits only when the agent's previous run was in the same
  conversation (the scope check keeps this safe).
- Grants are coarse: `tests.run` means any command, not only tests. Finer command policies
  belong to the Tool Broker (Phase 7).
