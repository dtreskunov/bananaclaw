import { describe, expect, it } from 'vitest';
import { isSystemNotice, publicWebMessageId, showsMidTurnLabel } from './chat-protocol';

describe('host-owned turn presentation', () => {
  it('labels updates from the owning turn phase, not the next output', () => {
    expect(showsMidTurnLabel('send_message', true)).toBe(true);
    expect(showsMidTurnLabel('send_message', false)).toBe(false);
    expect(showsMidTurnLabel('response', true)).toBe(false);
    expect(showsMidTurnLabel('send_file', true)).toBe(false);
  });
  it('derives the public inbound ID from its command correlation ID', () => {
    expect(publicWebMessageId('client-123')).toBe('web-client-123');
  });
  it('distinguishes runner-authored notices from agent replies, including legacy action notices', () => {
    expect(isSystemNotice('out', true, undefined)).toBe(true);
    expect(isSystemNotice('out', undefined, 'retry')).toBe(true);
    expect(isSystemNotice('out', undefined, undefined)).toBe(false);
    expect(isSystemNotice('in', true, 'retry')).toBe(false);
  });
});
