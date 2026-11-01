import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { deleteVault } from '../../src/modules/credentials/agent-vault-client.js';

/** Deletes group authorization boundaries, never personal libraries or OAuth connections. */
export async function cleanupGatewayGroups(projectRoot: string): Promise<void> {
  const filename = path.join(projectRoot, 'data', 'v2.db');
  if (!fs.existsSync(filename)) return;
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  let groups: { id: string }[];
  try {
    groups = db.prepare('SELECT id FROM agent_groups ORDER BY id').all() as { id: string }[];
  } finally {
    db.close();
  }
  for (const group of groups) await deleteVault(group.id);
}
