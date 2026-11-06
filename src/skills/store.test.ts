import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { setSkillsStoreRoot, readMarketplaceRecords } from './store.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-catalog-'));
  setSkillsStoreRoot(root);
});
afterEach(() => {
  setSkillsStoreRoot(null);
  fs.rmSync(root, { recursive: true, force: true });
});

it('preserves numeric dates and nullable fields without normalizing opaque values', () => {
  const source = {
    id: 's',
    addedAt: 0,
    refreshedAt: null,
    lastRefreshAttemptAt: 0,
    opaque: { createdAt: '2026-01-01T00:00:00Z' },
  };
  fs.writeFileSync(path.join(root, 'marketplaces.json'), JSON.stringify({ sources: [source] }));
  expect(readMarketplaceRecords()).toEqual([source]);
});

it('refuses legacy timestamp strings, malformed JSON and invalid shapes without defaulting to empty catalogs', () => {
  expect(readMarketplaceRecords()).toEqual([]);
  for (const contents of [
    '{"sources":[{"addedAt":"1970-01-01T00:00:00Z","refreshedAt":null}]}',
    '{"sources":[{"addedAt":0}]}',
    '{"sources":null}',
    '{invalid',
  ]) {
    fs.writeFileSync(path.join(root, 'marketplaces.json'), contents);
    expect(() => readMarketplaceRecords()).toThrow();
    expect(fs.readFileSync(path.join(root, 'marketplaces.json'), 'utf8')).toBe(contents);
  }
});
