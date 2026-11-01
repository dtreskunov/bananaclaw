---
name: add-vercel
description: Add Vercel deployment capability using the pinned container CLI and user-owned Agent Vault credentials. Use when agents should deploy websites or manage Vercel projects.
---

# Add Vercel

1. Ask which credential owner and groups should get deployment access. Verify
   the gateway with `pnpm exec tsx setup/index.ts --step agent-vault`; use
   `/init-agent-vault` for approved installation if needed.
2. Copy the bundled container skill:

   ```bash
   rsync -a .claude/skills/add-vercel/container-skills/ container/skills/
   ```

3. The owner privately creates/selects a Vercel credential in Credentials.
   Configure the documented bearer recipe for `api.vercel.com` and grant only
   the selected groups. Never request a token in chat or grant every agent.
   Host CLI:

   ```bash
   ncl credentials list --user <owner-id>
   ncl credentials grant --user <owner-id> --id <connection-id> --group <group-id>
   ```

   Grants cover the whole credential and future URL rules. Review that authority
   and provider permissions explicitly; do not copy credentials between groups.

4. Verify `container/Dockerfile` has the pinned `ARG VERCEL_VERSION` and
   `pnpm install -g "vercel@${VERCEL_VERSION}"` entry. If missing, add the
   deliberately pinned CLI via the existing install block and rebuild using
   `./container/build.sh`. Never use an unpinned global install.
5. Copy/run the dependency guard:

   ```bash
   cp .claude/skills/add-vercel/vercel-dockerfile.test.ts src/vercel-dockerfile.test.ts
   pnpm exec vitest run src/vercel-dockerfile.test.ts
   ```

6. Skills are selected/symlinked on spawn. Apply changes to only the intended
   groups at a committed turn boundary; do not kill all containers.
   Verify `vercel whoami --token placeholder` through the group's scoped
   gateway. Obtain separate approval before deploying to production.

Auth failures require exact endpoint/error and access review, not a request for
raw tokens or bypassing TLS. See [REMOVE.md](REMOVE.md).
