/**
 * On-disk store for marketplace-installed skills.
 *
 * Layout under `data/skills/` (gitignored, so installs never dirty the repo
 * or collide on upgrade):
 *
 *   installed/<slug>/       the skill itself, mounted RO at /app/skills-installed
 *   installed.json          provenance: where each slug came from + tree digest
 *   marketplaces.json       configured catalog sources
 *   cache/<marketplace-id>/ shallow git clone used to browse and install
 *
 * Provenance is what makes "re-review every version" enforceable — without a
 * recorded repo/ref/commit/digest an installed skill is an anonymous folder.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

export interface InstalledSkillRecord {
  slug: string;
  /** Marketplace this came from, or null for a direct repo install. */
  marketplaceId: string | null;
  /** Plugin bundle within the marketplace, when the manifest declared one. */
  plugin: string | null;
  repo: string;
  ref: string;
  commit: string;
  /** Source path within the repo (e.g. `skills/pdf`). */
  path: string;
  license: string | null;
  /** sha256 over the installed tree — changes when the upstream files change. */
  digest: string;
  installedAt: string;
  installedBy: string | null;
}

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
}

let storeRoot: string | null = null;

/** Root of the skill store. Overridable so tests can use a temp dir. */
export function skillsStoreRoot(): string {
  return storeRoot ?? path.join(DATA_DIR, 'skills');
}

export function setSkillsStoreRoot(dir: string | null): void {
  storeRoot = dir;
}

export function installedSkillsDir(): string {
  return path.join(skillsStoreRoot(), 'installed');
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

// ── installed-skill provenance ────────────────────────────────────────────

export function readInstalledRecords(): Record<string, InstalledSkillRecord> {
  return readJsonFile<Record<string, InstalledSkillRecord>>(path.join(skillsStoreRoot(), 'installed.json'), {});
}

export function getInstalledRecord(slug: string): InstalledSkillRecord | null {
  return readInstalledRecords()[slug] ?? null;
}

export function putInstalledRecord(record: InstalledSkillRecord): void {
  const all = readInstalledRecords();
  all[record.slug] = record;
  writeJsonFile(path.join(skillsStoreRoot(), 'installed.json'), all);
}

export function deleteInstalledRecord(slug: string): void {
  const all = readInstalledRecords();
  if (!(slug in all)) return;
  delete all[slug];
  writeJsonFile(path.join(skillsStoreRoot(), 'installed.json'), all);
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
