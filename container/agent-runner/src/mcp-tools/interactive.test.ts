import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { askUserQuestion, sendCard } from './interactive.js';
import { writeMessageOut } from '../db/messages-out.js';

describe('ask_user_question', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb().prepare(
      'INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
    ).run('web', 'user-1', 'thread-1');
  });

  afterEach(() => closeSessionDb());

  it('does not expose a timeout and declares every response mode', () => {
    const properties = askUserQuestion.tool.inputSchema.properties as Record<string, unknown>;
    expect(properties.timeout).toBeUndefined();
    expect(properties.responseMode).toEqual(expect.objectContaining({
      enum: ['choice', 'text', 'choice_or_text'],
    }));
  });

  it('returns immediately with a durable text question', async () => {
    const result = await askUserQuestion.handler({
      title: 'Details',
      question: 'What should I use?',
      responseMode: 'text',
      placeholder: 'Type an answer',
    });
    expect(result.isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('awaiting_user');
    const row = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(row.content)).toMatchObject({
      type: 'ask_question',
      responseMode: 'text',
      question: 'What should I use?',
      options: [],
    });
  });

  it('rejects a second outstanding question', async () => {
    await askUserQuestion.handler({
      title: 'First', question: 'Choose', responseMode: 'choice', options: ['A'],
    });

    const second = await askUserQuestion.handler({
      title: 'Second', question: 'Choose again', responseMode: 'choice', options: ['B'],
    });
    expect(second.isError).toBe(true);
    expect((second.content[0] as { text: string }).text).toContain('already awaiting');
  });

  it('preserves the pending question gate after Stop until an answer arrives', async () => {
    await askUserQuestion.handler({ title: 'Stopped', question: 'Old question', responseMode: 'text' });
    const row = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(row.content).cancelled).toBeUndefined();
    writeMessageOut({
      id: 'stopped-question', kind: 'chat',
      content: JSON.stringify({ text: 'Stopped by user.', stopped: true, turn_id: 'stopped-turn' }),
    });
    const next = await askUserQuestion.handler({ title: 'New', question: 'New question', responseMode: 'text' });
    expect(next.isError).toBe(true);
    const journal = getOutboundDb().prepare("SELECT payload FROM pending_runner_events WHERE event_type = 'message.upsert'").all();
    expect(journal).toHaveLength(2);
    expect(JSON.stringify(journal[0])).not.toContain('cancelled');
    getInboundDb().prepare(`INSERT INTO messages_in (id, kind, timestamp, status, content)
      VALUES ('answer', 'interactive_response', datetime('now'), 'pending', ?)`)
      .run(JSON.stringify({ questionId: JSON.parse(row.content).questionId, value: 'yes' }));
    const answered = await askUserQuestion.handler({ title: 'New', question: 'New question', responseMode: 'text' });
    expect(answered.isError).not.toBe(true);
  });

  it('persists choice_or_text with normalized options', async () => {
    await askUserQuestion.handler({
      title: 'Destination',
      question: 'Where should this go?',
      responseMode: 'choice_or_text',
      options: [{ label: 'Production', value: 'prod' }],
    });
    const row = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(row.content)).toMatchObject({
      responseMode: 'choice_or_text',
      options: [{ label: 'Production', selectedLabel: 'Production', value: 'prod' }],
    });
  });

  it('declares the constrained display-card schema', () => {
    const properties = sendCard.tool.inputSchema.properties as Record<string, unknown>;
    const card = properties.card as {
      properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    };
    expect(Object.keys(card.properties)).toEqual(['title', 'description', 'children', 'actions']);
    expect(card.properties.actions.items?.properties).toEqual(expect.objectContaining({
      label: expect.any(Object),
      url: expect.any(Object),
      style: expect.objectContaining({ enum: ['primary', 'danger', 'default'] }),
    }));
  });
});