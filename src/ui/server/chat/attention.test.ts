import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = vi.hoisted(() => `${process.cwd()}/.test-tmp/attention-${process.pid}`);
vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: root,
}));
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { createApproval, getApproval, updateApprovalStatus } from '../../../db/approvals.js';
import { createApprovalWorkflow } from '../../../modules/approvals/workflows.js';
import { initSessionFolder } from '../../../session-manager.js';
import { readInteractionSync } from './attention.js';
import { canRespondToApproval } from './interaction-access.js';

const NOW = 1791223200000;
beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,created_at) VALUES('viewer','web',${NOW}),('other','web',${NOW});
    INSERT INTO agent_groups(id,name,folder,created_at)
      VALUES('g','Group','group',${NOW}),('g2','Other','other',${NOW});
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('viewer','g',${NOW});
    INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
      VALUES('mg','web','web','group:g',1,${NOW}),('mg2','web','web','group:g2',1,${NOW});
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
      VALUES('w','mg','g','per-thread',${NOW}),('w2','mg2','g2','per-thread',${NOW});
    INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
      VALUES('s','g','mg','t',${NOW}),('s2','g2','mg2','t2',${NOW});
  `);
  initSessionFolder('g', 's');
  initSessionFolder('g2', 's2');
});
afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

function approval(id: string, account = false, session = 's') {
  createApproval({
    id,
    request_id: id,
    session_id: session,
    created_at: NOW,
    input: {
      action: account ? 'request_access' : 'install_packages',
      payload: account ? { resource_url: 'https://example.test', reason: 'Need access' } : {},
      title: 'Review',
      options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
    },
  });
  if (account) createApprovalWorkflow(id, id);
}

function admin(user = 'viewer', group: string | null = 'g') {
  getDb()
    .prepare('INSERT INTO user_roles(user_id,role,agent_group_id,granted_at) VALUES(?,?,?,?)')
    .run(user, group === null ? 'owner' : 'admin', group, NOW);
}

describe('authorized approval attention', () => {
  it('uses stable canonical IDs and returns navigation only to admins, not members', () => {
    approval('approval-b');
    approval('approval-a');
    expect(readInteractionSync('viewer')).toEqual({ approvals: [], attention: [] });
    admin();
    const data = readInteractionSync('viewer');
    expect(data.attention).toEqual(
      ['approval-a', 'approval-b'].map((id) => ({
        id,
        origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'mg' },
        readCursor: { sessionId: 's', key: expect.stringMatching(/^[a-f0-9]{32}$/) },
      })),
    );
    expect(JSON.stringify(data.attention)).not.toContain('Review');
    expect(readInteractionSync('other').attention).toEqual([]);
  });

  it('filters before aggregation and respects scoped admin access across groups', () => {
    approval('visible');
    approval('hidden', false, 's2');
    admin();
    expect(readInteractionSync('viewer').attention.map((row) => row.id)).toEqual(['visible']);
    admin('other', 'g2');
    expect(readInteractionSync('other').attention.map((row) => row.id)).toEqual(['hidden']);
    expect(canRespondToApproval('viewer', getApproval('hidden')!)).toBe(false);
  });

  it('includes all approval variants without disclosing private progress or selections', () => {
    admin();
    approval('confirmation');
    approval('access', true);
    approval('setup', true);
    getDb().exec("UPDATE interactions SET kind='account_setup' WHERE id='setup'");
    getDb().exec(`UPDATE interaction_progress SET data_json='{"connectionId":"private-selection"}'`);
    const before = getDb().prepare('SELECT * FROM interaction_progress ORDER BY id').all();
    const data = readInteractionSync('viewer');
    expect(data.attention.map((row) => row.id)).toEqual(['access', 'confirmation', 'setup']);
    expect(JSON.stringify(data.attention)).not.toContain('private-selection');
    expect(data.attention.every((row) => Object.keys(row).sort().join(',') === 'id,origin,readCursor')).toBe(true);
    expect(getDb().prepare('SELECT * FROM interaction_progress ORDER BY id').all()).toEqual(before);
  });

  it('removes resolved requests and excludes applying, terminal and expired decisions', () => {
    admin();
    approval('pending');
    approval('applying');
    approval('rejected');
    approval('expired');
    updateApprovalStatus('expired', 'expired');
    updateApprovalStatus('applying', 'applying');
    updateApprovalStatus('rejected', 'rejected');
    expect(readInteractionSync('viewer').attention.map((row) => row.id)).toEqual(['pending']);
    updateApprovalStatus('pending', 'approved');
    expect(readInteractionSync('viewer').attention).toEqual([]);
    expect(readInteractionSync('viewer').approvals.some((row) => row.id === 'applying')).toBe(true);
  });

  it('retains global references without advertising unavailable response controls', () => {
    createApproval({
      id: 'global',
      request_id: 'global',
      created_at: NOW,
      input: { action: 'install_packages', payload: {}, title: 'Global', options: [] },
    });
    admin();
    expect(readInteractionSync('viewer').attention).toEqual([]);
    admin('other', null);
    expect(readInteractionSync('other').attention).toEqual([]);
    expect(readInteractionSync('other').approvals.map((row) => row.id)).toEqual(['global']);
    expect(canRespondToApproval('viewer', getApproval('global')!)).toBe(false);
    expect(canRespondToApproval('other', getApproval('global')!)).toBe(true);
  });

  it('does not advertise a confirmation that has no available response controls', () => {
    admin();
    approval('no-actions');
    getDb().exec("UPDATE interactions SET input_json=json_set(input_json,'$.options',json('[]'))");
    const data = readInteractionSync('viewer');
    expect(data.approvals).toHaveLength(1);
    expect(data.attention).toEqual([]);
  });
});
