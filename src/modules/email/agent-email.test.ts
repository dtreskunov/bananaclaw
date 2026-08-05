import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { createAgentGroup, getAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { allocateEmailSlug, getEnabledAgentGroupForEmailAlias, reconcileAgentEmail } from './agent-email.js';

const DOMAIN = 'bananaclaw.app';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

function seedGroup(id: string, name: string): void {
  createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('agent email routing', () => {
  it('allocates a unique local part and wires inbound, replies, and outbound delivery', () => {
    seedGroup('ag-one', 'Treskowitz');
    seedGroup('ag-two', 'Treskowitz');

    expect(allocateEmailSlug({ id: 'ag-one', name: 'Treskowitz' }, DOMAIN)).toBe('treskowitz');
    updateAgentGroup('ag-one', { email_slug: 'treskowitz', email_enabled: 1 });
    reconcileAgentEmail(getAgentGroup('ag-one')!, DOMAIN);

    const mailbox = getMessagingGroupByPlatform('resend', 'resend:treskowitz@bananaclaw.app', 'resend');
    expect(mailbox).toMatchObject({ unknown_sender_policy: 'public', is_group: 1 });
    expect(getMessagingGroupAgents(mailbox!.id).map((row) => row.agent_group_id)).toEqual(['ag-one']);
    expect(getDestinationByName('ag-one', 'email')).toMatchObject({
      target_type: 'channel',
      target_id: mailbox!.id,
    });
    expect(getEnabledAgentGroupForEmailAlias('treskowitz@bananaclaw.app')).toMatchObject({
      id: 'ag-one',
      name: 'Treskowitz',
    });
    expect(allocateEmailSlug({ id: 'ag-two', name: 'Treskowitz' }, DOMAIN)).toBe('treskowitz-2');
  });

  it('keeps an old alias routable after rename and closes it when email is disabled', () => {
    seedGroup('ag-one', 'Agent');
    updateAgentGroup('ag-one', { email_slug: 'old-agent', email_enabled: 1 });
    reconcileAgentEmail(getAgentGroup('ag-one')!, DOMAIN);

    updateAgentGroup('ag-one', { email_slug: 'new-agent' });
    reconcileAgentEmail(getAgentGroup('ag-one')!, DOMAIN);

    expect(getEnabledAgentGroupForEmailAlias('old-agent@bananaclaw.app')?.id).toBe('ag-one');
    expect(getEnabledAgentGroupForEmailAlias('new-agent@bananaclaw.app')?.id).toBe('ag-one');
    const currentMailbox = getMessagingGroupByPlatform('resend', 'resend:new-agent@bananaclaw.app', 'resend');
    expect(getDestinationByName('ag-one', 'email')?.target_id).toBe(currentMailbox?.id);

    updateAgentGroup('ag-one', { email_enabled: 0 });
    reconcileAgentEmail(getAgentGroup('ag-one')!, DOMAIN);
    expect(getEnabledAgentGroupForEmailAlias('old-agent@bananaclaw.app')).toBeUndefined();
    expect(getDestinationByName('ag-one', 'email')).toBeUndefined();
  });
});
