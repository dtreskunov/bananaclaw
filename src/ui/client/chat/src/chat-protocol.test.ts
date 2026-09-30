import { describe, expect, it } from 'vitest';
import { publicWebMessageId, showsMidTurnLabel } from './chat-protocol';

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
});
