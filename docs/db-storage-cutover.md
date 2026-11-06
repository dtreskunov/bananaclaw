# Offline timestamp storage cutover

## Detect

This release uses `PRAGMA user_version=1` for the central, host inbound/outbound,
runner-state and native-provider stores; search uses version **2** (version 1
was the message-occurrence schema). An existing store with an older or unknown
version is refused, not migrated at startup. The error links to this page.
Fresh stores initialize directly. Never “fix” the error by setting the pragma.

Maintained SQL time instants are **INTEGER UTC epoch milliseconds**, including
timestamps, due/expiry times, claims, audit dates, activity and fork cut points.
ISO strings remain the public record/session-link representation. Activity
frames retain their historical decimal epoch-string `ts`. IDs, durations,
cron expressions, timezones and provider message JSON are not converted.

## Why

Mixed SQLite UTC strings and ISO timestamps compared lexically or via
`datetime(column)` lose precision and prevent indexed range scans. Changing a
column's declared type alone also leaves TEXT values in SQLite. This cutover
rebuilds the real tables and validates every instant before binding integers.
Integer type checks reject older writers; session-link **v6** rejects v5
runners rather than letting an incompatible image continue silently.

## Fix — explicit offline maintenance window

Do not run this against a live installation.

1. Stop the installation's host service **and every runner/sidecar/container**.
   Disable automatic restart until verification or rollback is complete.
   Keep the previous checkout and container image for rollback.
2. Resolve existing FK failures and any earlier activity-order cutover first;
   do not erase invalid rows. The tool applies pending central migrations only
   to its private candidate, before converting timestamps. Invalid domain
   values or duplicate identities/routes abort the cutover without changing
   the original. No intermediate release or service startup is needed.
3. Inventory **every** SQLite store: `v2.db`, optional `search.db`, each
   session's `inbound.db`, `outbound.db`, `runner-state/runner-state.db`, and each
   native provider's `native-state/native-state.db`. Include dormant and
   archived sessions that may be restored. Do not invent missing native files
   for other providers. The tool never discovers or opens runner/native stores
   on behalf of the host.
4. Create an explicit JSON inventory (paths below are examples, not defaults):

   ```json
   [
     {"kind":"central","path":"/installation/data/v2.db"},
     {"kind":"search","path":"/installation/data/search.db"},
     {"kind":"inbound","path":"/installation/data/v2-sessions/group/session/inbound.db"},
     {"kind":"outbound","path":"/installation/data/v2-sessions/group/session/outbound.db"},
     {"kind":"runner-state","path":"/installation/data/v2-sessions/group/session/runner-state/runner-state.db"},
     {"kind":"native","path":"/installation/data/v2-sessions/group/session/native-state/native-state.db"}
   ]
   ```

5. From the new checkout, execute:

   ```sh
   pnpm exec tsx scripts/cutover-db-storage.ts \
     --plan ./cutover-plan.json --backup-dir ./backups/epoch-cutover \
     --service-stopped --runners-stopped
   ```

   Both stop acknowledgements and a **new** backup directory are mandatory.
   The acknowledgements are operator assertions, not a way to stop processes.
   The tool validates store kinds, versions, dates, pending event payloads, FKs
   and integrity; creates SQLite backups; converts adjacent candidate files;
   compares table row counts and checks FKs/integrity again. Search is rebuilt
   against preserved occurrence rowids and FTS integrity is checked.
   **Every candidate must pass before any original is replaced.**
   Backups and `manifest.json` persist. Surviving journal sidecars abort
   activation; never delete a live writer's WAL/journal to bypass this check.

The only accepted old TEXT instant formats are explicit-zone ISO (millisecond
precision or less), historical SQLite `YYYY-MM-DD HH:MM:SS[.sss]` (UTC), and
decimal epoch strings for activity. Invalid calendar dates, missing-zone ISO,
date-only strings and fractional millisecond values fail. Repair source data
from trustworthy evidence, then retry with a new backup directory. No row is
dropped, date defaulted, or malformed fixture spelling silently normalized.
Pending durable JSON payloads stay wire-compatible strings; journal sequence
high-water marks and acknowledgements survive.

## Verify

While still stopped:

```sh
pnpm exec tsx scripts/q.ts /installation/data/v2.db "PRAGMA user_version"
pnpm exec tsx scripts/q.ts /installation/data/v2.db "PRAGMA integrity_check"
pnpm exec tsx scripts/q.ts /installation/data/v2.db "PRAGMA foreign_key_check"
pnpm exec tsx scripts/q.ts /installation/data/v2.db \
  "SELECT typeof(created_at), count(*) FROM users GROUP BY typeof(created_at)"
```

Expect version `1` (`2` for search), integrity `ok`, zero FK rows and only
`integer` for non-null instants. Repeat for **every** inventory entry, including
runner/native stores, and sample their timestamp columns with `typeof`.
Check backup manifest paths/counts against the inventory. Rebuild the runner
image using this checkout before resuming the service; never resume old
containers. Then verify due scheduling, expiry, thread history/forks/search,
and pending durable replay/ACKs without duplicate delivery. The optional
search backfill recovers occurrences previously suppressed by the legacy
search identity; it is not a substitute for the storage cutover.

## Rollback

Stop host and all runners again. Restore **all** inventory entries from the
same backup manifest, not just central DB or only one journal projection.
Remove candidate files left by an interrupted conversion only after confirming
no process is using them. Restore the preceding checkout **and runner image**
before restarting. Never run old binaries against the converted files.
Restoring a snapshot after new traffic discards post-cutover changes; preserve
the new files separately if those changes need manual recovery.
