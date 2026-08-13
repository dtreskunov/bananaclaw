/**
 * Tests for `ncl groups config set-param` / `config unset-param` — the CLI
 * surface for the `model_params` JSON bag on `container_configs`.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-model-params' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-model-params';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function seedGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  createContainerConfig({
    agent_group_id: id,
    provider: null,
    upstream_provider: null,
    model: null,
    small_model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    packages_pip: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    voice_mode: 'off',
    transcription_model: null,
    model_params: '{}',
    updated_at: now(),
  });
}

describe('groups config set-param / unset-param', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('sets a numeric param parsed as JSON', async () => {
    seedGroup('ag-1');
    const resp = await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-1', key: 'max_tokens', value: '8192' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const params = JSON.parse(getContainerConfig('ag-1')!.model_params) as Record<string, unknown>;
    expect(params).toEqual({ max_tokens: 8192 });
  });

  it('falls back to string when value is not valid JSON', async () => {
    seedGroup('ag-2');
    await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-2', key: 'reasoning_effort', value: 'high' } },
      { caller: 'host' },
    );
    const params = JSON.parse(getContainerConfig('ag-2')!.model_params) as Record<string, unknown>;
    expect(params).toEqual({ reasoning_effort: 'high' });
  });

  it('parses booleans and arrays via JSON', async () => {
    seedGroup('ag-3');
    await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-3', key: 'stream', value: 'true' } },
      { caller: 'host' },
    );
    await dispatch(
      { id: 'r2', command: 'groups-config-set-param', args: { id: 'ag-3', key: 'stop', value: '["END","STOP"]' } },
      { caller: 'host' },
    );
    const params = JSON.parse(getContainerConfig('ag-3')!.model_params) as Record<string, unknown>;
    expect(params).toEqual({ stream: true, stop: ['END', 'STOP'] });
  });

  it('merges into existing params (does not replace the whole bag)', async () => {
    seedGroup('ag-4');
    await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-4', key: 'max_tokens', value: '4096' } },
      { caller: 'host' },
    );
    await dispatch(
      { id: 'r2', command: 'groups-config-set-param', args: { id: 'ag-4', key: 'temperature', value: '0.7' } },
      { caller: 'host' },
    );
    const params = JSON.parse(getContainerConfig('ag-4')!.model_params) as Record<string, unknown>;
    expect(params).toEqual({ max_tokens: 4096, temperature: 0.7 });
  });

  it('overwrites an existing key', async () => {
    seedGroup('ag-5');
    await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-5', key: 'max_tokens', value: '1024' } },
      { caller: 'host' },
    );
    await dispatch(
      { id: 'r2', command: 'groups-config-set-param', args: { id: 'ag-5', key: 'max_tokens', value: '8192' } },
      { caller: 'host' },
    );
    const params = JSON.parse(getContainerConfig('ag-5')!.model_params) as Record<string, unknown>;
    expect(params).toEqual({ max_tokens: 8192 });
  });

  it('rejects invalid key format', async () => {
    seedGroup('ag-6');
    const resp = await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-6', key: 'bad key!', value: '1' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toMatch(/dotted identifier/);
  });

  it('requires --key and --value', async () => {
    seedGroup('ag-7');
    const noKey = await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-7', value: '1' } },
      { caller: 'host' },
    );
    expect(noKey.ok).toBe(false);
    const noVal = await dispatch(
      { id: 'r2', command: 'groups-config-set-param', args: { id: 'ag-7', key: 'x' } },
      { caller: 'host' },
    );
    expect(noVal.ok).toBe(false);
  });

  it('unset-param removes a key', async () => {
    seedGroup('ag-8');
    await dispatch(
      { id: 'r1', command: 'groups-config-set-param', args: { id: 'ag-8', key: 'max_tokens', value: '4096' } },
      { caller: 'host' },
    );
    await dispatch(
      { id: 'r2', command: 'groups-config-set-param', args: { id: 'ag-8', key: 'temperature', value: '0.5' } },
      { caller: 'host' },
    );
    const resp = await dispatch(
      { id: 'r3', command: 'groups-config-unset-param', args: { id: 'ag-8', key: 'max_tokens' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const params = JSON.parse(getContainerConfig('ag-8')!.model_params) as Record<string, unknown>;
    expect(params).toEqual({ temperature: 0.5 });
  });

  it('unset-param is a no-op for an absent key', async () => {
    seedGroup('ag-9');
    const resp = await dispatch(
      { id: 'r1', command: 'groups-config-unset-param', args: { id: 'ag-9', key: 'never_set' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: string | null } }).data;
    expect(data.removed).toBeNull();
  });
});
