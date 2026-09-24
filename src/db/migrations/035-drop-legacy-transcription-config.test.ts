import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';

beforeEach(() => {
  runMigrations(
    initTestDb(),
    migrations.filter((migration) => migration.name !== 'drop-legacy-transcription-config'),
  );
});

afterEach(() => closeDb());

describe('drop legacy transcription config migration', () => {
  it.each([
    { backend: null, enabled: 1 },
    { backend: 'elevenlabs', enabled: 0 },
    { backend: 'future-provider', enabled: 1 },
    { backend: '', enabled: 0 },
  ])('preserves web voice input and all other config: %j', ({ backend, enabled }) => {
    const db = getDb();
    db.exec("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 'now')");
    db.prepare(
      `INSERT INTO container_configs
        (agent_group_id, provider, model, voice_mode, transcription_model,
         voice_input_backend, voice_input_enabled, model_params, updated_at)
       VALUES ('g', 'claude', 'test-model', 'audio', 'legacy/model', ?, ?, '{"max_tokens":1024}', 'now')`,
    ).run(backend, enabled);
    const before = db.prepare('SELECT * FROM container_configs').get() as Record<string, unknown>;
    expect(before).toMatchObject({ voice_mode: 'audio', transcription_model: 'legacy/model' });
    delete before.voice_mode;
    delete before.transcription_model;

    runMigrations(db);
    runMigrations(db);

    expect(db.prepare('SELECT * FROM container_configs').get()).toEqual(before);
    const columns = (db.pragma('table_info(container_configs)') as { name: string }[]).map(({ name }) => name);
    expect(columns).not.toContain('voice_mode');
    expect(columns).not.toContain('transcription_model');
    expect(columns).toContain('voice_input_backend');
    expect(columns).toContain('voice_input_enabled');
    expect(() => db.exec('UPDATE container_configs SET voice_input_enabled = 2')).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('leaves web voice defaults intact for newly created rows', () => {
    const db = getDb();
    runMigrations(db);
    db.exec(`
      INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 'now');
      INSERT INTO container_configs (agent_group_id, updated_at) VALUES ('g', 'now');
    `);
    expect(db.prepare('SELECT * FROM container_configs').get()).toMatchObject({
      voice_input_backend: null,
      voice_input_enabled: 1,
    });
  });
});
