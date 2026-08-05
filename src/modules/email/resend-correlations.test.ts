import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createResendOutboundCorrelation, getResendOutboundCorrelationByToken } from './resend-correlations.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES ('ag-1', 'Agent', 'agent', NULL, datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO sessions
       (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, created_at)
     VALUES ('session-1', 'ag-1', NULL, NULL, NULL, 'active', 'stopped', datetime('now'))`,
  ).run();
});

afterEach(() => closeDb());

describe('Resend outbound correlations', () => {
  it('stores and resolves a response token', () => {
    createResendOutboundCorrelation({
      correlation_token: 'token-1',
      origin_session_id: 'session-1',
      email_thread_id: 'resend:agent@example.com:recipient@example.net:hash',
      created_at: '2026-08-05T00:00:00.000Z',
    });

    expect(getResendOutboundCorrelationByToken('token-1')).toMatchObject({
      correlation_token: 'token-1',
      origin_session_id: 'session-1',
      email_thread_id: 'resend:agent@example.com:recipient@example.net:hash',
    });
  });

  it('deletes correlations with their originating session', () => {
    createResendOutboundCorrelation({
      correlation_token: 'token-1',
      origin_session_id: 'session-1',
      email_thread_id: 'resend:agent@example.com:recipient@example.net:hash',
      created_at: '2026-08-05T00:00:00.000Z',
    });

    getDb().prepare("DELETE FROM sessions WHERE id = 'session-1'").run();

    expect(getResendOutboundCorrelationByToken('token-1')).toBeUndefined();
  });
});
