# Security Policy

## Reporting a vulnerability

Please do not disclose exploitable vulnerabilities in public issues. Contact the repository maintainer privately through the security contact configured in the GitHub repository's **Security** tab.

## Sensitive data

- Never commit API keys, tokens, private session transcripts, or local SQLite databases.
- Treat remote model processing as an external data transfer.
- Secret redaction is best-effort and is not a substitute for avoiding sensitive input.
- Back up `.orchestrator/orchestrator.sqlite` before upgrades or migrations.
