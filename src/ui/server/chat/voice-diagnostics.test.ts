import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ authenticated: true, allowed: true }));
vi.mock('../auth.js', () => ({
  authenticate: () => (runtime.authenticated ? { userId: 'user', sessionHash: 'test' } : null),
  recordAccess: vi.fn(),
}));
vi.mock('../../../modules/permissions/access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../modules/permissions/access.js')>()),
  canAccessAgentGroup: () => ({ allowed: runtime.allowed }),
}));

import { log } from '../../../log.js';
import { handle } from './routes.js';

const diagnostic = {
  attemptId: '11111111-2222-4333-8444-555555555555',
  outcome: 'failed',
  failure: 'permission',
  elapsedMs: 100,
  peakQueuedBytes: 0,
};

async function report(body: unknown, origin = 'https://chat.example', raw = false) {
  const req = Readable.from([Buffer.from(raw ? String(body) : JSON.stringify(body))]) as http.IncomingMessage;
  req.method = 'POST';
  req.url = '/ui/chat/api/groups/group/voice/diagnostics';
  req.headers = { host: 'chat.example', origin, 'content-type': 'application/json' };
  const res = new http.ServerResponse(req);
  let status = 0;
  let content = '';
  res.writeHead = ((code: number) => {
    status = code;
    return res;
  }) as typeof res.writeHead;
  res.end = ((data?: string) => {
    content = data ?? '';
    return res;
  }) as typeof res.end;
  await handle(req, res);
  return { status, content };
}

beforeEach(() => {
  runtime.authenticated = runtime.allowed = true;
  vi.stubEnv('UI_BASE_URL', 'https://chat.example/ui');
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(log, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('voice diagnostic ingestion', () => {
  it('logs only validated diagnostic fields with authenticated group and user context', async () => {
    expect((await report(diagnostic)).status).toBe(204);
    expect(log.warn).toHaveBeenCalledWith('Voice client attempt ended', {
      userId: 'user',
      groupId: 'group',
      ...diagnostic,
    });
    const { failure: _failure, ...completed } = diagnostic;
    expect((await report({ ...completed, outcome: 'finished' })).status).toBe(204);
    expect(log.info).toHaveBeenCalledOnce();
  });

  it('requires authentication, same origin and group access', async () => {
    runtime.authenticated = false;
    expect((await report(diagnostic)).status).toBe(401);
    runtime.authenticated = true;
    expect((await report(diagnostic, 'https://attacker.example')).status).toBe(403);
    runtime.allowed = false;
    expect((await report(diagnostic)).status).toBe(403);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    { ...diagnostic, transcript: 'private text' },
    { ...diagnostic, message: 'private text' },
    { ...diagnostic, captureErrorName: 'private text' },
    { ...diagnostic, failure: 'private text' },
    { ...diagnostic, attemptId: 'private text' },
    { ...diagnostic, elapsedMs: -1 },
  ])('rejects unvalidated content without logging it', async (body) => {
    expect((await report(body)).status).toBe(400);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it.each(['{invalid', 'x'.repeat(4097)])('bounds and validates request bodies', async (body) => {
    expect((await report(body, 'https://chat.example', true)).status).toBe(400);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
