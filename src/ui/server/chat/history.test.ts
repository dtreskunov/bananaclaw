import { describe, expect, it } from 'vitest';

import { chatSdkHistoryText } from './chat.js';

describe('chatSdkHistoryText', () => {
  it('omits durable questions because /sync renders their lifecycle card', () => {
    expect(
      chatSdkHistoryText(
        JSON.stringify({
          type: 'ask_question',
          question: 'What should the release note say?',
        }),
      ),
    ).toBe('');
  });

  it('retains fallback text for fire-and-forget cards', () => {
    expect(
      chatSdkHistoryText(
        JSON.stringify({
          type: 'card',
          fallbackText: 'Deployment completed',
        }),
      ),
    ).toBe('Deployment completed');
  });

  it('ignores malformed and unknown chat-sdk content', () => {
    expect(chatSdkHistoryText('{')).toBe('');
    expect(chatSdkHistoryText(JSON.stringify({ type: 'unknown' }))).toBe('');
  });
});
