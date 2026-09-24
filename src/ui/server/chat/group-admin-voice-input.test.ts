import type http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth.js', () => ({ authenticate: () => ({ userId: 'web:owner' }) }));
vi.mock('../../../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
  runMcpProbeContainer: vi.fn(),
}));
vi.mock('../../../container-restart.js', () => ({ restartAgentGroupContainers: vi.fn(() => 1) }));
vi.mock('../../../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../env.js')>()),
  readEnvFile: vi.fn(() => ({})),
  resolveDefaultModel: vi.fn(() => undefined),
}));
vi.mock('./models-catalog.js', () => ({
  bareIdForResponse: (_provider: unknown, model: unknown) => model,
  dbValueFromBareId: (_provider: unknown, model: unknown) => model,
  getModelDetails: vi.fn(async () => null),
  listModelsForProvider: vi.fn(async () => ({ models: [] })),
}));
vi.mock('./skill-catalog.js', () => ({ listAvailableSkills: () => [] }));
vi.mock('./audit.js', () => ({ recordAdminAction: vi.fn() }));

import { restartAgentGroupContainers } from '../../../container-restart.js';
import { closeDb, initTestDb } from '../../../db/connection.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../../db/container-configs.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { recordAdminAction } from './audit.js';
import { handleGroupAdminRequest } from './group-admin.js';

async function settings(method: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.method = method;
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  }) as unknown as http.ServerResponse;
  res.writeHead = ((status: number) => {
    res.statusCode = status;
    return res;
  }) as http.ServerResponse['writeHead'];
  await handleGroupAdminRequest(req, res, '/api/groups/g/admin/settings');
  return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ELEVENLABS_API_KEY', '');
  vi.stubEnv('DEFAULT_VOICE_INPUT_BACKEND', '');
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at) VALUES ('web:owner', 'web', 'Owner', 'now');
    INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
    VALUES ('web:owner', 'owner', NULL, 'web:owner', 'now');
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 'now');
    INSERT INTO container_configs (agent_group_id, updated_at)
    VALUES ('g', 'now');
  `);
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
});

describe('group voice input settings', () => {
  it('returns only public backend/default/readiness information', async () => {
    let response = await settings('GET');
    expect(response.status).toBe(200);
    expect(response.body.config.voice_input_backend).toBeNull();
    expect(response.body.config.voice_input_enabled).toBe(true);
    expect(response.body.defaults.voice_input_backend).toBe('elevenlabs');
    expect(response.body.config).not.toHaveProperty('voice_mode');
    expect(response.body.config).not.toHaveProperty('transcription_model');
    expect(response.body.defaults).not.toHaveProperty('transcription_model');
    expect(response.body).not.toHaveProperty('validVoiceModes');
    expect(response.body.voiceInput).toEqual({
      backend: 'elevenlabs',
      ready: false,
      reason: 'ELEVENLABS_API_KEY is not configured on the host.',
    });
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-admin-test-key');
    response = await settings('GET');
    expect(response.body.voiceInput).toEqual({ backend: 'elevenlabs', ready: true });
    expect(JSON.stringify(response.body)).not.toContain('private-admin-test-key');
  });

  it.each(['future-provider', 'elevenlabs', null] as const)('saves %s without restarting', async (backend) => {
    const response = await settings('PATCH', { voice_input_backend: backend });
    expect(response.status).toBe(200);
    expect(response.body.config.voice_input_backend).toBe(backend);
    expect(getContainerConfig('g')).toMatchObject({
      voice_input_backend: backend,
    });
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
    expect(recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { voice_input_backend: backend },
      }),
    );
  });

  it.each([true, 1, {}])('rejects invalid backend type %j', async (backend) => {
    const response = await settings('PATCH', { voice_input_backend: backend });
    expect(response.status).toBe(400);
    expect(getContainerConfig('g')?.voice_input_backend).toBeNull();
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it.each([false, true])('saves enabled=%s without changing the backend or restarting', async (enabled) => {
    updateContainerConfigScalars('g', { voice_input_backend: 'future-provider' });
    const response = await settings('PATCH', { voice_input_enabled: enabled });
    expect(response.status).toBe(200);
    expect(response.body.config.voice_input_enabled).toBe(enabled);
    expect(response.body.config.voice_input_backend).toBe('future-provider');
    expect(response.body.voiceInput.ready).toBe(false);
    expect(getContainerConfig('g')).toMatchObject({
      voice_input_enabled: enabled ? 1 : 0,
      voice_input_backend: 'future-provider',
    });
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('saves both host-only fields without restarting', async () => {
    const response = await settings('PATCH', { voice_input_enabled: false, voice_input_backend: 'elevenlabs' });
    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({
      voice_input_enabled: false,
      voice_input_backend: 'elevenlabs',
    });
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it.each([null, 0, 1, 'false', 'true', {}])('rejects non-boolean enabled flag %j', async (enabled) => {
    const response = await settings('PATCH', { voice_input_enabled: enabled });
    expect(response.status).toBe(400);
    expect(getContainerConfig('g')?.voice_input_enabled).toBe(1);
    expect(recordAdminAction).not.toHaveBeenCalled();
  });

  it('round-trips unsupported IDs and reports unavailable without falling back', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'private-admin-test-key');
    const response = await settings('PATCH', { voice_input_backend: 'future-provider' });
    expect(response.status).toBe(200);
    expect(response.body.config.voice_input_backend).toBe('future-provider');
    expect(response.body.voiceInput).toEqual({
      backend: 'disabled',
      ready: false,
      reason: 'Configured voice input backend is not supported.',
    });
    expect((await settings('GET')).body.config.voice_input_backend).toBe('future-provider');
  });

  it.each([
    { transcription_model: 'legacy/new-model' },
    { transcription_model: null },
    { voice_mode: 'audio' },
    { voice_mode: null },
    { transcription_model: 'legacy/new-model', voice_input_backend: 'elevenlabs' },
    { voice_mode: 'audio', voice_input_enabled: false, name: 'Changed' },
  ])('rejects unsupported legacy settings atomically: %j', async (body) => {
    updateContainerConfigScalars('g', { voice_input_backend: 'future-provider', voice_input_enabled: 0 });
    const before = getContainerConfig('g');
    const response = await settings('PATCH', body);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('unsupported setting');
    expect(getContainerConfig('g')).toEqual(before);
    expect((await settings('GET')).body.name).toBe('Group');
    expect(recordAdminAction).not.toHaveBeenCalled();
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });
});
