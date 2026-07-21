import { describe, expect, it } from 'vitest';

import { isFinalResponse } from './chat-protocol';

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
