/**
 * Restore an archived agent group from `groups/<folder>~/archive.json`.
 *
 * Re-inserts rows in FK-safe order, renames the folder + sessions tree
 * back, and removes the archive markers. CLI-only — the agent and the
 * web UI cannot trigger this.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { ArchiveDump } from './archive-group.js';

export interface RestoreOptions {
  /** Replay `sessions`, `pending_*` rows too. Default false. */
  withSessions?: boolean;
}

export interface RestoreResult {
  id: string;
  folder: string;
  restoredFrom: string;
  inserted: {
    agent_groups: number;
    container_configs: number;
    agent_group_members: number;
    user_roles: number;
    messaging_group_agents: number;
    agent_destinations_owned: number;
    agent_destinations_pointing: number;
    sessions: number;
    pending_sender_approvals: number;
    pending_channel_approvals: number;
    pending_approvals: number;
    questions: number;
  };
}

/**
 * Resolve `<base>` against `groups/`. Accepts either the live name
 * (`my-group`) or any of the archived suffixed forms (`my-group~`,
 * `my-group~2`, …). Picks the unsuffixed-first match; bails if none.
 */
export function resolveArchivedFolder(folderArg: string): string {
  const base = folderArg.replace(/~\d*$/, '');
  const candidates = [`${base}~`];
  let n = 2;
  while (n <= 50) {
    candidates.push(`${base}~${n}`);
    n += 1;
  }
  for (const c of candidates) {
    const p = path.join(GROUPS_DIR, c);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'archive.json'))) {
      return p;
    }
  }
  throw new Error(`No archived group found for folder: ${folderArg}`);
}

function insertAgentGroup(row: Record<string, unknown>): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at${'site_slug' in row ? ', site_slug' : ''}${'site_enabled' in row ? ', site_enabled' : ''})
       VALUES (@id, @name, @folder, @agent_provider, @created_at${'site_slug' in row ? ', @site_slug' : ''}${'site_enabled' in row ? ', @site_enabled' : ''})`,
    )
    .run(row);
}

/** Generic dynamic insert — uses the row keys for both column list and named params. */
function insertRow(table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const colList = cols.join(', ');
  const paramList = cols.map((c) => `@${c}`).join(', ');
  getDb().prepare(`INSERT INTO ${table} (${colList}) VALUES (${paramList})`).run(row);
}

export function restoreAgentGroup(folderArg: string, opts: RestoreOptions = {}): RestoreResult {
  const archivedDir = resolveArchivedFolder(folderArg);
  const archiveJsonPath = path.join(archivedDir, 'archive.json');
  const dump = JSON.parse(fs.readFileSync(archiveJsonPath, 'utf-8')) as ArchiveDump;
  if (dump.version !== 1) {
    throw new Error(`archive.json version ${dump.version} not supported`);
  }
  const group = dump.agent_group as { id: string; folder: string; name: string };

  // Collision checks BEFORE we touch anything.
  if (getAgentGroup(group.id)) {
    throw new Error(`cannot restore: agent group id "${group.id}" already in use`);
  }
  if (getAgentGroupByFolder(group.folder)) {
    throw new Error(`cannot restore: folder "${group.folder}" already in use`);
  }
  const liveFolderPath = path.join(GROUPS_DIR, group.folder);
  if (fs.existsSync(liveFolderPath)) {
    throw new Error(`cannot restore: groups/${group.folder} already exists on disk`);
  }
  const liveSessionsDir = path.join(DATA_DIR, 'v2-sessions', group.id);
  if (fs.existsSync(liveSessionsDir)) {
    throw new Error(`cannot restore: data/v2-sessions/${group.id} already exists on disk`);
  }

  const db = getDb();
  const counts = {
    agent_groups: 0,
    container_configs: 0,
    agent_group_members: 0,
    user_roles: 0,
    messaging_group_agents: 0,
    agent_destinations_owned: 0,
    agent_destinations_pointing: 0,
    sessions: 0,
    pending_sender_approvals: 0,
    pending_channel_approvals: 0,
    pending_approvals: 0,
    questions: 0,
  };

  const tx = db.transaction(() => {
    insertAgentGroup(dump.agent_group);
    counts.agent_groups = 1;

    if (dump.container_config) {
      insertRow('container_configs', dump.container_config);
      counts.container_configs = 1;
    }
    for (const m of dump.agent_group_members) {
      insertRow('agent_group_members', m);
      counts.agent_group_members += 1;
    }
    for (const r of dump.user_roles) {
      insertRow('user_roles', r);
      counts.user_roles += 1;
    }
    for (const w of dump.messaging_group_agents) {
      insertRow('messaging_group_agents', w);
      counts.messaging_group_agents += 1;
    }
    if (hasTable(db, 'agent_destinations')) {
      for (const d of dump.agent_destinations_owned) {
        insertRow('agent_destinations', d);
        counts.agent_destinations_owned += 1;
      }
      for (const d of dump.agent_destinations_pointing) {
        insertRow('agent_destinations', d);
        counts.agent_destinations_pointing += 1;
      }
    }
    if (opts.withSessions) {
      for (const s of dump.sessions) {
        insertRow('sessions', s);
        counts.sessions += 1;
      }
      for (const a of dump.pending_sender_approvals) {
        insertRow('pending_sender_approvals', a);
        counts.pending_sender_approvals += 1;
      }
      for (const a of dump.pending_channel_approvals) {
        insertRow('pending_channel_approvals', a);
        counts.pending_channel_approvals += 1;
      }
      if (hasTable(db, 'pending_approvals')) {
        for (const a of dump.pending_approvals) {
          insertRow('pending_approvals', a);
          counts.pending_approvals += 1;
        }
      }
      for (const q of dump.questions) {
        insertRow('questions', q);
        counts.questions += 1;
      }
    }
  });
  tx();

  // Rename folder back.
  fs.renameSync(archivedDir, liveFolderPath);
  // Best-effort: rename sessions tree back if present alongside.
  const archivedSessionsCandidates = [
    `${liveSessionsDir}~`,
    ...Array.from({ length: 49 }, (_, i) => `${liveSessionsDir}~${i + 2}`),
  ];
  for (const c of archivedSessionsCandidates) {
    if (fs.existsSync(c)) {
      fs.renameSync(c, liveSessionsDir);
      break;
    }
  }
  // Delete archive markers so the restored group is clean.
  try {
    fs.unlinkSync(path.join(liveFolderPath, 'archive.json'));
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(path.join(liveFolderPath, 'ARCHIVE_RESTORE.md'));
  } catch {
    /* ignore */
  }

  log.info('Restored agent group', { id: group.id, folder: group.folder, from: archivedDir, counts });

  return {
    id: group.id,
    folder: group.folder,
    restoredFrom: archivedDir,
    inserted: counts,
  };
}
