import { describe, expect, it } from 'vitest';

import { isFinalResponse, isWebEchoForClientMessage } from './chat-protocol';

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

describe('isWebEchoForClientMessage', () => {
  it('matches the web channel prefix added to client message IDs', () => {
    expect(isWebEchoForClientMessage('web-client-123', 'client-123')).toBe(true);
  });

  it('matches persisted web IDs namespaced to an agent group', () => {
    expect(isWebEchoForClientMessage('web-client-123:agent-group-456', 'client-123')).toBe(true);
  });

  it('also accepts an unchanged client message ID', () => {
    expect(isWebEchoForClientMessage('client-123', 'client-123')).toBe(true);
  });

  it('rejects unrelated server messages', () => {
    expect(isWebEchoForClientMessage('web-other', 'client-123')).toBe(false);
  });
});
