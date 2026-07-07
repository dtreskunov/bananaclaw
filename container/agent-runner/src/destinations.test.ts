import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

function seedOrigin(channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, ?, ?, NULL)`,
    )
    .run(channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('flags the session-origin destination so the agent replies to the right channel', () => {
    // Origin is the web channel; the email persona is named after the user and
    // would otherwise attract a mis-routed reply.
    seedDestination('web-mg-web-0', 'web-mg-web-0', 'web', 'web:denis');
    seedDestination('denis-bot', 'Denis (Bot)', 'resend', 'resend:denis@bananaclaw.app');
    seedOrigin('web', 'web:denis');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('← this conversation; reply here by default');
    expect(prompt).toContain('This conversation lives on `web-mg-web-0`');
    // The marker is attached to the origin line, not the look-alike email persona.
    const originLine = prompt.split('\n').find((l) => l.includes('`web-mg-web-0`'));
    expect(originLine).toContain('← this conversation');
    const emailLine = prompt.split('\n').find((l) => l.startsWith('- `denis-bot`'));
    expect(emailLine).not.toContain('← this conversation');
  });

  it('marks no origin when session_routing is empty', () => {
    seedDestination('web-mg-web-0', 'web-mg-web-0', 'web', 'web:denis');
    seedDestination('denis-bot', 'Denis (Bot)', 'resend', 'resend:denis@bananaclaw.app');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).not.toContain('← this conversation');
    expect(prompt).not.toContain('This conversation lives on');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('Default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });
});
