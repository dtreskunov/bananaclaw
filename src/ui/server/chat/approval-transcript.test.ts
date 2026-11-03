import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: `${process.cwd()}/.test-tmp/nanoclaw-approval-transcript-${process.pid}`,
}));
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn(() => false),
  recoverStoppedSession: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { deleteSession } from '../../../db/sessions.js';
import { createApproval, getApproval } from '../../../db/approvals.js';

import { inboundDbPath, initSessionFolder, openInboundDb, writeSessionMessage } from '../../../session-manager.js';
import { handleApprovalsResponse } from '../../../modules/approvals/response-handler.js';
import { registerApprovalHandler } from '../../../modules/approvals/primitive.js';
import { readConversation } from './conversation.js';
import { readChatHistory } from './chat.js';
import { approvalOrigin } from './approval-transcript.js';
import { createApprovalWorkflow, finishApprovalWorkflow } from '../../../modules/approvals/workflows.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
  diffConversation,
  parseConversationFrame,
  reduceConversation,
} from '../../shared/conversation-protocol.js';

const root = `${process.cwd()}/.test-tmp/nanoclaw-approval-transcript-${process.pid}`;
beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,display_name,created_at) VALUES('owner','web','Owner','now'),('member','web','Member','now');
    INSERT INTO user_roles(user_id,role,granted_at) VALUES('owner','owner','now');
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Agent','agent','now');
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('member','g','now');
    INSERT INTO messaging_groups(id,channel_type,platform_id,instance,is_group,created_at)
      VALUES('web','web','group:g','web',1,'now'),('telegram','telegram','remote','telegram',1,'now');
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
      VALUES('w-web','web','g','agent-shared','now'),('w-telegram','telegram','g','agent-shared','now');
    INSERT INTO sessions(id,agent_group_id,messaging_group_id,status,created_at)
      VALUES('s','g','web','active','now');
  `);
  initSessionFolder('g', 's');
  writeSessionMessage('g', 's', {
    id: 'source',
    kind: 'chat',
    timestamp: new Date(Date.now() - 1000).toISOString(),
    channelType: 'web',
    platformId: 'group:g',
    threadId: 'source-thread',
    content: '{"text":"Install the requested tool.","senderId":"human"}',
  });
  registerApprovalHandler('history-test', async ({ notify }) => {
    notify('Approved and applied.');
  });
});
afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
function request(action = 'history-test', payload: Record<string, unknown> = {}) {
  createApproval({
    id: 'approval',
    session_id: 's',
    origin_message_id: 'source',
    request_id: 'request',
    created_at: new Date().toISOString(),
    input: {
      action: action,
      payload: payload,
      title: 'Install tool',
      options: JSON.parse(
        '[{"label":"Approve","selectedLabel":"Approved","value":"approve"},{"label":"Reject","selectedLabel":"Declined","value":"reject"}]',
      ),
    },
  });
}
const view = (thread = 'source-thread', user = 'owner') => readConversation(user, 'g', thread);
const approvals = (conversation = view()) => conversation.interactions.filter((item) => item.kind !== 'question');

describe('retained approval transcript', () => {
  it('retains account-setup purpose and its responder after completion and reload', () => {
    request('request_access', { resource_url: 'https://api.example.com/', reason: 'Read the report' });
    createApprovalWorkflow('approval', 'account-setup');
    getDb().prepare("UPDATE interactions SET kind='account_setup' WHERE id='approval'").run();
    expect(approvals()[0]).toMatchObject({
      kind: 'account_setup',
      status: 'pending',
    });
    finishApprovalWorkflow(
      'approval',
      'completed',
      'Account setup confirmed; no agent access was granted.',
      false,
      undefined,
      'owner',
    );
    expect(approvals()[0]).toMatchObject({
      kind: 'account_setup',
      status: 'completed',
      respondedBy: { userId: 'owner', displayName: 'Owner' },
    });
  });
  it('places a request only in its exact originating thread, even in a shared session', () => {
    request();
    expect(approvalOrigin('owner', getApproval('approval')!)).toEqual({
      agentGroupId: 'g',
      threadId: 'source-thread',
      channelType: 'web',
      messagingGroupId: 'web',
    });
    expect(approvals()[0]).toMatchObject({
      id: 'approval',
      status: 'pending',
      title: 'Install tool',
    });
    expect(approvals(view('other-thread'))).toEqual([]);
    expect(approvals(view('source-thread', 'member'))).toEqual([]);
  });

  it.each(['approve', 'reject'])(
    'retains the request, %s decision, actor and message in its authoritative row after reload',
    async (value) => {
      request();
      const before = view();
      await handleApprovalsResponse({
        questionId: 'approval',
        value,
        userId: 'owner',
        channelType: 'web',
        platformId: 'admin-dm',
        threadId: null,
        message: 'Keep existing work.',
      });
      expect(getApproval('approval')?.status).toBe(value === 'approve' ? 'approved' : 'rejected');
      const after = view();
      const bubble = approvals(after).find((item) => item.id === 'approval');
      expect(bubble).toMatchObject({
        status: value === 'approve' ? 'approved' : 'rejected',
        decision: value,
        responseMessage: 'Keep existing work.',
        respondedBy: { userId: 'owner', displayName: 'Owner' },
      });
      expect(bubble?.createdAt).toBe(approvals(before)[0]?.createdAt);
      expect(after.messages.filter((message) => message.text.includes('User message from'))).toEqual([]);
      expect(
        readChatHistory('owner', 'g', 'source-thread').some((message) => message.text.includes('User message from')),
      ).toBe(true);
      const db = openInboundDb('g', 's');
      try {
        expect(
          db
            .prepare("SELECT COUNT(*) FROM messages_in WHERE json_extract(content,'$.approvalId')='approval'")
            .pluck()
            .get(),
        ).toBe(1);
      } finally {
        db.close();
      }
      const snapshot = {
        kind: 'snapshot' as const,
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        streamId: 'approvals',
        revision: 0,
        conversation: before,
      };
      const settled = reduceConversation(
        reduceConversation(null, parseConversationFrame(snapshot)),
        parseConversationFrame({
          kind: 'update',
          protocolVersion: CONVERSATION_PROTOCOL_VERSION,
          streamId: 'approvals',
          baseRevision: 0,
          revision: 1,
          changes: diffConversation(before, after),
        }),
      );
      expect(approvals(settled.conversation).find((item) => item.id === bubble?.id)).toEqual(bubble);
      expect(approvals().find((item) => item.id === bubble?.id)).toEqual(bubble);
    },
  );

  it('does not infer an actionable thread when a recorded origin is missing', () => {
    request();
    getDb().prepare("UPDATE interactions SET origin_message_id='missing' WHERE id='approval'").run();
    expect(approvalOrigin('owner', getApproval('approval')!)).toBeNull();
    expect(approvals()).toEqual([]);
  });

  it('does not invent a root thread for legacy unanchored shared sessions', () => {
    request();
    getDb().prepare("UPDATE interactions SET origin_message_id=NULL WHERE id='approval'").run();
    expect(approvalOrigin('owner', getApproval('approval')!)).toBeNull();
  });

  it('treats a missing session store as an unavailable origin without creating another database', () => {
    request();
    const file = inboundDbPath('g', 's');
    fs.rmSync(file);
    expect(approvalOrigin('owner', getApproval('approval')!)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('retains the failure explanation rather than hiding the only user-visible error', async () => {
    request();
    registerApprovalHandler('history-test', async () => {
      throw new Error('The image build failed');
    });
    await handleApprovalsResponse({
      questionId: 'approval',
      value: 'approve',
      userId: 'owner',
      channelType: 'web',
      platformId: 'admin-dm',
      threadId: null,
    });
    const approval = approvals()[0];
    expect(approval?.status).toBe('failed');
    expect(approval?.outcomeMessage).toContain('The image build failed');
  });

  it('deletes retained approval history when its conversation is deleted', () => {
    request();
    expect(() => deleteSession('s')).toThrow('approval');
    deleteSession('s', true);
    expect(getApproval('approval')).toBeUndefined();
  });
});
