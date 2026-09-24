import type { Migration } from './index.js';

export const migration035: Migration = {
  version: 35,
  name: 'drop-legacy-transcription-config',
  up(db) {
    db.exec(`
      ALTER TABLE container_configs DROP COLUMN voice_mode;
      ALTER TABLE container_configs DROP COLUMN transcription_model;
    `);
  },
};
