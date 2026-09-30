# Downgrading to session-link v3

Session link v4 and conversation protocol v1 (durable turns) have no in-place
downgrade and no upgrade path: the one-time v3→v4 migration tooling has been
removed. Going back to v3 means restoring the pre-cutover snapshot and running
the last v3 code. **Everything written after the cutover is discarded**
(messages, turns, usage, sessions created since).

| Item | Value |
| --- | --- |
| Code | tag `v3-session-link-final` (`b2f41fd0`) |
| Snapshot | `~/nanoclaw-backups/pre-v4-cutover-20260930T051132Z.tar.gz` |
| Checksum | same path + `.sha256` |
| Snapshot contents | `data/`, `dist/`, `.env`, `groups/` (taken with the service stopped) |

There is only one copy of the snapshot. Do not delete it while a downgrade may
still be needed.

## Procedure

Run from the checkout root.

1. Stop the host, then the agent containers (a host stop leaves them running
   for adoption on restart):

   ```bash
   systemctl --user stop nanoclaw
   docker ps -q --filter label=nanoclaw-session | xargs -r docker stop
   docker ps --filter label=nanoclaw-session --format '{{.Names}}'   # must print nothing
   ```

2. Verify the snapshot:

   ```bash
   (cd ~/nanoclaw-backups && sha256sum -c pre-v4-cutover-20260930T051132Z.tar.gz.sha256)
   ```

3. Switch to the v3 code (commit or stash local work first):

   ```bash
   git switch -c v3-restore v3-session-link-final
   ```

4. Replace v4 state with the snapshot. `data/` must be replaced as a whole;
   extracting over a v4 tree would leave v4 session stores behind.

   ```bash
   rm -rf data dist
   tar -xzf ~/nanoclaw-backups/pre-v4-cutover-20260930T051132Z.tar.gz \
     --keep-directory-symlink data dist .env
   ```

   `groups/` (agent workspaces, `CLAUDE.md`, memory) is not protocol state and
   is left untouched above. To also roll workspaces back, add `groups` to the
   member list; `--keep-directory-symlink` preserves a symlinked `groups/`.

5. Rebuild the host and the agent image for the v3 code, then start:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   ./container/build.sh
   systemctl --user start nanoclaw
   ```

6. Reload every open chat tab; v1-protocol clients are not compatible with a v3
   host. Verify with host health **and** a real message exchange in one session.

Never mix versions: a v4 runner against a v3 host (or the reverse), or v4
session stores under v3 code, is unsupported and fails closed.
