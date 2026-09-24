import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../env.js')>()),
  readEnvFile: vi.fn(() => ({})),
}));

import { configFromDb } from '../../../container-config.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import {
  createContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
} from '../../../db/container-configs.js';
import { migrations, runMigrations } from '../../../db/migrations/index.js';
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import {
  defaultVoiceInputBackend,
  getVoiceInputApiKey,
  resolveVoiceInputConfig,
  VOICE_INPUT_MODEL,
} from './voice-input-config.js';

beforeEach(() => {
  vi.mocked(readEnvFile).mockReturnValue({});
  vi.stubEnv('ELEVENLABS_API_KEY', '');
  vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', '');
  defaultVoiceInputBackend();
  const db = initTestDb();
  runMigrations(
    db,
    migrations.filter(
      (migration) => migration.name !== 'voice-input-backend' && migration.name !== 'drop-legacy-transcription-config',
    ),
  );
  db.exec(`
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 'now');
    INSERT INTO container_configs (agent_group_id, voice_mode, transcription_model, updated_at)
    VALUES ('g', 'audio', 'legacy/audio-model', 'now');
  `);
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('host voice input configuration', () => {
  it('migrates legacy rows to the server default and removes audio-note configuration', () => {
    runMigrations(getDb());
    expect(getContainerConfig('g')).toMatchObject({
      voice_input_backend: null,
      voice_input_enabled: 1,
    });
    expect(getContainerConfig('g')).not.toHaveProperty('voice_mode');
    expect(getContainerConfig('g')).not.toHaveProperty('transcription_model');
    expect(VOICE_INPUT_MODEL).toBe('scribe_v2_realtime');
    expect(resolveVoiceInputConfig('g')).toEqual({
      backend: 'elevenlabs',
      ready: false,
      reason: 'ELEVENLABS_API_KEY is not configured on the host.',
    });
  });

  it('resolves process env credentials privately and exposes only readiness', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-test-key');
    expect(getVoiceInputApiKey()).toBe('private-test-key');
    expect(resolveVoiceInputConfig('g')).toEqual({ backend: 'elevenlabs', ready: true });
    expect(JSON.stringify(resolveVoiceInputConfig('g'))).not.toContain('private-test-key');
  });

  it('reads host file credentials without copying them into process env', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', undefined);
    vi.mocked(readEnvFile).mockReturnValue({ ELEVENLABS_API_KEY: 'file-test-key' });
    expect(getVoiceInputApiKey()).toBe('file-test-key');
    expect(process.env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(resolveVoiceInputConfig('g').ready).toBe(true);
    vi.stubEnv('ELEVENLABS_API_KEY', 'environment-key');
    expect(getVoiceInputApiKey()).toBe('environment-key');
  });

  it('supports disabled server defaults and explicit group overrides', () => {
    vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', 'disabled');
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-test-key');
    expect(defaultVoiceInputBackend()).toBe('disabled');
    expect(resolveVoiceInputConfig('g')).toMatchObject({ backend: 'disabled', ready: false });
    updateContainerConfigScalars('g', { voice_input_backend: 'elevenlabs' });
    expect(resolveVoiceInputConfig('g')).toEqual({ backend: 'elevenlabs', ready: true });
    updateContainerConfigScalars('g', { voice_input_backend: null });
    expect(resolveVoiceInputConfig('g').backend).toBe('disabled');
    vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', 'elevenlabs');
    updateContainerConfigScalars('g', { voice_input_enabled: 0 });
    expect(resolveVoiceInputConfig('g').backend).toBe('disabled');
  });

  it('disables voice without clearing the selected backend and re-enables it independently', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-test-key');
    updateContainerConfigScalars('g', { voice_input_backend: 'elevenlabs', voice_input_enabled: 0 });
    expect(resolveVoiceInputConfig('g')).toEqual({
      backend: 'disabled',
      ready: false,
      reason: 'Voice input is disabled.',
    });
    expect(getContainerConfig('g')?.voice_input_backend).toBe('elevenlabs');
    updateContainerConfigScalars('g', { voice_input_enabled: 1 });
    expect(resolveVoiceInputConfig('g')).toEqual({ backend: 'elevenlabs', ready: true });
  });

  it.each(['future-provider', 'disabled', ''])(
    'preserves unsupported backend ID %j without using the default',
    (backend) => {
      vi.stubEnv('ELEVENLABS_API_KEY', 'private-test-key');
      updateContainerConfigScalars('g', { voice_input_backend: backend });
      expect(getContainerConfig('g')?.voice_input_backend).toBe(backend);
      expect(resolveVoiceInputConfig('g')).toEqual({
        backend: 'disabled',
        ready: false,
        reason: 'Configured voice input backend is not supported.',
      });
    },
  );

  it('uses the file default', () => {
    vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', undefined);
    vi.mocked(readEnvFile).mockReturnValue({ DEFAULT_VOICE_INPUT_BACKEND: 'disabled' });
    expect(defaultVoiceInputBackend()).toBe('disabled');
  });

  it('makes invalid server defaults unavailable even with a valid key, warning without values', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-test-key');
    vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', 'invalid-sensitive-value');
    expect(defaultVoiceInputBackend()).toBe('disabled');
    expect(resolveVoiceInputConfig('g')).toEqual({
      backend: 'disabled',
      ready: false,
      reason: 'DEFAULT_VOICE_INPUT_BACKEND must be disabled or elevenlabs.',
    });
    vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', undefined);
    vi.mocked(readEnvFile).mockReturnValue({ DEFAULT_VOICE_INPUT_BACKEND: 'invalid-file-value' });
    expect(resolveVoiceInputConfig('g').ready).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-test-key|invalid-sensitive-value|invalid-file-value/);
  });

  it.each([undefined, '', '   '])('uses ElevenLabs when server default is absent or empty (%j)', (value) => {
    vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', value);
    expect(defaultVoiceInputBackend()).toBe('elevenlabs');
    expect(resolveVoiceInputConfig('g').backend).toBe('elevenlabs');
  });

  it('never materializes web voice settings or credentials into container configuration', () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-test-key');
    updateContainerConfigScalars('g', { voice_input_backend: 'elevenlabs', voice_input_enabled: 0 });
    const config = configFromDb(getContainerConfig('g')!, getAgentGroup('g')!);
    expect(config).not.toHaveProperty('voiceMode');
    expect(config).not.toHaveProperty('transcriptionModel');
    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/voice_input|voiceInput|ELEVENLABS|private-test-key/);
  });

  it.each(['voice_mode', 'transcription_model'])('rejects removed scalar column %s', (field) => {
    const row = getContainerConfig('g');
    expect(() => updateContainerConfigScalars('g', { [field]: 'legacy-value' })).toThrow(
      `Invalid scalar column: ${field}`,
    );
    expect(getContainerConfig('g')).toEqual(row);
  });

  it('normalizes omitted values on creation and persists explicit values', () => {
    const row = getContainerConfig('g')!;
    delete row.voice_input_backend;
    delete row.voice_input_enabled;
    for (const id of ['default', 'explicit']) {
      getDb()
        .prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)')
        .run(id, id, id, 'now');
    }
    createContainerConfig({ ...row, agent_group_id: 'default' });
    createContainerConfig({
      ...row,
      agent_group_id: 'explicit',
      voice_input_backend: 'future-provider',
      voice_input_enabled: 0,
    });
    expect(getContainerConfig('default')?.voice_input_backend).toBeNull();
    expect(getContainerConfig('default')?.voice_input_enabled).toBe(1);
    expect(getContainerConfig('explicit')?.voice_input_backend).toBe('future-provider');
    expect(getContainerConfig('explicit')?.voice_input_enabled).toBe(0);
    expect(() => getDb().prepare('UPDATE container_configs SET voice_input_enabled = 2').run()).toThrow();
  });
});
