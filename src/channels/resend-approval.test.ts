import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { ChannelAdapter, ChannelRegistration } from './adapter.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';

const mocks = vi.hoisted(() => ({
  register: vi.fn<(name: string, registration: ChannelRegistration) => void>(),
}));

vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: mocks.register,
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    RESEND_API_KEY: 're_test',
    RESEND_FROM_ADDRESS: 'agent@example.com',
    RESEND_FROM_NAME: 'Agent',
  }),
}));

import './resend.js';

const threadId = 'resend:agent@example.com:owner@example.net:approval-thread';
let adapter: ChannelAdapter;
let fetchMock: MockInstance<typeof fetch>;

beforeEach(async () => {
  const db = initTestDb();
  runMigrations(db);
  fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ id: 'email-1' })));
  const registration = mocks.register.mock.calls.find(([name]) => name === 'resend')?.[1];
  if (!registration) throw new Error('Resend adapter was not registered');
  const instance = await registration.factory();
  if (!instance) throw new Error('Resend adapter was not created');
  adapter = instance;
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

function deliverApproval(approvalId = 'nsa-test', title = '👤 New sender', tid = threadId) {
  return adapter.deliver('resend:agent@example.com', tid, {
    kind: 'chat-sdk',
    content: {
      type: 'approval_request',
      approvalId,
      title,
      body: 'Alice (resend:alice@example.net) wants to talk to your agent. Allow?',
      options: [
        { label: 'Allow', value: 'approve' },
        { label: 'Deny', value: 'reject' },
      ],
    },
  });
}

function sentEmail(index: number) {
  return JSON.parse(String(fetchMock.mock.calls[index][1]?.body));
}

describe('Resend approval email delivery', () => {
  it('sends a new approval subject without Re: and keeps reply controls and references', async () => {
    await expect(deliverApproval()).resolves.toBe('email-1');

    expect(sentEmail(0)).toMatchObject({
      from: 'Agent <agent@example.com>',
      to: ['owner@example.net'],
      subject: '👤 New sender [ref:nsa-test]',
      text: expect.stringContaining('Alice (resend:alice@example.net)'),
    });
    expect(sentEmail(0).text).toContain('Allow');
    expect(sentEmail(0).text).toContain('Deny');
    expect(sentEmail(0).text).toContain('(Approval ref: nsa-test)');
  });

  it('uses the current approval reference even when the thread already has a subject', async () => {
    await deliverApproval('nsa-first');
    await deliverApproval('nsa-second');

    expect(sentEmail(1).subject).toBe('👤 New sender [ref:nsa-second]');
  });

  it('uses Approval as the subject when the card has no title', async () => {
    await deliverApproval('appr-test', '');

    expect(sentEmail(0).subject).toBe('Approval [ref:appr-test]');
  });

  it('preserves normal reply subjects after sending an approval', async () => {
    await deliverApproval();
    await adapter.deliver('resend:agent@example.com', threadId, {
      kind: 'chat',
      content: { text: 'Follow-up' },
    });

    expect(sentEmail(1).subject).toBe('Re: 👤 New sender [ref:nsa-test]');
  });

  it('does not leak an approval subject to the next email if preparing delivery fails', async () => {
    await expect(deliverApproval('nsa-failed', 'New sender', 'invalid-thread')).rejects.toThrow('Invalid thread ID');
    expect(fetchMock).not.toHaveBeenCalled();

    await adapter.deliver('resend:agent@example.com', threadId, {
      kind: 'chat',
      content: { text: 'Unrelated message' },
    });

    expect(sentEmail(0).subject).toBe('New message');
  });
});
