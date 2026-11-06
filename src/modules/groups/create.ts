/**
 * Create an agent group (DB row + on-disk scaffold).
 *
 * Centralizes folder allocation (slugify + global dedupe + path-traversal
 * guard), DB insert, and `initGroupFilesystem` so the CLI (`ncl groups
 * create`) and the UI (`POST /api/groups`) follow identical rules.
 *
 * Caller-supplied `folder` is preferred verbatim if free; otherwise the
 * function derives a slug from `name` and dedupes with `-2`, `-3`, ...
 * suffixes (matching `modules/agent-to-agent/create-agent.ts`).
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import type { AgentGroup } from '../../types.js';
import { normalizeName } from '../agent-to-agent/db/agent-destinations.js';

export interface CreateGroupInput {
  name: string;
  /** Optional explicit folder; otherwise derived from `name`. */
  folder?: string;
  /** Optional initial body for `groups/<folder>/CLAUDE.local.md`. */
  instructions?: string;
}

export class GroupCreateError extends Error {
  constructor(
    public readonly code: 'invalid_name' | 'invalid_folder' | 'folder_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'GroupCreateError';
  }
}

/** Slug the user's folder string the same way we'd slug a name. */
function sanitizeFolder(raw: string): string {
  // Allow lowercase alphanumerics, dashes, dots, and underscores; collapse anything else.
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned;
}

/**
 * Allocate a folder name that doesn't collide with an existing agent group
 * and that resolves to a path inside `GROUPS_DIR` (no `..` traversal).
 */
export function allocateGroupFolder(name: string, requestedFolder?: string): string {
  if (requestedFolder !== undefined) {
    const f = sanitizeFolder(requestedFolder);
    if (!f) throw new GroupCreateError('invalid_folder', 'folder is empty after sanitization');
    if (getAgentGroupByFolder(f)) {
      throw new GroupCreateError('folder_conflict', `folder already in use: ${f}`);
    }
    assertWithinGroupsDir(f);
    return f;
  }
  const base = normalizeName(name);
  let folder = base;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${base}-${suffix}`;
    suffix++;
  }
  assertWithinGroupsDir(folder);
  return folder;
}

function assertWithinGroupsDir(folder: string): void {
  const resolved = path.resolve(GROUPS_DIR, folder);
  const root = path.resolve(GROUPS_DIR);
  if (!resolved.startsWith(root + path.sep)) {
    throw new GroupCreateError('invalid_folder', `folder escapes groups dir: ${folder}`);
  }
}

/**
 * Create an agent group end-to-end: insert the row, scaffold the on-disk
 * directory (`groups/<folder>/`, `CLAUDE.local.md`, container_configs row,
 * .claude-shared/ etc.), and return the persisted record.
 */
export function createGroup(input: CreateGroupInput): AgentGroup {
  const name = input.name?.trim();
  if (!name) throw new GroupCreateError('invalid_name', 'name is required');

  const folder = allocateGroupFolder(name, input.folder);
  const group: AgentGroup = {
    id: `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    folder,
    agent_provider: null,
    created_at: Date.now(),
  };

  createAgentGroup(group);
  initGroupFilesystem(group, { instructions: input.instructions });
  return group;
}
