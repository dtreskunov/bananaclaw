import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupWithAgentCount,
} from './messaging-groups.js';
import type { MessagingGroup } from '../types.js';

function mg(overrides: Partial<MessagingGroup> & { id: string }): MessagingGroup {
  return {
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: Date.now(),
    ...overrides,
  };
}

beforeEach(() => runMigrations(initTestDb()));
afterEach(closeDb);

describe('channel-instance baseline and namespace uniqueness', () => {
  it('requires an instance and defaults it to channel_type at the public boundary', () => {
    const columns = getDb().pragma('table_info(messaging_groups)') as { name: string; notnull: number }[];
    expect(columns.find((column) => column.name === 'instance')?.notnull).toBe(1);
    createMessagingGroup(mg({ id: 'mg-default' }));
    expect(getDb().prepare("SELECT instance FROM messaging_groups WHERE id='mg-default'").pluck().get()).toBe('slack');
  });

  it('allows sibling instances but rejects duplicate explicit and default namespaces', () => {
    createMessagingGroup(mg({ id: 'mg-default' }));
    createMessagingGroup(mg({ id: 'mg-tester', instance: 'slack-tester' }));
    expect(() => createMessagingGroup(mg({ id: 'duplicate' }))).toThrow('UNIQUE');
    expect(() => createMessagingGroup(mg({ id: 'duplicate', instance: 'slack-tester' }))).toThrow('UNIQUE');
    expect(getDb().prepare('SELECT count(*) FROM messaging_groups').pluck().get()).toBe(2);
  });

  it('retains wired namespace rows and foreign keys across repeated initialization', () => {
    const db = getDb();
    createMessagingGroup(mg({ id: 'mg-keep', instance: 'slack-tester' }));
    db.exec(`
      INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',0);
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,created_at)
        VALUES('w','mg-keep','g',0);
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES('s','g','mg-keep',0);
    `);
    runMigrations(db);
    expect(db.prepare("SELECT instance FROM messaging_groups WHERE id='mg-keep'").pluck().get()).toBe('slack-tester');
    expect(db.prepare('SELECT messaging_group_id FROM messaging_group_agents').pluck().get()).toBe('mg-keep');
    expect(db.prepare('SELECT messaging_group_id FROM sessions').pluck().get()).toBe('mg-keep');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('lookup asymmetry — inbound exact-only vs outbound default-first', () => {
  beforeEach(() => {
    createMessagingGroup(mg({ id: 'mg-tester', instance: 'alpha-tester' }));
    createMessagingGroup(mg({ id: 'mg-default' }));
  });

  it('resolves default-instance inbound lookups without an explicit instance', () => {
    expect(getMessagingGroupWithAgentCount('slack', 'slack:C1')?.mg.id).toBe('mg-default');
  });

  it('resolves named inbound lookups exactly without hijacking another namespace', () => {
    expect(getMessagingGroupWithAgentCount('slack', 'slack:C1', 'alpha-tester')?.mg.id).toBe('mg-tester');
    expect(getMessagingGroupWithAgentCount('slack', 'slack:C1', 'slack-unknown')).toBeNull();
  });

  it('prefers the default instance for outbound lookups', () => {
    expect(getMessagingGroupByPlatform('slack', 'slack:C1')?.id).toBe('mg-default');
  });

  it('resolves explicit outbound instances exactly', () => {
    expect(getMessagingGroupByPlatform('slack', 'slack:C1', 'alpha-tester')?.id).toBe('mg-tester');
    expect(getMessagingGroupByPlatform('slack', 'slack:C1', 'slack-unknown')).toBeUndefined();
  });

  it('falls back deterministically when only named instances exist', () => {
    getDb().prepare("DELETE FROM messaging_groups WHERE id='mg-default'").run();
    createMessagingGroup(mg({ id: 'mg-zeta', instance: 'zeta' }));
    expect(getMessagingGroupByPlatform('slack', 'slack:C1')?.id).toBe('mg-tester');
  });
});
