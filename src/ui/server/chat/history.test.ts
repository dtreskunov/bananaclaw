import { describe, expect, it } from 'vitest';

import { chatSdkHistoryContent } from './chat.js';

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
