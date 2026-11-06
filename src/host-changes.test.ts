import { parseTimestamp } from './time.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestDb, runMigrations, closeDb, getDb } from './db/index.js';
import { createApproval, updateApprovalStatus } from './db/approvals.js';
import { addMember, removeMember } from './modules/permissions/db/agent-group-members.js';
import { onHostChange, type HostChange } from './host-changes.js';
import { transaction, recordHostChange } from './db/transaction.js';
import { mutateInteraction } from './db/interactions.js';

let off = () => {};
beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,created_at) VALUES('u','web',1767225600000);
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',1767225600000);
  `);
});
afterEach(() => {
  off();
  closeDb();
});

describe('committed host changes', () => {
  it('invalidates global approvals even without an originating session', async () => {
    const listener = vi.fn();
    off = onHostChange(listener);
    createApproval({
      id: 'a',
      request_id: 'a',
      created_at: Date.now(),
      input: { action: 'test', payload: {}, title: 'Review', options: [] },
    });
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ kind: 'interactions', sessionId: null });
    listener.mockClear();
    updateApprovalStatus('a', 'cancelled');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ kind: 'interactions', sessionId: null });
  });

  it('reads only after the outer transaction commits and publishes no rolled-back state', async () => {
    const counts: number[] = [];
    off = onHostChange((_change: HostChange) => {
      counts.push((getDb().prepare('SELECT COUNT(*) AS n FROM agent_group_members').get() as { n: number }).n);
    });
    const member = { user_id: 'u', agent_group_id: 'g', added_by: null, added_at: parseTimestamp('2026-01-01T00:00:00.000Z') };
    expect(() =>
      transaction(getDb(), () => {
        addMember(member);
        expect(counts).toEqual([]);
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    await Promise.resolve();
    expect(counts).toEqual([]);
    transaction(getDb(), () => addMember(member))();
    await Promise.resolve();
    removeMember('u', 'g');
    await Promise.resolve();
    expect(counts).toEqual([1, 0]);
  });

  it('discards nested rollback notices and publishes only after the outer commit', async () => {
    const listener = vi.fn();
    off = onHostChange(listener);
    transaction(getDb(), () => {
      recordHostChange({ kind: 'sessions', sessionId: 'outer' });
      expect(() =>
        transaction(getDb(), () => {
          recordHostChange({ kind: 'sessions', sessionId: 'rolled-back' });
          throw new Error('rollback');
        })(),
      ).toThrow('rollback');
      transaction(getDb(), () => recordHostChange({ kind: 'sessions', sessionId: 'inner' }))();
      expect(listener).not.toHaveBeenCalled();
    })();
    await Promise.resolve();
    expect(listener.mock.calls.map(([change]) => change.sessionId)).toEqual(['outer', 'inner']);
  });

  it('discards inner committed notices when the outer transaction rolls back', async () => {
    const listener = vi.fn();
    off = onHostChange(listener);
    expect(() =>
      transaction(getDb(), () => {
        transaction(getDb(), () => recordHostChange({ kind: 'access' }))();
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects state mutation inside an unmanaged transaction', () => {
    expect(() => getDb().transaction(() => recordHostChange({ kind: 'access' }))()).toThrow(
      'shared transaction helper',
    );
  });

  it('retains the originating session when a mutation deletes an interaction', async () => {
    getDb().exec("INSERT INTO sessions(id,agent_group_id,created_at) VALUES('session','g',1767225600000)");
    createApproval({
      id: 'a',
      request_id: 'a',
      session_id: 'session',
      created_at: parseTimestamp('2026-01-01T00:00:00.000Z'),
      input: { action: 'test', payload: {}, title: 'Review', options: [] },
    });
    await Promise.resolve();
    const listener = vi.fn();
    off = onHostChange(listener);
    mutateInteraction('a', () => getDb().prepare("DELETE FROM interactions WHERE id='a'").run().changes > 0);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ kind: 'interactions', sessionId: 'session' });
  });
});
