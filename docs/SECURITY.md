# Security and privacy

The source includes best-effort redaction for recognized credentials and private tags. This is not a DLP system and cannot guarantee detection of all secrets.

Remote extraction sends transcript content to the configured provider when enabled. Review provider data policies and disable remote processing where required. Never commit runtime configs, API keys, user transcripts or SQLite databases.
