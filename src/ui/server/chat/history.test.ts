import { describe, expect, it } from 'vitest';

import { chatSdkHistoryContent, createBufferedFrameSender, matchChatPath, parseOutboundContent } from './chat.js';

describe('chat socket bootstrap', () => {
  it('orders history before buffered live frames and ready', () => {
    const frames: string[] = [];
    const sender = createBufferedFrameSender((frame) => frames.push(frame));

    sender.send({ kind: 'inbound', id: 'during-snapshot' });
    sender.finish({ kind: 'history', messages: [] }, { kind: 'ready' });
    sender.send({ kind: 'outbound', id: 'after-ready' });

    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { kind: 'history', messages: [] },
      { kind: 'inbound', id: 'during-snapshot' },
      { kind: 'ready' },
      { kind: 'outbound', id: 'after-ready' },
    ]);
  });

  it('does not expose a REST history route', () => {
    expect(matchChatPath('/api/groups/group-1/chat/thread-1/history')).toBeNull();
  });
});

describe('parseOutboundContent', () => {
  it('preserves recognized delivery provenance', () => {
    expect(parseOutboundContent(JSON.stringify({ text: 'Working on it', delivery_origin: 'send_message' }))).toEqual({
      text: 'Working on it',
      files: undefined,
      deliveryOrigin: 'send_message',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'Done', delivery_origin: 'response' }))).toEqual({
      text: 'Done',
      files: undefined,
      deliveryOrigin: 'response',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'Attached', delivery_origin: 'send_file' }))).toEqual({
      text: 'Attached',
      files: undefined,
      deliveryOrigin: 'send_file',
    });
  });

  it('drops unknown delivery provenance', () => {
    expect(parseOutboundContent(JSON.stringify({ text: 'Legacy', delivery_origin: 'other' }))).toEqual({
      text: 'Legacy',
      files: undefined,
    });
  });
});

describe('chatSdkHistoryContent', () => {
  it('omits durable questions because /sync renders their lifecycle card', () => {
    expect(
      chatSdkHistoryContent(
        JSON.stringify({
          type: 'ask_question',
          question: 'What should the release note say?',
        }),
      ),
    ).toBeNull();
  });

  it('retains normalized structure and fallback text for display cards', () => {
    expect(
      chatSdkHistoryContent(
        JSON.stringify({
          type: 'card',
          card: {
            title: 'Deployment',
            description: 'Version 2.4.1 is live',
            children: [{ text: 'All checks passed' }],
            actions: [{ label: 'Open', url: 'https://example.com', style: 'primary' }],
          },
          fallbackText: 'Deployment completed',
        }),
      ),
    ).toEqual({
      text: 'Deployment completed',
      card: {
        title: 'Deployment',
        description: 'Version 2.4.1 is live',
        children: ['All checks passed'],
        actions: [{ label: 'Open', url: 'https://example.com', style: 'primary' }],
      },
    });
  });

  it('retains fallback-only display cards as text', () => {
    expect(
      chatSdkHistoryContent(
        JSON.stringify({
          type: 'card',
          card: {},
          fallbackText: 'Deployment completed',
        }),
      ),
    ).toEqual({ text: 'Deployment completed' });
  });

  it('ignores malformed and unknown chat-sdk content', () => {
    expect(chatSdkHistoryContent('{')).toBeNull();
    expect(chatSdkHistoryContent(JSON.stringify({ type: 'unknown' }))).toBeNull();
  });
});
