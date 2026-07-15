/**
 * Archive an agent group: dump restorable DB rows to JSON inside the group
 * folder, stop running containers, run the FK cascade, then rename the
 * group folder and per-group session tree with a `~` suffix so the
 * scanners (and the operator) see them as archived.
 *
 * No schema change. The DB row is gone after this runs; the router has
 * nothing to route to. Restore is CLI-only (`ncl groups restore`).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { cascadeDeleteAgentGroup, type CascadeCounts } from '../../db/cascade-delete-agent-group.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';

export interface ArchiveResult {
  id: string;
  folder: string;
  archivedFolder: string;
  archivedSessionsDir: string | null;
  archiveJsonPath: string;
  cascade: CascadeCounts;
}

export interface ArchiveDump {
  version: 1;
  archived_at: string;
  archived_by: { user_id: string; display_name?: string | null };
  agent_group: Record<string, unknown>;
  container_config: Record<string, unknown> | null;
  messaging_group_agents: Array<Record<string, unknown>>;
  agent_group_members: Array<Record<string, unknown>>;
  user_roles: Array<Record<string, unknown>>;
  agent_destinations_owned: Array<Record<string, unknown>>;
  agent_destinations_pointing: Array<Record<string, unknown>>;
  pending_sender_approvals: Array<Record<string, unknown>>;
  pending_channel_approvals: Array<Record<string, unknown>>;
  pending_approvals: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
}

/**
 * Resolve `<base>~`; if it exists, try `<base>~2`, `<base>~3`, … and
 * return the first free path. Pure naming — does not touch the filesystem.
 */
export function nextArchiveSuffix(basePath: string): string {
  let candidate = `${basePath}~`;
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${basePath}~${n}`;
    n += 1;
    if (n > 1000) throw new Error(`unable to allocate archive suffix near ${basePath}`);
  }
  return candidate;
}

function dumpRows(
  groupId: string,
): ArchiveDump['agent_group'] extends unknown ? Omit<ArchiveDump, 'archived_at' | 'archived_by' | 'version'> : never {
  const db = getDb();
  const group = db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(groupId) as
    | Record<string, unknown>
    | undefined;
  if (!group) throw new Error(`group not found: ${groupId}`);

  const cfg = db.prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(groupId) as
    | Record<string, unknown>
    | undefined;
  const wirings = db.prepare('SELECT * FROM messaging_group_agents WHERE agent_group_id = ?').all(groupId) as Array<
    Record<string, unknown>
  >;
  const members = db.prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ?').all(groupId) as Array<
    Record<string, unknown>
  >;
  const roles = db.prepare('SELECT * FROM user_roles WHERE agent_group_id = ?').all(groupId) as Array<
    Record<string, unknown>
  >;

  let destsOwned: Array<Record<string, unknown>> = [];
  let destsPointing: Array<Record<string, unknown>> = [];
  if (hasTable(db, 'agent_destinations')) {
    destsOwned = db.prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ?').all(groupId) as Array<
      Record<string, unknown>
    >;
    destsPointing = db
      .prepare('SELECT * FROM agent_destinations WHERE target_type = ? AND target_id = ?')
      .all('agent', groupId) as Array<Record<string, unknown>>;
  }

  const senderApprovals = db
    .prepare('SELECT * FROM pending_sender_approvals WHERE agent_group_id = ?')
    .all(groupId) as Array<Record<string, unknown>>;
  const channelApprovals = db
    .prepare('SELECT * FROM pending_channel_approvals WHERE agent_group_id = ?')
    .all(groupId) as Array<Record<string, unknown>>;

  let pendingApprovals: Array<Record<string, unknown>> = [];
  if (hasTable(db, 'pending_approvals')) {
    pendingApprovals = db
      .prepare(
        'SELECT * FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
      )
      .all(groupId, groupId) as Array<Record<string, unknown>>;
  }

  const sessions = db.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(groupId) as Array<
    Record<string, unknown>
  >;
  const questions = db
    .prepare('SELECT * FROM questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)')
    .all(groupId) as Array<Record<string, unknown>>;

  return {
    agent_group: group,
    container_config: cfg ?? null,
    messaging_group_agents: wirings,
    agent_group_members: members,
    user_roles: roles,
    agent_destinations_owned: destsOwned,
    agent_destinations_pointing: destsPointing,
    pending_sender_approvals: senderApprovals,
    pending_channel_approvals: channelApprovals,
    pending_approvals: pendingApprovals,
    sessions,
    questions,
  } as Omit<ArchiveDump, 'archived_at' | 'archived_by' | 'version'>;
}

function renderRestoreReadme(
  originalFolder: string,
  groupId: string,
  archivedAt: string,
  actor: { user_id: string; display_name?: string | null },
): string {
  return [
    `# Archived agent group: ${originalFolder}`,
    '',
    `- **Group id:** \`${groupId}\``,
    `- **Archived at:** ${archivedAt}`,
    `- **Archived by:** ${actor.display_name ?? actor.user_id} (\`${actor.user_id}\`)`,
    '',
    'This folder is the archived state of an agent group. The DB row',
    'and every dependent row (wirings, members, scoped roles, destinations,',
    'sessions, pending approvals, pending questions) were dumped to',
    '`archive.json` in this directory and then deleted from the central DB.',
    '',
    'Session data on disk lives at `data/v2-sessions/' + groupId + '~/` (if',
    'the group ever ran).',
    '',
    '## Restore',
    '',
    'From the host shell:',
    '',
    '```bash',
    `ncl groups restore --folder ${originalFolder}`,
    '```',
    '',
    'Restore re-inserts the DB rows in FK-safe order, renames this folder',
    `back to \`${originalFolder}\` (and the sessions tree back to its`,
    'original id), and removes `archive.json` + this README.',
    '',
    'By default sessions and pending_* rows are NOT replayed — pass',
    '`--with-sessions` if you also want those back.',
    '',
    '## Manual restore (fallback)',
    '',
    'If the CLI is unavailable, the JSON in `archive.json` carries every',
    'row needed to re-create the group. Insert them in this order:',
    '`agent_groups` → `container_configs` → `agent_group_members` →',
    '`user_roles` → `messaging_group_agents` → `agent_destinations`, then',
    'rename the folder and the sessions directory.',
    '',
  ].join('\n');
}

export function archiveAgentGroup(
  groupId: string,
  actor: { user_id: string; display_name?: string | null },
): ArchiveResult {
  const group = getAgentGroup(groupId);
  if (!group) throw new Error(`group not found: ${groupId}`);

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    throw new Error(`group folder missing on disk: ${groupDir}`);
  }

  // 1. Snapshot all DB state before any deletes.
  const archivedAt = new Date().toISOString();
  const dump: ArchiveDump = {
    version: 1,
    archived_at: archivedAt,
    archived_by: actor,
    ...dumpRows(groupId),
  };

  // 2. Write the dump + operator-facing README into the still-present folder.
  const archiveJsonPath = path.join(groupDir, 'archive.json');
  fs.writeFileSync(archiveJsonPath, JSON.stringify(dump, null, 2), 'utf-8');
  fs.writeFileSync(
    path.join(groupDir, 'ARCHIVE_RESTORE.md'),
    renderRestoreReadme(group.folder, groupId, archivedAt, actor),
    'utf-8',
  );

  // 3. Stop any running containers — no respawn.
  const sessions = getSessionsByAgentGroup(groupId);
  for (const s of sessions) {
    if (isContainerRunning(s.id)) {
      killContainer(s.id, 'archived');
    }
  }

  // 4. Cascade-delete every dependent row.
  const cascade = cascadeDeleteAgentGroup(groupId);

  // 5. Rename groups/<folder> → groups/<folder>~ (collision-safe).
  const archivedFolder = nextArchiveSuffix(groupDir);
  fs.renameSync(groupDir, archivedFolder);

  // 6. Rename data/v2-sessions/<id> → data/v2-sessions/<id>~ if present.
  const sessionsDir = path.resolve(DATA_DIR, 'v2-sessions', groupId);
  let archivedSessionsDir: string | null = null;
  if (fs.existsSync(sessionsDir)) {
    archivedSessionsDir = nextArchiveSuffix(sessionsDir);
    fs.renameSync(sessionsDir, archivedSessionsDir);
  }

  log.info('Archived agent group', {
    groupId,
    folder: group.folder,
    archivedFolder,
    archivedSessionsDir,
    cascade,
  });

  return {
    id: groupId,
    folder: group.folder,
    archivedFolder,
    archivedSessionsDir,
    archiveJsonPath: path.join(archivedFolder, 'archive.json'),
    cascade,
  };
}
