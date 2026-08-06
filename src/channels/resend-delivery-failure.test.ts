import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteCorrelation: vi.fn(),
  getCorrelation: vi.fn(),
  getSession: vi.fn(),
  wakeContainer: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  writeSessionMessage: vi.fn(),
}));

vi.mock('../container-runner.js', () => ({
  wakeContainer: mocks.wakeContainer,
}));

vi.mock('../db/sessions.js', () => ({
  getAskQuestionRender: vi.fn(),
  getSession: mocks.getSession,
}));

vi.mock('../modules/email/resend-correlations.js', () => ({
  createResendOutboundCorrelation: vi.fn(),
  deleteResendOutboundCorrelation: mocks.deleteCorrelation,
  getResendOutboundCorrelationByToken: mocks.getCorrelation,
}));

vi.mock('../session-manager.js', () => ({
  writeSessionMessage: mocks.writeSessionMessage,
}));

import { routeResendDeliveryFailure, type ResendDeliveryFailureEvent } from './resend.js';

const bounceEvent: ResendDeliveryFailureEvent = {
  type: 'email.bounced',
  created_at: '2026-08-05T22:42:47.000Z',
  data: {
    created_at: '2026-08-05T22:42:46.000Z',
    email_id: 'email-1',
    from: 'Agent <agent+r-token-1@example.com>',
    to: ['print@example.net'],
    subject: 'Print Job',
    bounce: {
      message: 'Recipient address rejected',
      type: 'Permanent',
      subType: 'General',
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCorrelation.mockReturnValue({
    correlation_token: 'token-1',
    origin_session_id: 'session-1',
    email_thread_id: 'resend:agent@example.com:print@example.net:thread-hash',
    created_at: '2026-08-05T22:42:46.000Z',
  });
  mocks.getSession.mockReturnValue({
    id: 'session-1',
    agent_group_id: 'agent-group-1',
    messaging_group_id: 'messaging-group-1',
    thread_id: 'web-thread-1',
  });
  mocks.wakeContainer.mockResolvedValue(true);
});

describe('routeResendDeliveryFailure', () => {
  it('writes a durable internal failure before waking and deleting correlation', async () => {
    await expect(routeResendDeliveryFailure(bounceEvent)).resolves.toBe(true);

    expect(mocks.getCorrelation).toHaveBeenCalledWith('token-1');
    expect(mocks.writeSessionMessage).toHaveBeenCalledWith('agent-group-1', 'session-1', {
      id: 'resend-delivery-failure:email-1',
      kind: 'chat',
      timestamp: '2026-08-05T22:42:47.000Z',
      platformId: 'agent-group-1',
      channelType: 'agent',
      threadId: null,
      content: expect.any(String),
      trigger: 1,
      idempotent: true,
    });
    const content = JSON.parse(mocks.writeSessionMessage.mock.calls[0]![2].content);
    expect(content).toEqual({
      text: [
        'System delivery report: an email you sent was not delivered.',
        'Recipient: print@example.net',
        'Subject: Print Job',
        'Failure event: email.bounced',
        'Tell the user the email was not delivered. Do not continue waiting for a response. Retry only with a verified corrected address.',
      ].join('\n'),
      sender: 'NanoClaw email delivery',
      senderId: 'system',
      emailDeliveryFailure: {
        provider: 'resend',
        event: 'email.bounced',
        recipient: 'print@example.net',
        subject: 'Print Job',
        reason: 'Recipient address rejected',
        type: 'Permanent',
        subType: 'General',
      },
    });
    expect(mocks.writeSessionMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wakeContainer.mock.invocationCallOrder[0]!,
    );
    expect(mocks.wakeContainer.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteCorrelation.mock.invocationCallOrder[0]!,
    );
    expect(mocks.deleteCorrelation).toHaveBeenCalledWith('token-1');
    expect(mocks.wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-1' }));
  });

  it('ignores an event when its token has no correlation', async () => {
    mocks.getCorrelation.mockReturnValue(undefined);

    await expect(routeResendDeliveryFailure(bounceEvent)).resolves.toBe(false);

    expect(mocks.writeSessionMessage).not.toHaveBeenCalled();
    expect(mocks.deleteCorrelation).not.toHaveBeenCalled();
    expect(mocks.wakeContainer).not.toHaveBeenCalled();
  });

  it('retains correlation and rejects the webhook attempt when the session cannot wake', async () => {
    mocks.wakeContainer.mockResolvedValue(false);

    await expect(routeResendDeliveryFailure(bounceEvent)).rejects.toThrow(
      'Failed to wake origin session session-1 for Resend delivery failure',
    );

    expect(mocks.writeSessionMessage).toHaveBeenCalledOnce();
    expect(mocks.deleteCorrelation).not.toHaveBeenCalled();
  });

  it('does not consume correlation for a non-primary recipient failure', async () => {
    const bccFailure: ResendDeliveryFailureEvent = {
      ...bounceEvent,
      data: { ...bounceEvent.data, to: ['audit@example.org'] },
    };

    await expect(routeResendDeliveryFailure(bccFailure)).resolves.toBe(false);

    expect(mocks.writeSessionMessage).not.toHaveBeenCalled();
    expect(mocks.deleteCorrelation).not.toHaveBeenCalled();
    expect(mocks.wakeContainer).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: {
        type: 'email.failed',
        created_at: bounceEvent.created_at,
        data: { ...bounceEvent.data, failed: { reason: 'Provider rejected the message' }, bounce: undefined },
      } as ResendDeliveryFailureEvent,
      reason: 'Provider rejected the message',
    },
    {
      event: {
        type: 'email.suppressed',
        created_at: bounceEvent.created_at,
        data: {
          ...bounceEvent.data,
          suppressed: { message: 'Recipient is on the suppression list', type: 'Bounce' },
          bounce: undefined,
        },
      } as ResendDeliveryFailureEvent,
      reason: 'Recipient is on the suppression list',
    },
  ])('routes $event.type as a terminal delivery failure', async ({ event, reason }) => {
    await expect(routeResendDeliveryFailure(event)).resolves.toBe(true);

    const content = JSON.parse(mocks.writeSessionMessage.mock.calls[0]![2].content);
    expect(content.emailDeliveryFailure).toMatchObject({ event: event.type, reason });
    expect(mocks.deleteCorrelation).toHaveBeenCalledWith('token-1');
    expect(mocks.wakeContainer).toHaveBeenCalledOnce();
  });
});
