import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { normalizeHostMetadata } from './normalize-host-metadata.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-meta-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(data));
};
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

it('normalizes known dates, preserves zero/null/opaque data, and retains exact backups', async () => {
  const iso = '1970-01-01T00:00:00.000Z';
  write('circuit-breaker.json', { timestamp: iso, attempt: 2 });
  write('telegram-pairings.json', {
    pairings: [{ createdAt: iso, consumed: { consumedAt: iso }, attempts: [{ at: iso }], opaque: { createdAt: iso } }],
  });
  write('skills/marketplaces.json', { sources: [{ addedAt: 0, refreshedAt: null, lastRefreshAttemptAt: iso }] });
  const original = fs.readFileSync(path.join(root, 'telegram-pairings.json'), 'utf8');
  expect(await normalizeHostMetadata(root, path.join(root, 'backup'))).toBe(3);
  expect(read('circuit-breaker.json')).toEqual({ timestamp: 0, attempt: 2 });
  expect(read('telegram-pairings.json').pairings[0]).toEqual({
    createdAt: 0,
    consumed: { consumedAt: 0 },
    attempts: [{ at: 0 }],
    opaque: { createdAt: iso },
  });
  expect(read('skills/marketplaces.json').sources[0]).toEqual({
    addedAt: 0,
    refreshedAt: null,
    lastRefreshAttemptAt: 0,
  });
  expect(fs.readFileSync(path.join(root, 'backup/telegram-pairings.json'), 'utf8')).toBe(original);
  expect(await normalizeHostMetadata(root, path.join(root, 'second-backup'))).toBe(0);
  expect(fs.existsSync(path.join(root, 'second-backup'))).toBe(false);
});

it('validates every file before changing any original', async () => {
  write('circuit-breaker.json', { timestamp: '1970-01-01T00:00:00Z' });
  write('skills/marketplaces.json', { sources: [{ addedAt: '2026-02-30T00:00:00Z', refreshedAt: null }] });
  const original = fs.readFileSync(path.join(root, 'circuit-breaker.json'), 'utf8');
  await expect(normalizeHostMetadata(root, path.join(root, 'backup'))).rejects.toThrow('Invalid timestamp');
  expect(fs.readFileSync(path.join(root, 'circuit-breaker.json'), 'utf8')).toBe(original);
  expect(fs.existsSync(path.join(root, 'backup'))).toBe(false);
});

it('never overwrites an existing backup or changes originals if backup preparation fails', async () => {
  write('circuit-breaker.json', { timestamp: '1970-01-01T00:00:00Z' });
  write('backup/circuit-breaker.json', { preserve: true });
  await expect(normalizeHostMetadata(root, path.join(root, 'backup'))).rejects.toThrow();
  expect(read('circuit-breaker.json').timestamp).toBe('1970-01-01T00:00:00Z');
  expect(read('backup/circuit-breaker.json')).toEqual({ preserve: true });
});

it('refuses a live host and leaves files untouched', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path.join(root, 'ncl.sock'), resolve));
  try {
    await expect(normalizeHostMetadata(root, path.join(root, 'backup'))).rejects.toThrow('Stop the host');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
