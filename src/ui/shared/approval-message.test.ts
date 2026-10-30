import { describe, expect, it } from 'vitest';
import { ApprovalMessageError, MAX_APPROVAL_MESSAGE_LENGTH, parseApprovalMessage } from './approval-message.js';

describe('optional approval messages', () => {
  it.each([undefined, '', ' \n\t '])('omits empty message %j', (value) => {
    expect(parseApprovalMessage(value)).toBeUndefined();
  });
  it('trims surrounding whitespace without changing the user message', () => {
    expect(parseApprovalMessage(' \nKeep existing labels.\nDo not send email. \n')).toBe(
      'Keep existing labels.\nDo not send email.',
    );
  });
  it('accepts the exact limit and rejects even one character beyond it', () => {
    expect(parseApprovalMessage('x'.repeat(MAX_APPROVAL_MESSAGE_LENGTH))).toHaveLength(MAX_APPROVAL_MESSAGE_LENGTH);
    expect(() => parseApprovalMessage('x'.repeat(MAX_APPROVAL_MESSAGE_LENGTH + 1))).toThrow(ApprovalMessageError);
  });
  it.each([null, 42, true, {}, ['text']])('rejects non-text message %j', (value) => {
    expect(() => parseApprovalMessage(value)).toThrow(ApprovalMessageError);
  });
});
