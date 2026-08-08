import { describe, expect, it } from 'vitest';

import { isFutureWorkMessage } from './future-work';

describe('isFutureWorkMessage', () => {
  it('recognizes short announcements that promise future work', () => {
    for (const message of [
      'On it - pulling Seattle dance events for tonight through Sunday.',
      'Understood - working through all 8 issues. Starting with TRE-51 now.',
      'Working on it now.',
      'Yes, the page has photos. Let me pull the image URLs now.',
      'You are right. Let me fix this by improving the connectivity constraint.',
      'Wrote v1 of the footer. Let me render and compare it to the source.',
      "I'm investigating this now.",
      "I'll take a look and get started now.",
      'Doing it now.',
      'Actually doing it now.',
      'Checking now.',
      'Actually checking now.',
      'Executing.',
      'Actually executing.',
      'Running it now.',
    ]) {
      expect(isFutureWorkMessage(message), message).toBe(true);
    }
  });

  it('rejects questions, results, and substantive progress reports', () => {
    for (const message of [
      'Which song should I use? Tell me the artist and title and I will build it.',
      'I am working on the renderer. The first page now passes all 12 layout checks, and the remaining issue is documented below with the exact CSS change.',
      'The service is running now.',
      'Running now.',
      'Let me check: the service is running now.',
      'Here are the five matching events, with dates and ticket links.',
      'Understood. The config update is complete.',
      'I will not update this because the repository is read-only.',
      'I will never update this.',
      'Let me not update this.',
      'Understood, I completed the update.',
      'The new API let me update the cache atomically.',
    ]) {
      expect(isFutureWorkMessage(message), message).toBe(false);
    }
  });

  it('rejects empty and long messages', () => {
    expect(isFutureWorkMessage('')).toBe(false);
    expect(isFutureWorkMessage(`On it. ${'Searching now. '.repeat(20)}`)).toBe(false);
  });
});
