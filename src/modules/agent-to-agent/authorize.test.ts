/**
 * Unit tests for the agent-link authorization decision matrix.
 *
 * Covers every branch of authorizeAgentLink + authorizeAgentLinkRemoval.
 * Uses an in-memory DB so it doesn't need any mocks of the permission
 * helpers — the SUT exercises the real `hasAdminPrivilege` against
 * real user_roles + agent_groups rows.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { authorizeAgentLink, authorizeAgentLinkRemoval } from './authorize.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { AgentGroup, User } from '../../types.js';

const SRC = 'ag-src';
const TGT = 'ag-tgt';
const USR = 'u-1';

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: name, agent_provider: null, created_at: Date.now() };
}

function user(id: string): User {
  return { id, kind: 'web', display_name: id, created_at: Date.now() };
}

describe('authorizeAgentLink', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(initTestDb()); // safe — initTestDb resets _db each call
    createAgentGroup(group(SRC, 'src'));
    createAgentGroup(group(TGT, 'tgt'));
    createUser(user(USR));
  });

  afterEach(() => {
    closeDb();
  });

  it('rejects when source group is missing', () => {
    const d = authorizeAgentLink(USR, '', TGT);
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('unknown_source_group');
  });

  it('rejects when target group is missing', () => {
    const d = authorizeAgentLink(USR, SRC, '');
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('unknown_target_group');
  });

  it('rejects when source group does not exist', () => {
    const d = authorizeAgentLink(USR, 'ag-nope', TGT);
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('unknown_source_group');
  });

  it('rejects when target group does not exist', () => {
    const d = authorizeAgentLink(USR, SRC, 'ag-nope');
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('unknown_target_group');
  });

  it('rejects self-link (source === target)', () => {
    const d = authorizeAgentLink(USR, SRC, SRC);
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('self_link');
  });

  it('rejects a user with no admin rights at all', () => {
    const d = authorizeAgentLink(USR, SRC, TGT);
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('not_admin_on_source');
  });

  it('rejects a user who is admin on target only (no source rights)', () => {
    grantRole({
      user_id: USR,
      role: 'admin',
      agent_group_id: TGT,
      granted_by: null,
      granted_at: Date.now(),
    });
    const d = authorizeAgentLink(USR, SRC, TGT);
    expect(d.mode).toBe('denied');
    if (d.mode === 'denied') expect(d.reason).toBe('not_admin_on_source');
  });

  it('requires approval when scoped admin on source only', () => {
    grantRole({
      user_id: USR,
      role: 'admin',
      agent_group_id: SRC,
      granted_by: null,
      granted_at: Date.now(),
    });
    const d = authorizeAgentLink(USR, SRC, TGT);
    expect(d.mode).toBe('needs-approval');
    if (d.mode === 'needs-approval') {
      expect(d.reason).toBe('admin_source_only');
      expect(d.approverAgentGroupId).toBe(TGT);
    }
  });

  it('auto-applies when scoped admin on both groups', () => {
    grantRole({
      user_id: USR,
      role: 'admin',
      agent_group_id: SRC,
      granted_by: null,
      granted_at: Date.now(),
    });
    grantRole({
      user_id: USR,
      role: 'admin',
      agent_group_id: TGT,
      granted_by: null,
      granted_at: Date.now(),
    });
    const d = authorizeAgentLink(USR, SRC, TGT);
    expect(d.mode).toBe('auto');
    if (d.mode === 'auto') expect(d.reason).toBe('admin_on_both');
  });

  it('auto-applies when global admin (no scoped grants needed)', () => {
    grantRole({
      user_id: USR,
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: Date.now(),
    });
    const d = authorizeAgentLink(USR, SRC, TGT);
    expect(d.mode).toBe('auto');
  });

  it('auto-applies when owner (global)', () => {
    grantRole({
      user_id: USR,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: Date.now(),
    });
    const d = authorizeAgentLink(USR, SRC, TGT);
    expect(d.mode).toBe('auto');
  });
});

describe('authorizeAgentLinkRemoval', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(initTestDb());
    createAgentGroup(group(SRC, 'src'));
    createUser(user(USR));
  });

  afterEach(() => {
    closeDb();
  });

  it('rejects when source group missing', () => {
    const r = authorizeAgentLinkRemoval(USR, 'ag-nope');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknown_source_group');
  });

  it('rejects when caller has no admin on source', () => {
    const r = authorizeAgentLinkRemoval(USR, SRC);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_admin_on_source');
  });

  it('allows when caller has scoped admin on source', () => {
    grantRole({
      user_id: USR,
      role: 'admin',
      agent_group_id: SRC,
      granted_by: null,
      granted_at: Date.now(),
    });
    const r = authorizeAgentLinkRemoval(USR, SRC);
    expect(r.allowed).toBe(true);
  });

  it('allows when caller is owner', () => {
    grantRole({
      user_id: USR,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: Date.now(),
    });
    const r = authorizeAgentLinkRemoval(USR, SRC);
    expect(r.allowed).toBe(true);
  });
});
