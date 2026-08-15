import { describe, expect, it } from 'vitest';

import { isFinalResponse, publicWebMessageId, showsMidTurnLabel } from './chat-protocol';

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

describe('showsMidTurnLabel', () => {
  it('captions an update while the turn is still running', () => {
    expect(showsMidTurnLabel('send_message', true, true)).toBe(true);
  });

  it('captions an update that something else followed', () => {
    expect(showsMidTurnLabel('send_message', false, false)).toBe(true);
  });

  it('drops the caption once the turn settles with nothing after it', () => {
    expect(showsMidTurnLabel('send_message', true, false)).toBe(false);
  });

  it('never captions other delivery origins', () => {
    expect(showsMidTurnLabel('send_file', false, true)).toBe(false);
    expect(showsMidTurnLabel('response', false, true)).toBe(false);
    expect(showsMidTurnLabel(undefined, false, true)).toBe(false);
  });
});

describe('publicWebMessageId', () => {
  it('derives the canonical browser-visible ID from the client correlation ID', () => {
    expect(publicWebMessageId('client-123')).toBe('web-client-123');
  });
});
