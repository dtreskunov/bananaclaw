import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { askUserQuestion, sendCard } from './interactive.js';

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