import { describe, expect, it } from 'vitest';

import { isFinalResponse, publicWebMessageId } from './chat-protocol';

describe('isFinalResponse', () => {
  it('keeps tool-delivered messages inside the active turn', () => {
    expect(isFinalResponse('out', 'send_message')).toBe(false);
    expect(isFinalResponse('out', 'send_file')).toBe(false);
  });

  it('treats final and legacy outbound messages as completion', () => {
    expect(isFinalResponse('out', 'response')).toBe(true);
    expect(isFinalResponse('out', undefined)).toBe(true);
  });

  it('never treats internal messages as completion', () => {
    expect(isFinalResponse('internal', 'response')).toBe(false);
  });
});

describe('publicWebMessageId', () => {
  it('derives the canonical browser-visible ID from the client correlation ID', () => {
    expect(publicWebMessageId('client-123')).toBe('web-client-123');
  });
});
