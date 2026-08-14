import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-zip';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-ui-zip/groups',
    DATA_DIR: '/tmp/nanoclaw-test-ui-zip/data',
  };
});

vi.mock('../auth.js', () => ({
  authenticate: () => ({ userId: 'web:admin' }),
  recordAccess: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handle } from './routes.js';

const GID = 'ag-zip';
const FOLDER = 'zip-group';
const ADMIN = 'web:admin';

function makeReq(url: string): http.IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as http.IncomingMessage;
}

async function get(url: string): Promise<{ status: number; headers: Map<string, string>; body: Buffer }> {
  let status = 0;
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const writable = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const res = writable as unknown as http.ServerResponse;
  res.writeHead = ((code: number, values?: http.OutgoingHttpHeaders) => {
    status = code;
    if (values) for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), String(value));
    return res;
  }) as http.ServerResponse['writeHead'];
  writable.on('finish', resolveDone);

  await handle(makeReq(url), res);
  await done;
  return { status, headers, body: Buffer.concat(chunks) };
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, FOLDER, 'docs', 'nested'), { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, 'docs', 'readme.txt'), 'hello');
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, 'docs', 'nested', 'notes.txt'), 'world');

  const db = initTestDb();
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, ?)`).run(ADMIN, ADMIN, now);
  db.prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`).run(
    GID,
    FOLDER,
    FOLDER,
    now,
  );
  db.prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run(GID, now);
  grantRole({ user_id: ADMIN, role: 'admin', agent_group_id: GID, granted_by: ADMIN, granted_at: now });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('GET /api/groups/:gid/zip', () => {
  it('streams a folder using the archiver v8 API', async () => {
    const response = await get(`/api/groups/${GID}/zip?path=docs`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="docs.zip"');
    expect(response.body.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(response.body.toString('latin1')).toContain('docs/readme.txt');
    expect(response.body.toString('latin1')).toContain('docs/nested/notes.txt');
  });
});
