/**
 * Tests for pickApprover + pickApprovalDelivery — the approver-selection
 * half of what used to live in src/access.ts. Moved here in PR #7 alongside
 * the approvals re-tier.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { seedUserWithIdentity } from '../../test-utils/seed-identity.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

function now(): number {
  return Date.now();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

async function mountMockAdapter(
  channelType: string,
  openDM?: (handle: string) => Promise<string>,
): Promise<{ delivered: OutboundMessage[]; openDMCalls: string[] }> {
  const delivered: OutboundMessage[] = [];
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  return { delivered, openDMCalls };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

describe('pickApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', () => {
    seedUser('u-owner', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', () => {
    expect(pickApprover('ag-1')).toEqual([]);
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    const u1 = seedUserWithIdentity('telegram', '111');
    const u2 = seedUserWithIdentity('telegram', '222');

    const result = await pickApprovalDelivery([u1, u2], 'telegram');
    expect(result?.userId).toBe(u1);
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    const tg = seedUserWithIdentity('telegram', '111');
    const dc = seedUserWithIdentity('discord', '222');

    const result = await pickApprovalDelivery([tg, dc], 'discord');
    expect(result?.userId).toBe(dc);
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    const tg = seedUserWithIdentity('telegram', '111');

    const result = await pickApprovalDelivery([tg], 'discord');
    expect(result?.userId).toBe(tg);
  });

  it('returns null when nobody is reachable', async () => {
    const tg = seedUserWithIdentity('telegram', '111');
    expect(await pickApprovalDelivery([tg], 'telegram')).toBeNull();
  });
});
