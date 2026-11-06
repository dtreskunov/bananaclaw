import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = vi.hoisted(() => `${process.cwd()}/.test-tmp/attention-${process.pid}`);
vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: root,
}));
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { answerQuestion, createQuestion, getQuestion } from '../../../db/sessions.js';
import { createApproval, updateApprovalStatus } from '../../../db/approvals.js';
import { createApprovalWorkflow } from '../../../modules/approvals/workflows.js';
import { initSessionFolder } from '../../../session-manager.js';
import { readInteractionSync } from './attention.js';
import { questionResponseOrigin } from './interaction-access.js';
import { insertIdentity } from '../../../modules/permissions/db/identities.js';

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

function question(id: string, session = 's') {
  createQuestion({
    id,
    session_id: session,
    message_out_id: `out-${id}`,
    in_reply_to: null,
    platform_id: session === 's' ? 'group:g' : 'group:g2',
    channel_type: 'web',
    thread_id: session === 's' ? 't' : 't2',
    created_at: NOW,
    input: { question: 'Choose?', responseMode: 'text', options: [] },
  });
}

function approval(id: string, account = false) {
  createApproval({
    id,
    request_id: id,
    session_id: 's',
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

describe('authorized global input attention', () => {
  it('uses stable canonical IDs, retains pending queues and returns navigation only', () => {
    question('q-b');
    question('q-a');
    const data = readInteractionSync('viewer');
    expect(data.attention).toEqual(
      ['q-a', 'q-b'].map((id) => ({
        id,
        origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'mg' },
      })),
    );
    expect(JSON.stringify(data.attention)).not.toContain('Choose?');
    expect(readInteractionSync('other').attention).toEqual([]);
  });

  it('filters before aggregation and respects scoped admin access across groups', () => {
    question('visible');
    question('hidden', 's2');
    approval('confirmation');
    expect(readInteractionSync('viewer').attention.map((row) => row.id)).toEqual(['visible']);
    admin();
    expect(readInteractionSync('viewer').attention.map((row) => row.id)).toEqual(['confirmation', 'visible']);
    admin('other', 'g2');
    expect(readInteractionSync('other').attention.map((row) => row.id)).toEqual(['hidden']);
  });

  it('includes all four variants without disclosing private progress or selections', () => {
    admin();
    question('question');
    approval('confirmation');
    approval('access', true);
    approval('setup', true);
    getDb().exec("UPDATE interactions SET kind='account_setup' WHERE id='setup'");
    getDb().exec(`UPDATE interaction_progress SET data_json='{"connectionId":"private-selection"}'`);
    const before = getDb().prepare('SELECT * FROM interaction_progress ORDER BY id').all();
    const data = readInteractionSync('viewer');
    expect(data.attention.map((row) => row.id)).toEqual(['access', 'confirmation', 'question', 'setup']);
    expect(JSON.stringify(data.attention)).not.toContain('private-selection');
    expect(data.attention.every((row) => Object.keys(row).sort().join(',') === 'id,origin')).toBe(true);
    expect(getDb().prepare('SELECT * FROM interaction_progress ORDER BY id').all()).toEqual(before);
  });

  it('removes answered requests and excludes applying, terminal and expired decisions', () => {
    admin();
    question('q');
    approval('applying');
    approval('rejected');
    approval('expired');
    updateApprovalStatus('expired', 'expired');
    updateApprovalStatus('applying', 'applying');
    updateApprovalStatus('rejected', 'rejected');
    expect(readInteractionSync('viewer').attention.map((row) => row.id)).toEqual(['q']);
    answerQuestion('q', { responseType: 'text', value: 'Done', userId: 'other', answeredAt: NOW });
    expect(readInteractionSync('viewer').attention).toEqual([]);
    expect(readInteractionSync('viewer').approvals.some((row) => row.id === 'applying')).toBe(true);
  });

  it('retains read-only global references without advertising unavailable response controls', () => {
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
  });

  it('does not count requests after membership is revoked or their route no longer resolves', () => {
    question('q');
    expect(readInteractionSync('viewer').attention).toHaveLength(1);
    getDb().exec("DELETE FROM agent_group_members WHERE user_id='viewer'");
    expect(readInteractionSync('viewer').attention).toEqual([]);
    getDb().exec(`INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('viewer','g',${NOW})`);
    getDb().exec("UPDATE interactions SET platform_id='different' WHERE id='q'");
    expect(readInteractionSync('viewer').attention).toEqual([]);
  });

  it('does not advertise a confirmation that has no available response controls', () => {
    admin();
    approval('no-actions');
    getDb().exec("UPDATE interactions SET input_json=json_set(input_json,'$.options',json('[]'))");
    const data = readInteractionSync('viewer');
    expect(data.approvals).toHaveLength(1);
    expect(data.attention).toEqual([]);
  });

  it('shares question authorization with the response endpoint rather than exposing foreign recipients', () => {
    question('a');
    question('b');
    getDb().exec(`
      INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('other','g',${NOW});
      UPDATE sessions SET messaging_group_id=NULL,thread_id=NULL WHERE id='s';
      INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
        VALUES('a','resend','resend','resend:a',0,${NOW}),('b','resend','resend','resend:b',0,${NOW});
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
        VALUES('a','a','g','agent-shared',${NOW}),('b','b','g','agent-shared',${NOW});
      UPDATE interactions SET channel_type='resend',thread_id=NULL,platform_id='resend:'||id;
    `);
    insertIdentity({ userId: 'viewer', channel: 'resend', handle: 'a' });
    insertIdentity({ userId: 'other', channel: 'resend', handle: 'b' });
    expect(readInteractionSync('viewer').attention.map((row) => row.id)).toEqual(['a']);
    expect(readInteractionSync('other').attention.map((row) => row.id)).toEqual(['b']);
    expect(questionResponseOrigin('other', getQuestion('a')!)).toBeNull();
  });
});
