import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from './CredentialsApi';
import type { PendingApprovalDto } from '../types';
import { approvalMessageDrafts, clearApprovalMessage } from '../approval-messages';
import { ApprovalCard } from './ApprovalCard';
import { ApprovalMessageInput } from './ApprovalMessageInput';
import { AccessRequestReview } from './AccessRequestReview';
import { MAX_APPROVAL_MESSAGE_LENGTH } from '../../../../shared/approval-message';

const mocks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as unknown[],
    cursor: 0,
    resource: { data: null as unknown, error: '', loading: false, refresh: vi.fn().mockResolvedValue(undefined) },
    respond: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      mocks.slots[index],
      (value: unknown) => {
        mocks.slots[index] = typeof value === 'function' ? value(mocks.slots[index]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  useEffect: vi.fn(),
}));
vi.mock('./CredentialsParts', () => ({ ErrorNotice: () => null, useCredentialResource: () => mocks.resource }));
vi.mock('../actions', () => ({ respondApproval: mocks.respond }));

interface Node {
  type: unknown;
  props: {
    children?: unknown;
    value?: unknown;
    disabled?: boolean;
    maxLength?: number;
    approvalId?: string;
    onClick?: () => void;
    onInput?: (event: { currentTarget: { value: string } }) => void;
  };
}
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'props' in value) return text((value as Node).props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function button(value: unknown, label: string): Node {
  const found = nodes(value).find((node) => node.type === 'button' && text(node) === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

const approval: PendingApprovalDto = {
  approvalId: 'approval',
  action: 'install_packages',
  title: 'Install package',
  details: null,
  packages: null,
  options: [
    { label: 'Approve', selectedLabel: 'Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: 'Rejected', value: 'reject' },
  ],
  agentGroupId: 'group',
  agentGroupName: 'Group',
  createdAt: '2026-10-30T00:00:00Z',
  supportsResponseMessage: true,
};
const request = {
  request_id: 'approval',
  status: 'pending',
  resource_url: 'https://api.example.com/items',
  reason: 'Finish the report',
  revision: 1,
  agent_group_id: 'group',
  result: null,
};
const connection: Connection = {
  id: 'connection',
  label: 'Account',
  kind: 'static',
  status: 'ready',
  revision: '"reviewed"',
  owner: { id: 'native-user' },
  credentials: ['API_KEY'],
  grants: [],
  services: [{ name: 'api', host: 'api.example.com', https_only: true, auth: { type: 'bearer', token: 'API_KEY' } }],
};
function accessReview() {
  mocks.cursor = 0;
  const onSaved = vi.fn();
  const tree = AccessRequestReview({
    id: 'approval',
    connections: [connection],
    onCreate: vi.fn(),
    onManage: vi.fn(),
    onSaved,
  });
  return { tree, onSaved };
}
beforeEach(() => {
  approvalMessageDrafts.value = {};
  mocks.slots = [];
  mocks.cursor = 0;
  mocks.respond.mockClear();
  mocks.resource = { data: request, error: '', loading: false, refresh: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed' }))));
});
afterEach(() => {
  approvalMessageDrafts.value = {};
  vi.unstubAllGlobals();
});

describe('optional approval messages', () => {
  it('uses the server message limit, disables during submission, and keeps drafts scoped by approval', () => {
    approvalMessageDrafts.value = { other: 'Other draft' };
    const input = nodes(ApprovalMessageInput({ approvalId: 'approval', disabled: true })).find(
      (node) => node.type === 'textarea',
    )!;
    expect(input.props).toMatchObject({ value: '', disabled: true, maxLength: MAX_APPROVAL_MESSAGE_LENGTH });
    input.props.onInput!({ currentTarget: { value: 'Use read-only operations.' } });
    expect(approvalMessageDrafts.value).toEqual({ approval: 'Use read-only operations.', other: 'Other draft' });
    clearApprovalMessage('approval');
    expect(approvalMessageDrafts.value).toEqual({ other: 'Other draft' });
  });

  it.each(['Approve', 'Reject'])('includes the note with %s while retaining the separate decision value', (label) => {
    approvalMessageDrafts.value = { approval: '  Keep the original account.  ' };
    const onRespond = vi.fn();
    const tree = ApprovalCard({ approval, busy: false, onReview: vi.fn(), onRespond });
    button(tree, label).props.onClick!();
    expect(onRespond).toHaveBeenCalledWith(label.toLowerCase(), 'Keep the original account.');
  });

  it('retains a draft when opening private credential review, and hides the input for unsupported approvals', () => {
    approvalMessageDrafts.value = { approval: 'Keep the original account.' };
    const onReview = vi.fn();
    const reviewed = {
      ...approval,
      reviewRequired: true,
      options: [{ label: 'Review', selectedLabel: 'Review', value: 'review' }],
    };
    const tree = ApprovalCard({ approval: reviewed, busy: false, onReview, onRespond: vi.fn() });
    button(tree, 'Review').props.onClick!();
    expect(onReview).toHaveBeenCalledOnce();
    expect(approvalMessageDrafts.value.approval).toBe('Keep the original account.');
    const unsupported = ApprovalCard({
      approval: { ...approval, supportsResponseMessage: false },
      busy: false,
      onReview,
      onRespond: vi.fn(),
    });
    expect(nodes(unsupported).some((node) => node.type === ApprovalMessageInput)).toBe(false);
    const { tree: review } = accessReview();
    expect(nodes(review).find((node) => node.type === ApprovalMessageInput)?.props.approvalId).toBe('approval');
  });

  it('keeps decisions without messages backward compatible', () => {
    const onRespond = vi.fn();
    button(ApprovalCard({ approval, busy: false, onReview: vi.fn(), onRespond }), 'Approve').props.onClick!();
    expect(onRespond).toHaveBeenCalledWith('approve');
  });

  it('submits the note in the same private Allow access request and clears it after success', async () => {
    approvalMessageDrafts.value = { approval: '  Keep the original account.  ' };
    mocks.slots = ['connection', { request, connection, matches: true }, false, '', false, '', ''];
    const { tree, onSaved } = accessReview();
    expect(button(tree, 'Allow access').props.disabled).toBe(false);
    button(tree, 'Allow access').props.onClick!();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({
      connection_id: 'connection',
      connection_revision: '"reviewed"',
      request_revision: 1,
      message: 'Keep the original account.',
    });
    expect(approvalMessageDrafts.value.approval).toBeUndefined();
  });

  it('retains the note after failed private access application', async () => {
    approvalMessageDrafts.value = { approval: 'Do not retry automatically.' };
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"Test failure"}', { status: 500 }));
    mocks.slots = ['connection', { request, connection, matches: true }, false, '', false, '', ''];
    const { tree, onSaved } = accessReview();
    button(tree, 'Allow access').props.onClick!();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(approvalMessageDrafts.value.approval).toBe('Do not retry automatically.');
  });

  it('carries the same draft when declining from private access review', async () => {
    approvalMessageDrafts.value = { approval: 'Already finished elsewhere.' };
    const { tree } = accessReview();
    button(tree, 'Decline').props.onClick!();
    await vi.waitFor(() =>
      expect(mocks.respond).toHaveBeenCalledWith('approval', 'reject', 'Already finished elsewhere.'),
    );
  });
});
