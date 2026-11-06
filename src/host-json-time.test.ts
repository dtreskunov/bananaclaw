import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const root = path.resolve('.test-host-json-time');
vi.mock('./config.js', () => ({ DATA_DIR: path.resolve('.test-host-json-time') }));

import { enforceStartupBackoff } from './circuit-breaker.js';
import { _setStorePathForTest, getPairing, tryConsume } from './channels/telegram-pairing.js';
import { getMarketplaceRecord, putMarketplaceRecord, setSkillsStoreRoot } from './skills/store.js';

beforeEach(() => {
  fs.mkdirSync(root, { recursive: true });
  vi.spyOn(Date, 'now').mockReturnValue(0);
  _setStorePathForTest(path.join(root, 'pairings.json'));
  setSkillsStoreRoot(root);
});
afterEach(() => {
  _setStorePathForTest(null);
  setSkillsStoreRoot(null);
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('imports old catalog JSON only at the file boundary and writes numeric lifecycle records', () => {
  const filename = path.join(root, 'marketplaces.json');
  fs.writeFileSync(filename, JSON.stringify({ sources: [{
    id: 'catalog', repo: 'https://example.test/skills.git', ref: 'main', label: null,
    description: null, commit: null, addedAt: '1970-01-01T00:00:00.000Z',
    refreshedAt: null, lastRefreshAttemptAt: '1970-01-01T00:00:00.123Z',
  }] }));
  const record = getMarketplaceRecord('catalog');
  expect(record).toMatchObject({ addedAt: 0, refreshedAt: null, lastRefreshAttemptAt: 123 });
  expect(JSON.parse(fs.readFileSync(filename, 'utf8')).sources[0].addedAt).toBe('1970-01-01T00:00:00.000Z');
  putMarketplaceRecord({ ...record!, lastRefreshAttemptAt: 0 });
  expect(JSON.parse(fs.readFileSync(filename, 'utf8')).sources[0]).toMatchObject({
    addedAt: 0, refreshedAt: null, lastRefreshAttemptAt: 0,
  });
});

it('preserves imported pairing times and records epoch-zero consumption numerically', async () => {
  fs.writeFileSync(path.join(root, 'pairings.json'), JSON.stringify({ pairings: [{
    code: '1234', intent: 'main', status: 'pending', createdAt: '1970-01-01T00:00:00.000Z',
  }] }));
  expect(getPairing('1234')?.createdAt).toBe(0);
  const result = await tryConsume({
    text: '1234', botUsername: 'testbot', platformId: 'telegram:123', isGroup: false,
  });
  expect(result?.consumed?.consumedAt).toBe(0);
  expect(result?.attempts?.[0].at).toBe(0);
});

it('writes numeric breaker state after importing an old ISO startup timestamp', async () => {
  const filename = path.join(root, 'circuit-breaker.json');
  fs.writeFileSync(filename, JSON.stringify({ attempt: 4, timestamp: '1969-12-31T22:00:00.000Z' }));
  await enforceStartupBackoff();
  expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual({ attempt: 1, timestamp: 0 });
});

it('rejects corrupt imported metadata dates without silently discarding state', async () => {
  const filename = path.join(root, 'circuit-breaker.json');
  const original = JSON.stringify({ attempt: 4, timestamp: 'corrupt' });
  fs.writeFileSync(filename, original);
  await expect(enforceStartupBackoff()).rejects.toThrow('Invalid timestamp');
  expect(fs.readFileSync(filename, 'utf8')).toBe(original);
});
