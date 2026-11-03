import type { Migration } from './index.js';

export const migration048: Migration = {
  version: 48,
  name: 'agent-vault-only',
  up(db) {
    const unsupported = db
      .prepare("SELECT COUNT(*) AS count FROM container_configs WHERE credential_backend != 'agent-vault'")
      .get() as { count: number };
    if (unsupported.count)
      throw new Error('Complete the reviewed credential cutovers before deploying the Agent Vault-only host');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_approvals'").get()) {
      const pending = db.prepare("SELECT 1 FROM pending_approvals WHERE action='onecli_credential'").get();
      if (pending) throw new Error('Resolve retired gateway approvals before deploying the Agent Vault-only host');
    }

    db.exec(`
      ALTER TABLE container_configs RENAME COLUMN credential_backend TO retired_credential_backend;
      ALTER TABLE container_configs ADD COLUMN credential_backend TEXT NOT NULL DEFAULT 'agent-vault'
        CHECK(credential_backend='agent-vault');
      ALTER TABLE container_configs DROP COLUMN retired_credential_backend;
    `);
    const rows = db.prepare('SELECT agent_group_id,skills,disabled_skills FROM container_configs').all() as {
      agent_group_id: string;
      skills: string;
      disabled_skills: string | null;
    }[];
    const rename = (raw: string | null): string | null => {
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === 'all') return raw;
      if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string'))
        throw new Error('Invalid skill selection; review container configuration before retirement');
      return JSON.stringify([...new Set(parsed.map((slug) => (slug === 'onecli-gateway' ? 'agent-vault' : slug)))]);
    };
    const update = db.prepare('UPDATE container_configs SET skills=?,disabled_skills=? WHERE agent_group_id=?');
    for (const row of rows) update.run(rename(row.skills), rename(row.disabled_skills), row.agent_group_id);
  },
};
