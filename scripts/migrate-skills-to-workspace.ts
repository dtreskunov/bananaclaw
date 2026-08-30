/**
 * One-off: move host-wide installed skills into each agent group's workspace.
 *
 * Installed skills used to live in `data/skills/installed/<slug>` and be
 * mounted into every container. They are now vendored per group as sparse
 * checkouts under `groups/<folder>/skills/.catalogs/`. This re-installs each
 * skill into exactly the groups whose current selection already resolved to
 * it, so behaviour is unchanged the moment it finishes.
 *
 * Idempotent: a group that already has the skill is skipped. Run with
 * `--apply` to make changes; the default is a dry run.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAllContainerConfigs } from '../src/db/container-configs.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { installCatalogSkill, SkillInstallError } from '../src/skills/install.js';
import { listCatalogs } from '../src/skills/marketplace.js';
import { skillsStoreRoot } from '../src/skills/store.js';

interface LegacyRecord {
  slug: string;
  marketplaceId: string | null;
  plugin: string | null;
  repo: string;
}

function legacyRecords(): LegacyRecord[] {
  const file = path.join(skillsStoreRoot(), 'installed.json');
  try {
    return Object.values(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, LegacyRecord>);
  } catch {
    return [];
  }
}

/** Which groups had this slug active under their stored selection. */
function groupsUsing(slug: string): { gid: string; folder: string }[] {
  const out: { gid: string; folder: string }[] = [];
  for (const cfg of getAllContainerConfigs()) {
    let selection: string[] | 'all';
    let disabled: string[];
    try {
      selection = JSON.parse(cfg.skills) as string[] | 'all';
      disabled = JSON.parse(cfg.disabled_skills ?? '[]') as string[];
    } catch {
      continue;
    }
    if (disabled.includes(slug)) continue;
    if (selection !== 'all' && !selection.includes(slug)) continue;
    const group = getAgentGroup(cfg.agent_group_id);
    if (group) out.push({ gid: group.id, folder: group.folder });
  }
  return out;
}

function main(): void {
  const apply = process.argv.includes('--apply');
  initDb(path.join(DATA_DIR, 'v2.db'));

  const records = legacyRecords();
  if (records.length === 0) {
    console.log('No legacy installed.json entries — nothing to migrate.');
    return;
  }

  // The plugin name isn't always recorded; fall back to searching the catalogs.
  const catalogs = listCatalogs();
  let installed = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    const catalog = catalogs.find((entry) => entry.id === record.marketplaceId);
    const plugin =
      record.plugin ?? catalog?.plugins.find((p) => p.skills.some((s) => s.slug === record.slug))?.name ?? null;
    if (!record.marketplaceId || !plugin) {
      console.warn(`skip ${record.slug}: no catalog/plugin (repo ${record.repo})`);
      failed += 1;
      continue;
    }

    for (const group of groupsUsing(record.slug)) {
      const target = path.join(process.cwd(), 'groups', group.folder, 'skills', record.slug);
      if (fs.existsSync(target)) {
        skipped += 1;
        continue;
      }
      if (!apply) {
        console.log(`would install ${record.slug} → ${group.folder}`);
        installed += 1;
        continue;
      }
      try {
        installCatalogSkill({
          groupFolder: group.folder,
          marketplaceId: record.marketplaceId,
          plugin,
          slug: record.slug,
        });
        console.log(`installed ${record.slug} → ${group.folder}`);
        installed += 1;
      } catch (err) {
        const detail = err instanceof SkillInstallError ? err.message : String(err);
        console.error(`FAILED ${record.slug} → ${group.folder}: ${detail}`);
        failed += 1;
      }
    }
  }

  console.log(`\n${apply ? 'installed' : 'would install'}: ${installed}, already present: ${skipped}, failed: ${failed}`);
  if (!apply) console.log('Dry run — re-run with --apply to make changes.');
}

main();
