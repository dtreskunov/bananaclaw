import { getDb } from '../../db/connection.js';
import { listAccessibleAgentGroups } from '../permissions/access.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { AgentVaultError, gatewayJson } from './agent-vault-client.js';
import { log } from '../../log.js';

export interface ManagedUser {
  id: string;
  library_vault: string;
}

interface PendingUser {
  user_id: string;
  revision: number;
}

const inFlight = new Map<string, Promise<ManagedUser>>();

export function credentialInstallationId(): string {
  const row = getDb().prepare('SELECT installation_id FROM credential_gateway_identity WHERE id=1').get() as
    | { installation_id: string }
    | undefined;
  if (!row?.installation_id) throw new Error('Credential gateway installation identity is missing');
  return row.installation_id;
}

export function synchronizeManagedUser(userId: string): Promise<ManagedUser> {
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const result = synchronize(userId).finally(() => inFlight.delete(userId));
  inFlight.set(userId, result);
  return result;
}

async function synchronize(userId: string): Promise<ManagedUser> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await synchronizeSnapshot(userId);
    if (result) return result;
  }
  throw new AgentVaultError('User permissions changed during gateway synchronization; retry', 409);
}

async function synchronizeSnapshot(userId: string): Promise<ManagedUser | null> {
  const db = getDb();
  const queued = db.prepare('SELECT revision FROM credential_gateway_sync WHERE user_id=?').get(userId) as
    | { revision: number }
    | undefined;
  const user = getUser(userId);
  const privileged = Boolean(user && (isOwner(userId) || isGlobalAdmin(userId)));
  const groups = user ? listAccessibleAgentGroups(userId) : [];
  let result: ManagedUser;
  try {
    result = await gatewayJson<ManagedUser>('PUT', '/v1/managed-users', 'managed user synchronization', {
      body: {
        installation_id: credentialInstallationId(),
        subject: userId,
        ...(user?.display_name ? { display_name: user.display_name } : {}),
        active: Boolean(user),
        role: privileged ? 'owner' : 'no-access',
        vault_grants: groups.map((group) => ({
          vault: group.id,
          role: hasAdminPrivilege(userId, group.id) ? 'admin' : 'proxy',
        })),
      },
    });
  } catch (error) {
    if (!(error instanceof AgentVaultError) || error.status !== 404) throw error;
    throw new AgentVaultError(
      'The gateway does not support shared connections; deploy the coordinated host/gateway release',
      409,
      'gateway_contract_mismatch',
    );
  }
  if (!result || typeof result.id !== 'string' || typeof result.library_vault !== 'string')
    throw new AgentVaultError('Gateway returned an invalid managed user', 502);
  const current = db.prepare('SELECT revision FROM credential_gateway_sync WHERE user_id=?').get(userId) as
    | { revision: number }
    | undefined;
  if (current?.revision !== queued?.revision) return null;
  if (queued)
    db.prepare('DELETE FROM credential_gateway_sync WHERE user_id=? AND revision=?').run(userId, queued.revision);
  return result;
}

export async function flushManagedUsers(): Promise<void> {
  for (;;) {
    const users = getDb()
      .prepare('SELECT user_id,revision FROM credential_gateway_sync ORDER BY user_id LIMIT 32')
      .all() as PendingUser[];
    if (!users.length) return;
    for (const user of users) await synchronizeManagedUser(user.user_id);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

export function startManagedUserSynchronization(): void {
  if (running) return;
  running = true;
  void tick().catch((error: unknown) =>
    log.error('Credential identity synchronization failed unexpectedly', { error }),
  );
}

async function tick(): Promise<void> {
  if (!running) return;
  try {
    await flushManagedUsers();
  } catch (error) {
    if (!(error instanceof AgentVaultError)) throw error;
    log.warn('Credential identity synchronization pending', { status: error.status, code: error.code });
  } finally {
    if (running) {
      timer = setTimeout(() => {
        void tick().catch((error: unknown) =>
          log.error('Credential identity synchronization failed unexpectedly', { error }),
        );
      }, 5000);
      timer.unref();
    }
  }
}

export function stopManagedUserSynchronization(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
