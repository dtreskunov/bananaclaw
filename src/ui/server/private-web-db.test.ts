import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession, hashToken } from './db.js';
import {
  createPrivateWebSession,
  inspectPrivateWebHandoff,
  lookupPrivateWebSession,
  redeemPrivateWebHandoff,
} from './private-web-db.js';

const USER_ID = 'web:test-user';
const GROUP_ID = 'ag-private-web';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, datetime('now'))`).run(
    USER_ID,
    'Test User',
  );
  createAgentGroup({
    id: GROUP_ID,
    name: 'Private Web',
    folder: 'private-web',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(() => closeDb());

function issue() {
  const uiSession = createSession(USER_ID, 60_000);
  return {
    uiSession,
    privateSession: createPrivateWebSession({
      parentSessionHash: hashToken(uiSession.token),
      userId: USER_ID,
      agentGroupId: GROUP_ID,
    }),
  };
}

describe('private web session lifecycle', () => {
  it('stores only token hashes and redeems a handoff once', () => {
    const { privateSession } = issue();
    const row = getDb().prepare('SELECT * FROM ui_private_web_sessions WHERE id = ?').get(privateSession.id) as {
      handoff_token_hash: string;
      secure_token_hash: string | null;
    };
    expect(row.handoff_token_hash).toBe(hashToken(privateSession.handoffToken));
    expect(row.handoff_token_hash).not.toContain(privateSession.handoffToken);
    expect(row.secure_token_hash).toBeNull();

    expect(inspectPrivateWebHandoff(privateSession.id, privateSession.handoffToken)?.agentGroupId).toBe(GROUP_ID);
    const redeemed = redeemPrivateWebHandoff(privateSession.id, privateSession.handoffToken);
    expect(redeemed?.session.userId).toBe(USER_ID);
    expect(redeemed && lookupPrivateWebSession(privateSession.id, redeemed.secureToken)?.agentGroupId).toBe(GROUP_ID);
    expect(redeemPrivateWebHandoff(privateSession.id, privateSession.handoffToken)).toBeNull();
  });

  it('is revoked when its parent UI session is deleted', () => {
    const { uiSession, privateSession } = issue();
    const redeemed = redeemPrivateWebHandoff(privateSession.id, privateSession.handoffToken);
    expect(redeemed).not.toBeNull();

    getDb().prepare('DELETE FROM ui_sessions WHERE token_hash = ?').run(hashToken(uiSession.token));
    expect(
      getDb().prepare('SELECT 1 FROM ui_private_web_sessions WHERE id = ?').get(privateSession.id),
    ).toBeUndefined();
    expect(redeemed && lookupPrivateWebSession(privateSession.id, redeemed.secureToken)).toBeNull();
  });

  it('rejects a redeemed session after 30 minutes of inactivity', () => {
    const { privateSession } = issue();
    const redeemed = redeemPrivateWebHandoff(privateSession.id, privateSession.handoffToken);
    expect(redeemed).not.toBeNull();
    getDb()
      .prepare("UPDATE ui_private_web_sessions SET last_used = datetime('now', '-31 minutes') WHERE id = ?")
      .run(privateSession.id);
    expect(redeemed && lookupPrivateWebSession(privateSession.id, redeemed.secureToken)).toBeNull();
  });
});
