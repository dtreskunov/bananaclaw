/**
 * Tests for `ncl groups create` — verifies the DB row + on-disk scaffold
 * happen atomically so the new group is usable on first spawn.
 *
 * The generic CRUD `create` would only insert the row, leaving
 * `groups/<folder>/` empty and `container_configs` missing until the first
 * container spawn lazily ran `initGroupFilesystem`. The custom op closes
 * that gap.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const TEST_ROOT = `${process.cwd()}/.test-state/nanoclaw-test-cli-groups-create`;
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: `${process.cwd()}/.test-state/nanoclaw-test-cli-groups-create/groups`,
    DATA_DIR: `${process.cwd()}/.test-state/nanoclaw-test-cli-groups-create/data`,
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

async function createCmd(args: Record<string, unknown>) {
  return dispatch({ id: 'req-create', command: 'groups-create', args }, { caller: 'host' });
}

describe('ncl groups create', () => {
  it('inserts the DB row, scaffolds the folder, and returns the new group', async () => {
    const res = await createCmd({ name: 'Demo Bot' });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    const group = res.data as { id: string; name: string; folder: string };
    expect(group.name).toBe('Demo Bot');
    expect(group.folder).toBe('demo-bot');
    expect(group.id).toMatch(/^ag-\d+-[a-z0-9]+$/);

    const row = getDb().prepare('SELECT id, name, folder FROM agent_groups WHERE id = ?').get(group.id) as
      | { id: string; name: string; folder: string }
      | undefined;
    expect(row).toEqual({ id: group.id, name: 'Demo Bot', folder: 'demo-bot' });

    // On-disk scaffold landed in the right places.
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'demo-bot'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'demo-bot', 'CLAUDE.local.md'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'v2-sessions', group.id, '.claude-shared', 'settings.json'))).toBe(
      true,
    );

    // container_configs row exists.
    const cfg = getDb().prepare('SELECT 1 FROM container_configs WHERE agent_group_id = ?').get(group.id);
    expect(cfg).toBeTruthy();
  });

  it('dedupes folder names with -2, -3 suffixes', async () => {
    await createCmd({ name: 'Twin' });
    const res = await createCmd({ name: 'Twin' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect((res.data as { folder: string }).folder).toBe('twin-2');
  });

  it('seeds CLAUDE.local.md with --instructions', async () => {
    const res = await createCmd({ name: 'Notes', instructions: 'Be concise.' });
    if (!res.ok) throw new Error('expected ok');
    const folder = (res.data as { folder: string }).folder;
    const body = fs.readFileSync(path.join(TEST_GROUPS_DIR, folder, 'CLAUDE.local.md'), 'utf-8');
    expect(body).toContain('Be concise.');
  });

  it('rejects explicit --folder when it collides with an existing group', async () => {
    await createCmd({ name: 'A', folder: 'fixed' });
    const res = await createCmd({ name: 'B', folder: 'fixed' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.message).toMatch(/folder already in use/);
  });

  it('requires --name', async () => {
    const res = await createCmd({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.message).toMatch(/--name is required/);
  });
});
