import { describe, expect, it } from 'vitest';

import {
  ensureBodyForAttachments,
  isResendSelfSender,
  prepareInboundEmailBody,
  parseTokenizedReplyAddress,
  tokenizedReplyAddress,
} from './resend.js';

describe('tokenizedReplyAddress', () => {
  it('adds an opaque response token without changing the mailbox domain', () => {
    expect(tokenizedReplyAddress('agent@example.com', 'abc_123-XYZ')).toBe('agent+r-abc_123-XYZ@example.com');
  });

  it('extracts the canonical alias and token from a display address', () => {
    expect(parseTokenizedReplyAddress('Agent <agent+r-AbC_123@example.com>')).toEqual({
      alias: 'agent@example.com',
      token: 'abc_123',
    });
  });
});

describe('isResendSelfSender', () => {
  it('matches the active alias in bare and display-address forms', () => {
    expect(isResendSelfSender('agent@example.com', 'agent@example.com')).toBe(true);
    expect(isResendSelfSender('Agent <AGENT@example.com>', 'agent@example.com')).toBe(true);
  });

  it('matches tokenized sender addresses derived from the active alias', () => {
    expect(isResendSelfSender('Agent <agent+r-AbC_123@example.com>', 'agent@example.com')).toBe(true);
  });

  it('does not match an external sender or another bot alias', () => {
    expect(isResendSelfSender('person@example.net', 'agent@example.com')).toBe(false);
    expect(isResendSelfSender('other@example.com', 'agent@example.com')).toBe(false);
  });
});

describe('prepareInboundEmailBody', () => {
  it('preserves plain text and HTML as separate inputs', () => {
    const result = prepareInboundEmailBody('Plain body', '<p>HTML body</p>');
    expect(result.body).toBe('Plain body');
    expect(Buffer.from(result.htmlAttachment?.data || '', 'base64').toString()).toBe('<p>HTML body</p>');
  });

  it('attaches HTML without extracting text when the plain-text part is absent', () => {
    const result = prepareInboundEmailBody(null, '<h1>Shipment ready</h1>');
    expect(result.body).toBe('');
    expect(Buffer.from(result.htmlAttachment?.data || '', 'base64').toString()).toBe('<h1>Shipment ready</h1>');
  });
});

describe('ensureBodyForAttachments', () => {
  it('injects a filename list when markdown is empty and files are present', () => {
    const out = ensureBodyForAttachments({
      markdown: '',
      files: [
        { filename: 'a.mp3', data: Buffer.from('a') },
        { filename: 'b.mp3', data: Buffer.from('b') },
      ],
    });
    expect(out.markdown).toBe('Attached:\n\n- a.mp3\n- b.mp3');
    expect(out.files).toHaveLength(2);
  });

  it('treats whitespace-only markdown as empty', () => {
    const out = ensureBodyForAttachments({
      markdown: '   \n  ',
      files: [{ filename: 'x.pdf', data: Buffer.from('x') }],
    });
    expect(out.markdown).toBe('Attached:\n\n- x.pdf');
  });

  it('leaves non-empty markdown alone', () => {
    const original = {
      markdown: 'Here you go',
      files: [{ filename: 'x.pdf', data: Buffer.from('x') }],
    };
    const out = ensureBodyForAttachments(original);
    expect(out).toBe(original);
    expect(out.markdown).toBe('Here you go');
  });

  it('is a no-op when there are no files', () => {
    const original = { markdown: '', files: [] };
    expect(ensureBodyForAttachments(original)).toBe(original);
    const noFiles = { markdown: 'hi' };
    expect(ensureBodyForAttachments(noFiles)).toBe(noFiles);
  });

  it('is a no-op when files is undefined', () => {
    const original = { markdown: '' };
    expect(ensureBodyForAttachments(original)).toBe(original);
  });
});
