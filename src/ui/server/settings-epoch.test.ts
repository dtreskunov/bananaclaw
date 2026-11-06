import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { insertIdentity } from '../../modules/permissions/db/identities.js';
import { createChallenge } from '../../modules/permissions/db/identity-link-challenges.js';
import { UI_PROTOCOL_HEADER, UI_TIMESTAMP_PROTOCOL_VERSION } from '../shared/time.js';
import { handleSettings } from './settings.js';

vi.mock('./auth.js', () => ({ authenticate: () => ({ userId: 'viewer' }) }));

beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec("INSERT INTO users(id,kind,created_at) VALUES('viewer','web',0)");
});
afterEach(closeDb);

async function call(url: string, version: string | null = String(UI_TIMESTAMP_PROTOCOL_VERSION), method = 'GET') {
  const req = Readable.from([]) as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  if (version !== null) req.headers[UI_PROTOCOL_HEADER.toLowerCase()] = version;
  const res = new http.ServerResponse(req);
  let status = 0;
  let body = '';
  res.writeHead = ((code: number) => {
    status = code;
    return res;
  }) as typeof res.writeHead;
  res.end = ((data?: string) => {
    body = data ?? '';
    return res;
  }) as typeof res.end;
  await handleSettings(req, res);
  return { status, body: JSON.parse(body), protocol: res.getHeader(UI_PROTOCOL_HEADER) };
}

it('returns identity verification and challenge expiry as integer milliseconds', async () => {
  insertIdentity({ userId: 'viewer', channel: 'web', handle: 'viewer' });
  getDb().exec('UPDATE identities SET verified_at=0');
  const identities = await call('/ui/settings/api/identities');
  expect(identities.status).toBe(200);
  expect(identities.protocol).toBe('16');
  expect(identities.body.identities[0].verified_at).toBe(0);
  const { row } = createChallenge({ user_id: 'viewer', channel_type: 'telegram', handle: '123' });
  const challenge = await call(`/ui/settings/api/identities/link/status?challengeId=${row.id}`);
  expect(challenge.status).toBe(200);
  expect(challenge.body.expiresAt).toBe(Date.parse(row.expires_at));
});

it.each([null, '15'])('rejects settings requests from protocol %s before a mutation', async (version) => {
  const result = await call('/ui/settings/api/profile', version, 'PATCH');
  expect(result.status).toBe(409);
  expect(result.body.error).toBe('ui_protocol_mismatch');
  expect(getDb().prepare("SELECT display_name FROM users WHERE id='viewer'").get()).toEqual({ display_name: null });
});
