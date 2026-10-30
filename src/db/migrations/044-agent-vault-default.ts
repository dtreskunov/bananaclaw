import type { Migration } from './index.js';

export const migration044: Migration = {
  version: 44,
  name: 'agent-vault-new-group-default',
  up(db) {
    const invalid = db
      .prepare(
        `SELECT COUNT(*) AS count FROM container_configs
      WHERE credential_backend IS NOT NULL AND credential_backend NOT IN ('onecli','agent-vault')`,
      )
      .get() as { count: number };
    if (invalid.count)
      throw new Error('Unsupported credential backend must be reviewed before changing new-group defaults');
    db.exec(`
      ALTER TABLE container_configs RENAME COLUMN credential_backend TO previous_credential_backend;
      ALTER TABLE container_configs ADD COLUMN credential_backend TEXT NOT NULL DEFAULT 'agent-vault'
        CHECK(credential_backend IN ('onecli','agent-vault'));
      UPDATE container_configs SET credential_backend=COALESCE(previous_credential_backend,'onecli');
      ALTER TABLE container_configs DROP COLUMN previous_credential_backend;
      INSERT INTO container_configs(agent_group_id,credential_backend,updated_at)
        SELECT g.id,'onecli',g.created_at FROM agent_groups g
        WHERE NOT EXISTS(SELECT 1 FROM container_configs c WHERE c.agent_group_id=g.id);
    `);
  },
};
