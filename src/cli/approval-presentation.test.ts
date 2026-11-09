import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getUserDisplayName } from '../modules/permissions/db/users.js';
import { presentCliApproval } from './approval-presentation.js';
import { presentApproval } from '../ui/server/chat/approval-presentation.js';
import './resources/groups.js';
import './resources/members.js';
import './resources/roles.js';
import './resources/wirings.js';
import './resources/destinations.js';
import './resources/messaging-groups.js';

beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,display_name,created_at)
      VALUES('user-uuid','resend','Alice',1767225600000);
    INSERT INTO identities(user_id,channel,handle,verified_at)
      VALUES('user-uuid','web','user-uuid',1767225600000),
            ('user-uuid','resend','alice@example.net',1767225600000);
    INSERT INTO agent_groups(id,name,folder,created_at)
      VALUES('agent-id','Assistant','assistant',1767225600000),
            ('target-id','Researcher','researcher',1767225600000);
    INSERT INTO messaging_groups(id,channel_type,platform_id,instance,name,is_group,created_at)
      VALUES('channel-id','telegram','team-chat','telegram','Team chat',1,1767225600000);
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,created_at)
      VALUES('wiring-id','channel-id','agent-id',1767225600000);
  `);
});
afterEach(closeDb);

describe('readable CLI approval context', () => {
  it.each(['members-add', 'roles-grant'])('names the user and agent for %s without changing arguments', (command) => {
    const args = { user: 'user-uuid', group: 'agent-id', role: 'admin' };
    const before = structuredClone(args);
    const display = presentCliApproval(command, args);
    expect(display.summary).toBe('User: Alice\nAgent: Assistant');
    expect(display.command).toBe(`ncl ${command} --user user-uuid --group agent-id --role admin`);
    expect(args).toEqual(before);
    expect(presentApproval('cli_command', { frame: { command, args } }).details).toBe(
      `${display.summary}\n\n${display.command}`,
    );
  });

  it.each([
    ['groups-update', 'agent-id', 'Assistant'],
    ['messaging-groups-update', 'channel-id', 'Team chat (telegram)'],
    ['wirings-delete', 'wiring-id', 'Team chat (telegram) -> Assistant'],
  ])('resolves resource-specific --id values for %s', (command, id, label) => {
    const display = presentCliApproval(command, { id });
    expect(display.summary).toContain(label);
    expect(display.command).toBe(`ncl ${command} --id ${id}`);
  });

  it.each([
    ['agent', 'target-id', 'Researcher'],
    ['channel', 'channel-id', 'Team chat (telegram)'],
  ])('resolves %s destinations using their declared target type', (target_type, target_id, label) => {
    expect(presentCliApproval('destinations-add', { agent_group_id: 'agent-id', target_type, target_id }).summary).toBe(
      `Agent: Assistant\nDestination: ${label}`,
    );
  });

  it('deduplicates equivalent group flags and leaves opaque or unrelated values alone', () => {
    expect(
      presentCliApproval('members-add', {
        group: 'agent-id',
        agent_group_id: 'agent-id',
        user: 'user-uuid',
        name: 'target-id',
      }).summary,
    ).toBe('Agent: Assistant\nUser: Alice');
    expect(
      presentCliApproval('groups-update', {
        id: 'agent-id',
        group: 'agent-id',
        agent_group_id: 'agent-id',
      }).summary,
    ).toBe('Agent: Assistant');
    expect(presentCliApproval('groups-update', { id: 'missing' }).summary).toBe('');
    expect(presentCliApproval('unknown-command', { id: 'agent-id' }).summary).toBe('');
  });

  it.each([
    ['Alice', 'Alice'],
    [null, 'resend:alice@example.net'],
    ['   ', 'resend:alice@example.net'],
  ])('uses the available user name or external handle: %s', (displayName, label) => {
    getDb().prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, 'user-uuid');
    expect(getUserDisplayName('user-uuid')).toBe(label);
    expect(presentCliApproval('members-add', { user: 'user-uuid' }).summary).toBe(`User: ${label}`);
  });

  it('does not present a web identity UUID as a readable user name', () => {
    getDb().prepare("UPDATE users SET display_name=NULL WHERE id='user-uuid'").run();
    getDb().prepare("DELETE FROM identities WHERE channel='resend'").run();
    expect(getUserDisplayName('user-uuid')).toBe('Unnamed user');
    expect(getUserDisplayName('missing')).toBe('Unavailable user');
  });
});
