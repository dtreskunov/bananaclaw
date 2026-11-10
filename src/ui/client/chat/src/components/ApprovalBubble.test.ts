import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
import { ApprovalBubble } from './ApprovalBubble';
import { ApprovalCard } from './ApprovalCard';
import { AccessRequestCard, AccountRequestSummary } from './AccessRequestCard';
import { testAccountInteraction } from '../conversation-test-fixtures';
import { currentUserId, groupId, threadId, channelType } from '../state';
import { MessageBubble } from './MessageBubble';
import type { PendingApprovalDto } from '../types';

const approval: PendingApprovalDto = {
  kind: 'confirmation',
  status: 'pending',
  supportsResponseMessage: false,

  id: 'approval',
  action: 'install_packages',
  title: 'Install package',
  details: null,
  packages: null,
  options: [],
  agentGroupId: 'agent',
  agentGroupName: 'Research agent',
  createdAt: 1793408400000,
};
describe('shared approval bubble chrome', () => {
  beforeEach(() => {
    groupId.value = 'current-agent';
    currentUserId.value = 'current-user';
  });
  it('uses the common sender and timestamp', () => {
    const node = ApprovalBubble({ approval, busy: false, onRespond: vi.fn() });
    expect(node.type).toBe(MessageBubble);
    expect(node.props.from).toBe('Research agent');
    expect(node.props.timestamp).toBe(approval.createdAt);
    expect(node.props['data-msg-id']).toBe(approval.id);
    expect(node.props.children.type).toBe(ApprovalCard);
    expect(node.props).not.toHaveProperty('read');
  });
  it('timestamps a resolved response using the decision time, without duplicating metadata in its body', () => {
    const resolved = {
      ...approval,
      status: 'approved' as const,
      resolvedAt: 1793408460000,
      respondedBy: { userId: 'another-user', displayName: 'Another user' },
    };
    const node = ApprovalBubble({ approval: resolved, busy: false, onRespond: vi.fn() });
    expect(node.props.timestamp).toBe(resolved.resolvedAt);
    expect(node.props.from).toBe('Another user');
    expect(node.props.class).toContain('msg in');
  });
  it('omits attribution for a request from the current agent', () => {
    groupId.value = approval.agentGroupId;
    const node = ApprovalBubble({ approval, busy: false, onRespond: vi.fn() });
    expect(node.props.from).toBeUndefined();
    expect(node.props.class).toContain('msg out');
  });
  it.each(['approved', 'rejected'] as const)('renders a current-user %s decision without attribution', (status) => {
    const node = ApprovalBubble({
      approval: { ...approval, status, respondedBy: { userId: 'current-user', displayName: 'Current user' } },
      busy: false,

      onRespond: vi.fn(),
    });
    expect(node.props.from).toBeUndefined();
    expect(node.props.class).toContain('msg in');
  });
  it.each(['pending', 'applying', 'failed'] as const)(
    'renders access controls in the requesting transcript for status=%s',
    (status) => {
      groupId.value = 'agent';
      threadId.value = 'requesting-thread';
      channelType.value = 'web';
      const access = testAccountInteraction({
        id: approval.id,
        agentGroupId: 'agent',
        status,
        origin: {
          agentGroupId: 'agent',
          threadId: 'requesting-thread',
          channelType: 'web',
          messagingGroupId: 'web-agent',
        },
      });
      const node = ApprovalBubble({ approval: access, busy: false, onRespond: vi.fn() });
      expect(node.type).toBe(MessageBubble);
      expect(node.props.class).toContain('markdown access-approval-message');
      expect(node.props.children.type).toBe(AccessRequestCard);
      expect(node.props.children.props.request).toBe(access);
      expect(node.props.children.props.disabled).toBe(status === 'applying');
    },
  );
  it('keeps off-thread and resolved approvals as ordinary cards without loading private accounts', () => {
    groupId.value = 'agent';
    threadId.value = 'another-thread';
    channelType.value = 'web';
    const access = testAccountInteraction({
      id: approval.id,
      agentGroupId: 'agent',
      origin: {
        agentGroupId: 'agent',
        threadId: 'requesting-thread',
        channelType: 'web',
        messagingGroupId: 'web-agent',
      },
    });
    const offThread = ApprovalBubble({
      approval: access,
      busy: false,

      onRespond: vi.fn(),
    });
    expect(offThread.props.children.type).toBe(AccountRequestSummary);
    threadId.value = 'requesting-thread';
    const resolved = ApprovalBubble({
      approval: { ...access, status: 'completed' },
      busy: false,

      onRespond: vi.fn(),
    });
    expect(resolved.props.children.type).toBe(AccountRequestSummary);
  });
  it('renders restored failures as audit-only without loading accounts or offering private retry', () => {
    groupId.value = 'agent';
    threadId.value = 'requesting-thread';
    channelType.value = 'web';
    const node = ApprovalBubble({
      approval: testAccountInteraction({
        status: 'failed',
        retryable: false,
        agentGroupId: 'agent',
        origin: { agentGroupId: 'agent', threadId: 'requesting-thread', channelType: 'web', messagingGroupId: 'web' },
      }),
      busy: false,
      onRespond: vi.fn(),
    });
    expect(node.props.children.type).toBe(AccountRequestSummary);
  });
});
