# Security policy

Agent Gateway runs AI agents with real permissions, so security defaults are fail-closed.

- Never commit credentials. Secrets are mounted as files under `/run/secrets/`. Example secret
  files (added with the deployment bundle) contain placeholders only.
- High-risk actions (payments, external sends, deploys, deletions) require human approval and
  cannot be authorized by prompt text.
- Ignore/suppression directives for linters and type checkers are not allowed.

Report vulnerabilities privately to the repository owner rather than in a public issue.

The threat model is maintained in [docs/security/threat-model.md](docs/security/threat-model.md).
