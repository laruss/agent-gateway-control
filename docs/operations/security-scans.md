# Security scans

The `security` workflow (`.github/workflows/security.yml`) runs on every push to `main`, on
pull requests, daily, and by hand. Any finding, and any scanner error, fails it.

| Job | Tool | What it checks |
|-----|------|----------------|
| `gitleaks` | [Gitleaks](https://github.com/gitleaks/gitleaks) | Secrets in the whole git history (not only the latest tree). Findings are redacted in the log. |
| `osv` | [OSV-Scanner](https://google.github.io/osv-scanner/) | Known vulnerabilities in `bun.lock`, development dependencies included, and every package's license against an SPDX allowlist. |

Both scanners are downloaded as release binaries pinned by version and checked against their
SHA-256 before they run. Every GitHub Action in every workflow is pinned by commit SHA, with
the release tag in a comment.

## Allowed licenses

`MIT`, `Apache-2.0`, `ISC`, `BSD-3-Clause`, `BlueOak-1.0.0`, `CC0-1.0`, `Unlicense` (the
`ALLOWED_LICENSES` variable of the workflow). A package whose license is unknown, or not on the
list, fails the scan until it is excepted. Adding a license to the list is a decision about
every future dependency; prefer an exception for one package.

## Running the scans locally

Download the same versions as the workflow (`GITLEAKS_VERSION`, `OSV_SCANNER_VERSION`) from
the tools' GitHub releases, outside the repository, and verify the checksum. Then, from the
repository root:

```bash
gitleaks git --redact --no-banner .
osv-scanner scan source --config osv-scanner.toml --lockfile bun.lock \
  --licenses="MIT,Apache-2.0,ISC,BSD-3-Clause,BlueOak-1.0.0,CC0-1.0,Unlicense"
```

`gitleaks dir --redact <path>` scans files that are not committed yet.

## Exceptions

An exception is a reviewed decision, written down next to the scanner's configuration with its
reason. Never except a real secret: rotate it, then remove it from history.

- **A vulnerability** that does not apply: an `[[IgnoredVulns]]` entry in `osv-scanner.toml` with
  the advisory `id`, a `reason` saying why it does not apply here, and an `ignoreUntil` date at
  most three months ahead. When it expires, the scan fails again and the exception is reviewed
  (upgrade, or renew with a fresh reason).
- **A license** the scanner reads wrong (a legacy `licenses` field) or a package accepted by
  review: a `[[PackageOverrides]]` entry naming the package, with `license.override` (the real
  license) or `license.ignore`, and a `reason`.
- **A Gitleaks false positive** (a test fixture shaped like a token): prefer changing the fixture
  so it no longer looks like a real token. Otherwise add a `.gitleaks.toml` that extends the
  default rules (`[extend] useDefault = true`) with an `[[allowlists]]` entry limited to that
  path and pattern, and a description. A fixture already in the history cannot be changed
  there: after changing it, list that one finding's fingerprint
  (`<commit>:<file>:<rule>:<line>`, shown by `--report-format json`) in `.gitleaksignore` with
  a comment. Any other finding, in the same file too, still fails the scan.

Current exceptions (see `osv-scanner.toml` for the reasons):

- `GHSA-67mh-4wv8-2f99`: esbuild 0.18, reached only through `drizzle-kit` in development;
  expires 2026-12-31.
- The workspace packages (`@agent-gateway/*`) are MIT, like the repository.
- `ssh2`, `cpu-features`, `buildcheck`: MIT, declared in a legacy field.
- `lightningcss`: MPL-2.0, a development-only build tool of vite (used by vitest), unmodified
  and not shipped.
- `.gitleaksignore`: a fake JWT fixture in `packages/logging/src/redaction.test.ts` at commit
  `981a5de`; the fixture is now assembled at runtime.
