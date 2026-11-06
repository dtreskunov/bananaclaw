/**
 * Unit tests for applyAgentLink + removeAgentLink + validateLocalName.
 *
 * Exercises against an in-memory central DB. The projection invariant
 * (writeDestinations into session inbound.db) is mocked since session
 * file plumbing is covered by the broader agent-route.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../permissions/db/users.js';
import { applyAgentLink, removeAgentLink, validateLocalName, AgentLinkError } from './apply-link.js';
import { createDestination, getDestinations } from './db/agent-destinations.js';
import type { AgentGroup, User } from '../../types.js';

const SRC = 'ag-src';
const TGT = 'ag-tgt';

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: name, agent_provider: null, created_at: Date.now() };
}

function user(id: string): User {
  return { id, kind: 'web', display_name: id, created_at: Date.now() };
}

describe('validateLocalName', () => {
  it('passes a simple name', () => {
    expect(validateLocalName('shared')).toBe('shared');
  });

  it('normalizes mixed case + punctuation', () => {
    expect(validateLocalName('My Cool Agent!')).toBe('my-cool-agent');
  });

  it('rejects a name that normalizes to empty', () => {
    expect(() => validateLocalName('!!!')).not.toThrow(); // normalizeName falls back to 'unnamed'
    expect(validateLocalName('!!!')).toBe('unnamed');
  });

  it('rejects a name longer than 40 chars', () => {
    expect(() => validateLocalName('a'.repeat(41))).toThrow(AgentLinkError);
  });
});

describe('applyAgentLink', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(initTestDb());
    createAgentGroup(group(SRC, 'src'));
    createAgentGroup(group(TGT, 'tgt'));
    createUser(user('u-1'));
  });

  afterEach(() => {
    closeDb();
  });

  it('creates only the forward row by default', async () => {
    const r = await applyAgentLink({
      sourceAgentGroupId: SRC,
      targetAgentGroupId: TGT,
      localName: 'shared',
      createdBy: 'u-1',
    });
    expect(r.forward).toEqual({ agent_group_id: SRC, local_name: 'shared', target_id: TGT });
    expect(r.reverse).toBeNull();

    const srcRows = getDestinations(SRC);
    const tgtRows = getDestinations(TGT);
    expect(srcRows.length).toBe(1);
    expect(tgtRows.length).toBe(0);
    expect(srcRows[0].created_by).toBe('u-1');
  });

  it('creates both rows when alsoReverse=true (default reverse name = source folder)', async () => {
    const r = await applyAgentLink({
      sourceAgentGroupId: SRC,
      targetAgentGroupId: TGT,
      localName: 'shared',
      createdBy: 'u-1',
      alsoReverse: true,
    });
    expect(r.reverse).not.toBeNull();
    expect(r.reverse?.local_name).toBe('src');

    expect(getDestinations(SRC).length).toBe(1);
    expect(getDestinations(TGT).length).toBe(1);
  });

  it('uses reverseLocalName when provided', async () => {
    const r = await applyAgentLink({
      sourceAgentGroupId: SRC,
      targetAgentGroupId: TGT,
      localName: 'shared',
      createdBy: 'u-1',
      alsoReverse: true,
      reverseLocalName: 'parent',
    });
    expect(r.reverse?.local_name).toBe('parent');
  });

  it('rejects forward-side name collision', async () => {
    createDestination({
      agent_group_id: SRC,
      local_name: 'shared',
      target_type: 'channel',
      target_id: 'mg-x',
      created_at: Date.now(),
      created_by: null,
    });
    await expect(
      applyAgentLink({ sourceAgentGroupId: SRC, targetAgentGroupId: TGT, localName: 'shared', createdBy: 'u-1' }),
    ).rejects.toMatchObject({ code: 'name_collision' });
    expect(getDestinations(TGT).length).toBe(0); // didn't half-commit
  });

  it('rejects reverse-side name collision (and leaves forward unwritten)', async () => {
    createDestination({
      agent_group_id: TGT,
      local_name: 'src',
      target_type: 'channel',
      target_id: 'mg-x',
      created_at: Date.now(),
      created_by: null,
    });
    await expect(
      applyAgentLink({
        sourceAgentGroupId: SRC,
        targetAgentGroupId: TGT,
        localName: 'shared',
        createdBy: 'u-1',
        alsoReverse: true,
      }),
    ).rejects.toMatchObject({ code: 'reverse_name_collision' });
    // Forward also not written — pre-flight catches reverse before any insert.
    const srcRows = getDestinations(SRC);
    expect(srcRows.find((r) => r.local_name === 'shared')).toBeUndefined();
  });

  it('rejects missing source group', async () => {
    await expect(
      applyAgentLink({ sourceAgentGroupId: 'nope', targetAgentGroupId: TGT, localName: 'x', createdBy: null }),
    ).rejects.toMatchObject({ code: 'unknown_source_group' });
  });

  it('rejects missing target group', async () => {
    await expect(
      applyAgentLink({ sourceAgentGroupId: SRC, targetAgentGroupId: 'nope', localName: 'x', createdBy: null }),
    ).rejects.toMatchObject({ code: 'unknown_target_group' });
  });

  it('normalizes the local name', async () => {
    const r = await applyAgentLink({
      sourceAgentGroupId: SRC,
      targetAgentGroupId: TGT,
      localName: 'My Cool Agent',
      createdBy: null,
    });
    expect(r.forward.local_name).toBe('my-cool-agent');
  });
});

describe('removeAgentLink', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(initTestDb());
    createAgentGroup(group(SRC, 'src'));
    createAgentGroup(group(TGT, 'tgt'));
    createUser(user('u-1'));
  });

  afterEach(() => {
    closeDb();
  });

  it('removes an existing destination', async () => {
    await applyAgentLink({
      sourceAgentGroupId: SRC,
      targetAgentGroupId: TGT,
      localName: 'shared',
      createdBy: 'u-1',
    });
    expect(removeAgentLink(SRC, 'shared')).toEqual({ removed: true });
    expect(getDestinations(SRC).length).toBe(0);
  });

  it('reports false when nothing to remove', () => {
    expect(removeAgentLink(SRC, 'never-existed')).toEqual({ removed: false });
  });
});
