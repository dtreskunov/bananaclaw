import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
import { ApprovalBubble } from './ApprovalBubble';
import { ApprovalCard } from './ApprovalCard';
import { MessageBubble } from './MessageBubble';
import type { PendingApprovalDto } from '../types';

const approval: PendingApprovalDto = {
  approvalId: 'approval',
  action: 'install_packages',
  title: 'Install package',
  details: null,
  packages: null,
  options: [],
  agentGroupId: 'agent',
  agentGroupName: 'Research agent',
  createdAt: '2026-10-31T01:00:00Z',
};
describe('shared approval bubble chrome', () => {
  it.each([false, true])('uses the common sender and timestamp for reference=%s', (reference) => {
    const node = ApprovalBubble({ approval, busy: false, onReview: vi.fn(), onRespond: vi.fn(), reference });
    expect(node.type).toBe(MessageBubble);
    expect(node.props.from).toBe('Research agent');
    expect(node.props.timestamp).toBe(approval.createdAt);
    expect(node.props['data-msg-id']).toBe('approval:approval');
    expect(node.props.children.type).toBe(ApprovalCard);
  });
  it('timestamps a resolved response using the decision time, without duplicating metadata in its body', () => {
    const resolved = { ...approval, status: 'approved' as const, resolvedAt: '2026-10-31T01:01:00Z' };
    const node = ApprovalBubble({ approval: resolved, busy: false, onReview: vi.fn(), onRespond: vi.fn() });
    expect(node.props.timestamp).toBe(resolved.resolvedAt);
    expect(node.props.from).toBe('Research agent');
  });
});
