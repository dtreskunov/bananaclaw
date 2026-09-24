import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration034: Migration = {
  version: 34,
  name: 'voice-input-backend',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN voice_input_backend TEXT;
      ALTER TABLE container_configs ADD COLUMN voice_input_enabled INTEGER NOT NULL DEFAULT 1
      CHECK (voice_input_enabled IN (0, 1))`);
  },
};
