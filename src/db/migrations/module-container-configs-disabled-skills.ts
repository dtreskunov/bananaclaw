import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const moduleContainerConfigsDisabledSkills: Migration = {
  version: 34,
  name: 'container-configs-disabled-skills',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN disabled_skills TEXT NOT NULL DEFAULT '[]'").run();
  },
};
