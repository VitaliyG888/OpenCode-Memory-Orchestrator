# Database and backups

The shared Core owns `.orchestrator/orchestrator.sqlite`. Both plugins should acquire the shared client rather than create independent SQLite connections.

Before upgrading, back up the database and preserve its directory. Do not delete the database to troubleshoot plugin installation. Schema changes must be tested against a copy of an existing database.
