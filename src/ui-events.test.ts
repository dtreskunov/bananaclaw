import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestDb, runMigrations, closeDb, getDb } from './db/index.js';
import { createApproval, updateApprovalStatus } from './db/approvals.js';
import { addMember, removeMember } from './modules/permissions/db/agent-group-members.js';
import { onUiChange, type UiChange } from './ui-events.js';

let off = () => {};
beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,created_at) VALUES('u','web','now');
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group','now');
  `);
});
afterEach(() => {
  off();
  closeDb();
});

describe('committed UI invalidation coverage', () => {
  it('invalidates global approvals even without an originating session', async () => {
    const listener = vi.fn();
    off = onUiChange(listener);
    createApproval({
      id: 'a',
      request_id: 'a',
      created_at: new Date().toISOString(),
      input: { action: 'test', payload: {}, title: 'Review', options: [] },
    });
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ kind: 'interactions' });
    listener.mockClear();
    updateApprovalStatus('a', 'cancelled');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ kind: 'interactions' });
  });

  it('reads only after the outer transaction commits and publishes no rolled-back state', async () => {
    const counts: number[] = [];
    off = onUiChange((_change: UiChange) => {
      counts.push((getDb().prepare('SELECT COUNT(*) AS n FROM agent_group_members').get() as { n: number }).n);
    });
    const member = { user_id: 'u', agent_group_id: 'g', added_by: null, added_at: 'now' };
    expect(() =>
      getDb().transaction(() => {
        addMember(member);
        expect(counts).toEqual([]);
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    await Promise.resolve();
    expect(counts).toEqual([0]);
    getDb().transaction(() => addMember(member))();
    await Promise.resolve();
    removeMember('u', 'g');
    await Promise.resolve();
    expect(counts).toEqual([0, 1, 0]);
  });
});
