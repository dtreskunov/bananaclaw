import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMagicLink, createSession, lookupSession, hashToken, redeemMagicLink } from './db.js';
import { createDownloadToken, redeemDownloadToken } from './download-tokens.js';
import {
  createPrivateWebSession,
  inspectPrivateWebHandoff,
  lookupPrivateWebSession,
  redeemPrivateWebHandoff,
} from './private-web-db.js';

beforeEach(() => {
  runMigrations(initTestDb());
  vi.useFakeTimers();
  vi.setSystemTime(0);
  getDb().prepare("INSERT INTO users(id,kind,created_at) VALUES('u','web',0)").run();
  createAgentGroup({ id: 'g', name: 'Group', folder: 'g', agent_provider: null, created_at: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

it('returns numeric magic-link and session deadlines and preserves existing deadline inclusivity', () => {
  const link = createMagicLink('u', 60_000);
  expect(link.expiresAt).toBe(60_000);
  expect(redeemMagicLink(link.token)).toBe('u');
  expect(redeemMagicLink(link.token)).toBeNull();
  expect(
    getDb().prepare('SELECT created_at,redeemed_at FROM ui_magic_links WHERE token_hash=?').get(hashToken(link.token)),
  ).toEqual({ created_at: 0, redeemed_at: 0 });
  const session = createSession('u', 60_000);
  expect(session.expiresAt).toBe(60_000);
  expect(lookupSession(session.token)?.expiresAt).toBe(60_000);
  vi.setSystemTime(60_000);
  expect(lookupSession(session.token)).not.toBeNull();
  vi.setSystemTime(60_001);
  expect(lookupSession(session.token)).toBeNull();
});

it('retains epoch-zero first redemption when a download token is reused', () => {
  const issued = createDownloadToken({ issuerUserId: 'u', groupId: 'g', relPath: 'file.txt', ttlMs: 1000, uses: 2 });
  expect(issued.expiresAt).toBe(1000);
  expect(redeemDownloadToken(issued.token, null, null)).toMatchObject({
    created_at: 0,
    first_redeemed_at: 0,
    uses_left: 1,
  });
  vi.setSystemTime(10);
  expect(redeemDownloadToken(issued.token, null, null)).toMatchObject({ first_redeemed_at: 0, uses_left: 0 });
  expect(redeemDownloadToken(issued.token, null, null)).toBeNull();
  const expired = createDownloadToken({ issuerUserId: 'u', groupId: 'g', relPath: 'file.txt', ttlMs: -1, uses: 1 });
  expect(redeemDownloadToken(expired.token, null, null)).toBeNull();
});

it('recognizes a private-web handoff redeemed at epoch zero and enforces idle expiry', () => {
  const parent = createSession('u', 60 * 60 * 1000);
  const issued = createPrivateWebSession({
    parentSessionHash: hashToken(parent.token),
    userId: 'u',
    agentGroupId: 'g',
  });
  expect(issued.expiresAt).toBe(8 * 60 * 60 * 1000);
  expect(inspectPrivateWebHandoff(issued.id, issued.handoffToken)?.lastUsed).toBeNull();
  const redeemed = redeemPrivateWebHandoff(issued.id, issued.handoffToken)!;
  expect(redeemed.session).toMatchObject({ expiresAt: issued.expiresAt, lastUsed: 0 });
  expect(inspectPrivateWebHandoff(issued.id, issued.handoffToken)).toBeNull();
  expect(lookupPrivateWebSession(issued.id, redeemed.secureToken)?.lastUsed).toBe(0);
  vi.setSystemTime(30 * 60 * 1000);
  expect(lookupPrivateWebSession(issued.id, redeemed.secureToken)).toBeNull();
});

it.each([NaN, Infinity, 0.5, 8640000000000001])(
  'rejects an invalid computed deadline (%s) before superseding valid magic links',
  (ttlMs) => {
    const valid = createMagicLink('u', 1000);
    expect(() => createMagicLink('u', ttlMs)).toThrow('Invalid epoch-millisecond timestamp');
    expect(redeemMagicLink(valid.token)).toBe('u');
    expect(() => createSession('u', ttlMs)).toThrow('Invalid epoch-millisecond timestamp');
    expect(() =>
      createDownloadToken({
        issuerUserId: 'u',
        groupId: 'g',
        relPath: 'file.txt',
        ttlMs,
        uses: 1,
      }),
    ).toThrow('Invalid epoch-millisecond timestamp');
    expect(getDb().prepare('SELECT count(*) AS count FROM ui_download_tokens').get()).toEqual({ count: 0 });
  },
);
