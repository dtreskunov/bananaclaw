import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-group credential backend: where a group's containers get credentials.
 *
 * NULL or 'onecli' keeps the OneCLI gateway; 'agent-vault' moves the group's
 * egress to the Agent Vault credential gateway (one vault per group). Set
 * host-only via `ncl credentials backend set`, never from a container.
 */
export const moduleContainerConfigsCredentialBackend: Migration = {
  version: 36,
  name: 'container-configs-credential-backend',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN credential_backend TEXT').run();
  },
};
