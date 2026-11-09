import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { beginTurn, settleTurn } from './turn-execution.js';
import { setTurnContext, withTurnContext } from './current-batch.js';
import { writeMessageOut } from './db/messages-out.js';
import { suggestResponses, sendCard } from './mcp-tools/interactive.js';
import { isSuggestedResponses } from './suggested-responses.js';
import { readFileSync } from 'node:fs';

const route = { channelType: 'web', platformId: 'group:g', threadId: 't', inReplyTo: null };
beforeEach(() => initTestSessionDb());
afterEach(closeSessionDb);

describe('optional response suggestions', () => {
  it('teaches the current tool and when to offer optional reply drafts', () => {
    const instructions = readFileSync(new URL('./mcp-tools/interactive.instructions.md', import.meta.url), 'utf8');
    const names = [...instructions.matchAll(/mcp__nanoclaw__(\w+)/g)].map((match) => match[1]);
    expect(new Set(names)).toEqual(new Set([suggestResponses.tool.name, sendCard.tool.name]));
    expect(instructions).not.toContain('ask_user_question');
    expect(instructions).not.toContain('question_response');
    expect(instructions).toContain('When your final reply offers concrete next steps or alternatives');
    expect(instructions).toContain('No tool call is needed for inline suggestions');
    expect(instructions).toContain('The short label and full draft can differ');
    expect(instructions).toContain('Do not add suggestions to every answer');
    expect(instructions).toContain('without sending');
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(instructions)![1]);
    expect(isSuggestedResponses(example.responses)).toBe(true);
  });
  it('registers without sending a message or waiting for a user', async () => {
    beginTurn(route, []);
    const result = await suggestResponses.handler({ responses: ['Explore costs', 'Show alternatives'] });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('registered') });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
    expect(suggestResponses.tool.inputSchema.required).toEqual(['responses']);
  });

  it('attaches only to the last final reply on the originating route, before settlement', async () => {
    const turn = beginTurn(route, []);
    writeMessageOut({
      id: 'progress',
      kind: 'chat',
      ...routing(route),
      content: JSON.stringify({ text: 'Working', delivery_origin: 'send_message' }),
    });
    await suggestResponses.handler({ responses: ['First draft'] });
    writeMessageOut({
      id: 'first-final',
      kind: 'chat',
      ...routing(route),
      content: JSON.stringify({ text: 'Part one', delivery_origin: 'response' }),
    });
    await suggestResponses.handler({ responses: ['Latest draft'] });
    writeMessageOut({
      id: 'final',
      kind: 'chat',
      ...routing(route),
      content: JSON.stringify({ text: 'Finished', delivery_origin: 'response' }),
    });
    writeMessageOut({
      id: 'other-route',
      kind: 'chat',
      ...routing({ ...route, threadId: 'other' }),
      content: JSON.stringify({ text: 'Other chat', delivery_origin: 'response' }),
    });
    await settleTurn(turn, 'replied');
    const rows = getOutboundDb()
      .prepare("SELECT key,value FROM session_state WHERE key LIKE 'response-suggestions:%'")
      .all();
    expect(rows).toEqual([{ key: 'response-suggestions:final', value: '["Latest draft"]' }]);
    expect(
      getOutboundDb().prepare("SELECT 1 FROM session_state WHERE key LIKE 'runner:suggested-responses:%'").get(),
    ).toBeNull();
    const events = getOutboundDb()
      .prepare('SELECT event_type,payload FROM pending_runner_events ORDER BY sequence')
      .all() as { event_type: string; payload: string }[];
    const suggestions = events.findIndex((event) => JSON.parse(event.payload).key === 'response-suggestions:final');
    const settlement = events.findIndex(
      (event) => event.event_type === 'turn.upsert' && JSON.parse(event.payload).phase === 'settled',
    );
    expect(suggestions).toBeGreaterThan(-1);
    expect(settlement).toBeGreaterThan(suggestions);
  });

  it.each(['silent', 'failed', 'stopped'] as const)('discards drafts on a %s outcome', async (outcome) => {
    const turn = beginTurn(route, []);
    await suggestResponses.handler({ responses: ['Do not resurrect this'] });
    await settleTurn(turn, outcome);
    expect(
      getOutboundDb()
        .prepare(
          "SELECT 1 FROM session_state WHERE key LIKE '%suggested-responses:%' OR key LIKE 'response-suggestions:%'",
        )
        .get(),
    ).toBeNull();
  });

  it('rejects missing context and invalid shapes, including whitespace and duplicates', async () => {
    setTurnContext(null);
    expect((await suggestResponses.handler({ responses: ['Draft'] })).isError).toBe(true);
    beginTurn(route, []);
    for (const responses of [
      [],
      [' '],
      ['A', 'A'],
      ['a'.repeat(241)],
      Array(7).fill('A'),
      [{ label: 'A', value: 'hidden' }],
    ]) {
      expect(isSuggestedResponses(responses)).toBe(false);
      expect((await suggestResponses.handler({ responses })).isError).toBe(true);
    }
  });

  it('never lets captured context register drafts on a successor turn', async () => {
    const prior = beginTurn(route, []);
    await settleTurn(prior, 'silent');
    const successor = beginTurn({ ...route, threadId: 'new' }, []);
    await expect(withTurnContext(prior, () => suggestResponses.handler({ responses: ['Old draft'] }))).rejects.toThrow(
      'running turn',
    );
    expect(
      getOutboundDb()
        .prepare('SELECT 1 FROM session_state WHERE key=?')
        .get(`runner:suggested-responses:${successor.turnId}`),
    ).toBeNull();
  });

  it('retains the display-card schema independently of reply suggestions', () => {
    expect(sendCard.tool.inputSchema.required).toEqual(['card']);
    const card = sendCard.tool.inputSchema.properties?.card;
    expect(card).toEqual(expect.objectContaining({ type: 'object' }));
  });
});

function routing(value: typeof route) {
  return { channel_type: value.channelType, platform_id: value.platformId, thread_id: value.threadId };
}
