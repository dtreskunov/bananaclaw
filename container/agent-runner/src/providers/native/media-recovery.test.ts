import { describe, expect, it } from 'bun:test';
import { APICallError, type ModelMessage } from 'ai';
import { applyMediaQuarantines, isMediaParameterError, mediaKeys } from './media-recovery.js';

function rejection(statusCode = 400, type = 'invalid_request_error', isRetryable = false): APICallError {
  return new APICallError({ message: 'Request rejected', url: 'https://model.example/v1',
    requestBodyValues: {}, statusCode, isRetryable, responseBody: JSON.stringify({ error: { type } }) });
}

describe('media parameter rejection eligibility', () => {
  it('recognizes a structured non-retryable parameter rejection', () => {
    expect(isMediaParameterError(rejection())).toBe(true);
  });

  it.each([401, 403, 413, 429, 500, 503])('does not recover status %i by discarding media', status => {
    expect(isMediaParameterError(rejection(status))).toBe(false);
  });

  it('does not reinterpret authentication errors, retryable failures, or arbitrary exceptions', () => {
    expect(isMediaParameterError(rejection(400, 'authentication_error'))).toBe(false);
    expect(isMediaParameterError(rejection(400, 'invalid_request_error', true))).toBe(false);
    expect(isMediaParameterError(new Error('invalid params, 400'))).toBe(false);
    const error = new APICallError({ message: 'Bad response', url: 'https://model.example/v1',
      requestBodyValues: {}, statusCode: 400, isRetryable: false, responseBody: 'not JSON' });
    expect(isMediaParameterError(error)).toBe(false);
  });
});

describe('immutable media context projection', () => {
  it.each(['image/png', 'image/jpeg', 'application/pdf', 'audio/wav', 'video/mp4'])(
    'quarantines opaque %s without parsing or changing other tool results',
    mime => {
      const messages: ModelMessage[] = [
        { role: 'assistant', content: [
          { type: 'tool-call', toolCallId: 'completed', toolName: 'media_tool', input: {} },
        ] },
        { role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'completed', toolName: 'media_tool', output: {
            type: 'content', value: [
              { type: 'text', text: 'Completed tool action' },
              { type: 'file', mediaType: mime, data: { type: 'data', data: 'healthy bytes' } },
              { type: 'file', mediaType: mime, data: { type: 'data', data: 'rejected bytes' } },
            ],
          } },
        ] },
      ];
      const before = JSON.stringify(messages);
      const keys = mediaKeys(messages);
      expect(keys).toHaveLength(2);
      const projected = applyMediaQuarantines(messages, new Map([[keys[1], 'Original rejection']]));
      expect(JSON.stringify(messages)).toBe(before);
      expect(projected[0]).toEqual(messages[0]);
      expect(JSON.stringify(projected)).toContain('Completed tool action');
      expect(JSON.stringify(projected)).toContain('healthy bytes');
      expect(JSON.stringify(projected)).not.toContain('rejected bytes');
      expect(JSON.stringify(projected)).toContain('Media unavailable to this model: Original rejection');
      expect(mediaKeys(projected)).toEqual([keys[0]]);
      expect(applyMediaQuarantines(messages, new Map())).toBe(messages);
    },
  );

  it('handles user and assistant attachments, URLs, tagged data, and descriptor changes', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: 'Keep this request' },
        { type: 'image', image: new URL('https://images.example/source') },
        { type: 'file', mediaType: 'application/pdf', filename: 'report.pdf',
          data: { type: 'data', data: new Uint8Array([1, 2, 3]) } },
      ] },
      { role: 'assistant', content: [{ type: 'file', mediaType: 'image/webp', data: 'opaque output' }] },
    ];
    const keys = mediaKeys(messages);
    expect(keys).toHaveLength(3);
    const quarantines = new Map(keys.map(key => [key, 'Provider rejection']));
    expect(mediaKeys(applyMediaQuarantines(messages, quarantines))).toEqual([]);
    expect(JSON.stringify(applyMediaQuarantines(messages, quarantines))).toContain('Keep this request');
    expect(JSON.stringify(applyMediaQuarantines(messages, quarantines))).toContain('report.pdf');
    expect(JSON.stringify(applyMediaQuarantines(messages, quarantines))).toContain('application/pdf');
    const restored = JSON.parse(JSON.stringify(messages)) as ModelMessage[];
    expect(mediaKeys(restored)).toEqual(keys);
    const repaired: ModelMessage[] = [{ role: 'user', content: [
      { type: 'file', mediaType: 'application/pdf', data: 'changed bytes' },
    ] }];
    expect(applyMediaQuarantines(repaired, quarantines)).toEqual(repaired);
    const buffers: ModelMessage[] = [{ role: 'user', content: [
      { type: 'file', mediaType: 'image/png', data: new Uint8Array([1]).buffer },
      { type: 'file', mediaType: 'image/png', data: new Uint8Array([2]).buffer },
    ] }];
    expect(new Set(mediaKeys(buffers)).size).toBe(2);
  });
});
