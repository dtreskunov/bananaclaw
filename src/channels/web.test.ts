import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebAdapter, submitWebInbound, subscribeWeb } from './web.js';

const adapter = createWebAdapter();

afterEach(async () => {
  await adapter.teardown();
});

describe('shared web chat', () => {
  it('echoes an attributed inbound message to every room subscriber', async () => {
    const onInboundEvent = vi.fn();
    await adapter.setup({
      onInbound: vi.fn(),
      onInboundEvent,
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const firstEcho = vi.fn();
    const secondEcho = vi.fn();
    const subscriber = (onInboundEcho: typeof firstEcho) => ({
      onOutbound: vi.fn(),
      onInboundEcho,
    });
    subscribeWeb('group:ag-team', 'thread-1', subscriber(firstEcho));
    subscribeWeb('group:ag-team', 'thread-1', subscriber(secondEcho));

    await submitWebInbound({
      userId: 'user-priya',
      senderDisplayName: 'Priya',
      platformId: 'group:ag-team',
      threadId: 'thread-1',
      text: 'Run the tests first',
      clientMessageId: 'client_msg_1',
    });

    const expectedAuthor = { userId: 'user-priya', displayName: 'Priya' };
    expect(firstEcho).toHaveBeenCalledWith('web-client_msg_1', 'Run the tests first', expectedAuthor, undefined);
    expect(secondEcho).toHaveBeenCalledWith('web-client_msg_1', 'Run the tests first', expectedAuthor, undefined);
    expect(onInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        platformId: 'group:ag-team',
        threadId: 'thread-1',
        message: expect.objectContaining({
          content: JSON.stringify({
            text: 'Run the tests first',
            sender: 'Priya',
            senderId: 'user-priya',
          }),
        }),
      }),
    );
  });
});
