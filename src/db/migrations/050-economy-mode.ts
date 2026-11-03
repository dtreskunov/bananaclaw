import type { Migration } from './index.js';

export const migration050: Migration = {
  version: 50,
  name: 'economy-mode',
  up(db) {
    db.exec(
      'ALTER TABLE container_configs ADD COLUMN economy_mode INTEGER NOT NULL DEFAULT 0 CHECK (economy_mode IN (0, 1))',
    );
  },
};
