/**
 * On-disk store for skill catalogs.
 *
 * Layout under `data/skills/` (gitignored, so it never dirties the repo or
 * collides on upgrade):
 *
 *   marketplaces.json       configured catalog sources
 *   cache/<marketplace-id>/ shallow git clone used to browse
 *
 * Installed skills are not stored here. They are vendored per agent group as
 * sparse checkouts under `groups/<folder>/skills/.catalogs/`, so their
 * provenance is whatever git records rather than a side table that can drift
 * out of sync with the files.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

export interface MarketplaceRecord {
  id: string;
  repo: string;
  ref: string;
  /** `name` from `.claude-plugin/marketplace.json`, when present. */
  label: string | null;
  description: string | null;
  /** Commit the local cache is currently at. */
  commit: string | null;
  addedAt: string;
  refreshedAt: string | null;
  /** Failed attempts never advance refreshedAt or replace the usable snapshot. */
  lastRefreshAttemptAt?: string | null;
  lastRefreshError?: string | null;
}

let storeRoot: string | null = null;

/** Root of the skill store. Overridable so tests can use a temp dir. */
export function skillsStoreRoot(): string {
  return storeRoot ?? path.join(DATA_DIR, 'skills');
}

export function setSkillsStoreRoot(dir: string | null): void {
  storeRoot = dir;
}

export function marketplaceCacheDir(id: string): string {
  return path.join(skillsStoreRoot(), 'cache', id);
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file + rename so a crash can't leave a truncated manifest. */
function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ── marketplace sources ───────────────────────────────────────────────────

export function readMarketplaceRecords(): MarketplaceRecord[] {
  const raw = readJsonFile<{ sources?: MarketplaceRecord[] }>(path.join(skillsStoreRoot(), 'marketplaces.json'), {});
  return Array.isArray(raw.sources) ? raw.sources : [];
}

export function getMarketplaceRecord(id: string): MarketplaceRecord | null {
  return readMarketplaceRecords().find((source) => source.id === id) ?? null;
}

export function putMarketplaceRecord(record: MarketplaceRecord): void {
  const sources = readMarketplaceRecords().filter((source) => source.id !== record.id);
  sources.push(record);
  sources.sort((a, b) => a.id.localeCompare(b.id));
  writeJsonFile(path.join(skillsStoreRoot(), 'marketplaces.json'), { sources });
}

export function deleteMarketplaceRecord(id: string): void {
  const sources = readMarketplaceRecords().filter((source) => source.id !== id);
  writeJsonFile(path.join(skillsStoreRoot(), 'marketplaces.json'), { sources });
}
