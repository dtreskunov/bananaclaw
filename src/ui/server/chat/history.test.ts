import { describe, expect, it } from 'vitest';

import {
  chatSdkHistoryContent,
  inboundAttachmentSecurityHeaders,
  matchChatPath,
  parseOutboundContent,
  publicInboundMessageId,
} from './chat.js';

describe('chat socket bootstrap', () => {
  it('does not expose a REST history route', () => {
    expect(matchChatPath('/api/groups/group-1/chat/thread-1/history')).toBeNull();
  });

  it('uses the same public inbound ID for live echoes and persisted history', () => {
    const groupId = 'agent-group-456';
    const liveEchoId = 'web-client-123';
    const persistedId = `${liveEchoId}:${groupId}`;

    expect(publicInboundMessageId(liveEchoId, groupId)).toBe(liveEchoId);
    expect(publicInboundMessageId(persistedId, groupId)).toBe(liveEchoId);
  });
});

describe('inboundAttachmentSecurityHeaders', () => {
  it('sandboxes HTML attachments and disables active content', () => {
    const headers = inboundAttachmentSecurityHeaders('text/html; charset=utf-8');

    expect(headers['Content-Security-Policy']).toContain('sandbox');
    expect(headers['Content-Security-Policy']).toContain("script-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("form-action 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'self'");
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(inboundAttachmentSecurityHeaders('application/xhtml+xml')).toHaveProperty('Content-Security-Policy');
    expect(inboundAttachmentSecurityHeaders('application/octet-stream', 'message.html')).toHaveProperty(
      'Content-Security-Policy',
    );
  });

  it('does not add HTML policies to other attachment types', () => {
    expect(inboundAttachmentSecurityHeaders('text/plain')).toEqual({});
  });
});

describe('parseOutboundContent', () => {
  it('projects a stable logical position for live and reloaded responses', () => {
    const timelinePosition = Date.parse('2026-09-26T00:00:00.000Z') * 1000 + 1;
    expect(parseOutboundContent(JSON.stringify({ text: 'Done', timelinePosition }))).toEqual({
      text: 'Done',
      files: undefined,
      timelinePosition,
    });
    for (const invalid of [-1, 1.5, '12', Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        parseOutboundContent(JSON.stringify({ text: 'Legacy', timelinePosition: invalid })).timelinePosition,
      ).toBeUndefined();
    }
  });

  it('preserves recognized delivery provenance', () => {
    expect(parseOutboundContent(JSON.stringify({ text: 'Working on it', delivery_origin: 'send_message' }))).toEqual({
      text: 'Working on it',
      files: undefined,
      deliveryOrigin: 'send_message',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'Done', delivery_origin: 'response' }))).toEqual({
      text: 'Done',
      files: undefined,
      deliveryOrigin: 'response',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'Attached', delivery_origin: 'send_file' }))).toEqual({
      text: 'Attached',
      files: undefined,
      deliveryOrigin: 'send_file',
    });
  });

  it('drops unknown delivery provenance', () => {
    expect(parseOutboundContent(JSON.stringify({ text: 'Legacy', delivery_origin: 'other' }))).toEqual({
      text: 'Legacy',
      files: undefined,
    });
  });

  it('preserves recognized suggested actions', () => {
    expect(
      parseOutboundContent(
        JSON.stringify({
          text: 'The publish completed, but verification could not run.',
          delivery_origin: 'response',
          suggested_action: 'continue',
        }),
      ),
    ).toEqual({
      text: 'The publish completed, but verification could not run.',
      files: undefined,
      deliveryOrigin: 'response',
      suggestedAction: 'continue',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'Try again.', suggested_action: 'retry' }))).toEqual({
      text: 'Try again.',
      files: undefined,
      suggestedAction: 'retry',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'Report it.', suggested_action: 'report' }))).toEqual({
      text: 'Report it.',
      files: undefined,
      suggestedAction: 'report',
    });
    expect(parseOutboundContent(JSON.stringify({ text: 'No action.', suggested_action: 'unknown' }))).toEqual({
      text: 'No action.',
      files: undefined,
    });
  });
});

describe('chatSdkHistoryContent', () => {
  it('omits durable questions because /sync renders their lifecycle card', () => {
    expect(
      chatSdkHistoryContent(
        JSON.stringify({
          type: 'ask_question',
          question: 'What should the release note say?',
        }),
      ),
    ).toBeNull();
  });

  it('retains normalized structure and fallback text for display cards', () => {
    expect(
      chatSdkHistoryContent(
        JSON.stringify({
          type: 'card',
          card: {
            title: 'Deployment',
            description: 'Version 2.4.1 is live',
            children: [{ text: 'All checks passed' }],
            actions: [{ label: 'Open', url: 'https://example.com', style: 'primary' }],
          },
          fallbackText: 'Deployment completed',
        }),
      ),
    ).toEqual({
      text: 'Deployment completed',
      card: {
        title: 'Deployment',
        description: 'Version 2.4.1 is live',
        children: ['All checks passed'],
        actions: [{ label: 'Open', url: 'https://example.com', style: 'primary' }],
      },
    });
  });

  it('retains fallback-only display cards as text', () => {
    expect(
      chatSdkHistoryContent(
        JSON.stringify({
          type: 'card',
          card: {},
          fallbackText: 'Deployment completed',
        }),
      ),
    ).toEqual({ text: 'Deployment completed' });
  });

  it('ignores malformed and unknown chat-sdk content', () => {
    expect(chatSdkHistoryContent('{')).toBeNull();
    expect(chatSdkHistoryContent(JSON.stringify({ type: 'unknown' }))).toBeNull();
  });
});
