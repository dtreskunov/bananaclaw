# Timestamp storage versions and archived cutover

## Current contract

Maintained SQLite instants, internal host records and UI protocol 17 timestamps
are checked INTEGER UTC epoch milliseconds. CLI dates and session-link journals
retain ISO strings; activity frames retain decimal epoch strings. Recurrence
expressions, timezones and durations are not timestamps.

Central, host-session and runner-state stores now use `PRAGMA user_version=2`
after the [reply-suggestions cutover](reply-suggestions-cutover.md).
Native-provider stores remain version `1`; search uses version `2`. Empty stores initialize the
current schema directly. Populated older stores and unknown future versions
are refused without conversion. Never bypass that refusal by setting a pragma.

The one-time offline cutover is complete. Its CLI, table-rewriting helpers and
legacy search converter have been retired from this checkout. Normal startup
and fresh installs do not need them.

The archive JSON format is a separate import/export boundary. Current version-4
archives contain numeric row dates and approval-only interactions. Complete
numeric version-3 exports require the archived reply-suggestions converter.
Earlier string-date archives are not
converted: restore explicitly rejects them before committing rows or renaming
folders. Inspect `archive.json` for string-valued row instants such as
`agent_group.created_at`; `archived_at` is intentionally ISO metadata.
To restore an older archive, use its matching previous host revision in a
separate offline installation. Do not copy legacy strings into current stores.
Verify a current archive/restore round trip retains numeric dates, epoch zero
and null values; failed legacy restores must leave the archived files intact.
Keep untouched archives and their matching previous code for rollback.

## Older installations

Use the archived cutover implementation at Git revision `905c08ad6` in a
separate checkout before deploying this revision. Its complete inventory,
stopped-host/stopped-runner acknowledgements, backup, preflight, verification
and rollback procedure remain available with:

```sh
git show 905c08ad6:docs/db-storage-cutover.md
```

Follow that revision's instructions with the host and every runner stopped.
The archived tool validates private candidates before replacing originals and
retains backups. Do not mix old binaries with converted databases or attempt
a live cutover. Its timestamp conversion targets storage version 1; complete
the subsequent reply-suggestions cutover before running the current host.

## Verify and roll back

Check `PRAGMA user_version`, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`
and `typeof()` on maintained timestamp columns. Expect the version above,
integrity `ok`, zero FK violations and `integer` for non-null instants.

Existing backup manifests and their database snapshots must be retained for
rollback; removing code does not remove backups. Stop host and every runner
before restoring **all** inventory entries from one manifest, together with the
matching previous host and runner source/image. Never restore only one side of
a session journal. Restoring a pre-cutover snapshot discards newer traffic;
preserve the current files separately if those changes need manual recovery.
