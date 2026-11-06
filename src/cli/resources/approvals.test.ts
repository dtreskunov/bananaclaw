import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createApproval } from '../../db/approvals.js';
import { dispatch } from '../dispatch.js';
import './approvals.js';

beforeEach(() => {
  runMigrations(initTestDb());
  createApproval({
    id: 'current',
    request_id: 'current',
    created_at: 0,
    input: { action: 'test', title: 'Review', payload: {}, options: [] },
  });
});
afterEach(closeDb);

it.each([null, '1970-01-01T00:00:00Z'])(
  'rejects retired expiry filter %s rather than silently broadening the list',
  async (expires_at) => {
    const response = await dispatch(
      { id: 'list', command: 'approvals-list', args: { expires_at } },
      { caller: 'host' },
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('Expected obsolete filter rejection');
    expect(response.error.message).toContain('expiry filters are no longer supported');
  },
);

it('retains the ordinary created-at filter and external timestamp format', async () => {
  const response = await dispatch(
    { id: 'list', command: 'approvals-list', args: { created_at: '1970-01-01T00:00:00Z' } },
    { caller: 'host' },
  );
  expect(response).toMatchObject({ ok: true, data: [{ id: 'current', created_at: '1970-01-01T00:00:00.000Z' }] });
});
