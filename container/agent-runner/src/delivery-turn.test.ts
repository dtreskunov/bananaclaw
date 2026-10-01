import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import {
  applyDirectives,
  buildDeliveryPrompt,
  buildTranscript,
  parseDirectives,
  runDeliveryTurn,
  splitDraft,
  trimOpening,
  type Complete,
  type DeliveryInput,
} from './delivery-turn.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, CompletionRequest, ProviderEvent } from './providers/types.js';
import { resetHostEventsForTesting } from './session-link.js';

const route = { channelType: 'web', platformId: 'room', threadId: 'thread', inReplyTo: 'in-2' };
const usage = {
  cost_usd: 0.001,
  input_tokens: 900,
  output_tokens: 12,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  model: 'm',
  context_tokens: 912,
};

beforeEach(() => {
  initTestSessionDb();
  const db = getInboundDb();
  db.exec(`INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id) VALUES
    ('web', 'Web', 'channel', 'web', 'room', NULL),
    ('treskowitz', 'Treskowitz', 'agent', NULL, NULL, 'ag-peer')`);
  db.exec(`INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'web', 'room', 'thread')`);
});

let turnsSeeded = false;

function seedTurns(): void {
  if (turnsSeeded) return;
  turnsSeeded = true;
  getOutboundDb().exec(`INSERT INTO turns (id, phase, outcome, provenance) VALUES
    ('turn-0', 'settled', 'replied', 'native'), ('turn-1', 'running', 'pending', 'native')`);
}

function sent(id: string, turnId: string, text: string, timestamp?: string): void {
  seedTurns();
  writeMessageOut({
    id,
    kind: 'chat',
    channel_type: 'web',
    platform_id: 'room',
    thread_id: 'thread',
    turn_id: turnId,
    content: JSON.stringify({ text }),
  });
  if (timestamp) getOutboundDb().prepare('UPDATE messages_out SET timestamp = ? WHERE id = ?').run(timestamp, id);
}

afterEach(() => {
  turnsSeeded = false;
  resetHostEventsForTesting();
  closeSessionDb();
});

function inbound(id: string, seq: number, text: string, timestamp = '2026-09-30T21:00:00.000Z'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content, channel_type, platform_id, thread_id)
       VALUES (?, ?, 'chat', ?, ?, 'web', 'room', 'thread')`,
    )
    .run(id, seq, timestamp, JSON.stringify({ text, sender: 'Denis' }));
}

function input(draft: string, overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  return { draft, routing: route, since: 0, turnId: 'turn-1', assistantName: 'Lab', personaPath: '/nonexistent', ...overrides };
}

function completing(text: string, seen: CompletionRequest[] = []): Complete {
  return async (request) => {
    seen.push(request);
    return { text, usage };
  };
}

describe('splitDraft', () => {
  it('passes through drafts that are only blocks to known destinations', () => {
    expect(splitDraft('<message to="web">hi</message>', 'web').needsRouting).toBe(false);
    expect(splitDraft('<internal>nothing to do</internal>', 'web').needsRouting).toBe(false);
    expect(splitDraft('<think>hmm</think>\n<message to="web">hi</message>\n', 'web').needsRouting).toBe(false);
    expect(splitDraft('', 'web').needsRouting).toBe(false);
  });

  it('routes prose, prose next to blocks, and unknown destinations', () => {
    expect(splitDraft('Here is the answer.', 'web').needsRouting).toBe(true);
    expect(splitDraft('Full table…\n<message to="web">Summary above.</message>', 'web').needsRouting).toBe(true);
    expect(splitDraft('<message to="nobody">hi</message>', 'web').needsRouting).toBe(true);
  });

  it('keeps prose and reply-route blocks in order and sets aside other addressed blocks', () => {
    const parts = splitDraft(
      '<think>plan</think>Table:\n| a | b |<internal>note</internal>\n<message to="web">Summary above.</message>' +
        '<message to="treskowitz">FYI done</message>',
      'web',
    );
    expect(parts.body).toBe('Table:\n| a | b |\n\nSummary above.');
    expect(parts.addressed).toEqual([{ to: 'treskowitz', body: 'FYI done' }]);
    expect(parts.internal).toEqual(['note']);
    expect(parts.needsRouting).toBe(true);
  });
});

describe('parseDirectives / applyDirectives', () => {
  const parts = splitDraft('The full answer.', 'web');

  it('parses deliver and internal directives in any attribute order and ignores reasoning', () => {
    expect(
      parseDirectives(
        '<think>maybe <deliver to="treskowitz"/>?</think><deliver start="Here is" to="web" />\n<internal>ok</internal>',
      ),
    ).toEqual([
      { kind: 'deliver', to: 'web', start: 'Here is' },
      { kind: 'skip', reason: 'ok' },
    ]);
    expect(parseDirectives('<deliver/>')).toBeNull();
    expect(parseDirectives('Sure, I will deliver it.')).toBeNull();
    expect(
      parseDirectives('<deliver to="treskowitz"/> Wait — that\'s wrong. Let me re-check.\n<deliver to="web"/>'),
    ).toBeNull();
  });

  it('delivers the draft as-is without a trace note', () => {
    expect(applyDirectives([{ kind: 'deliver', to: 'web' }], parts, 'web')).toEqual({
      text: '<message to="web">The full answer.</message>',
      decision: 'deliver',
      silent: false,
    });
  });

  it('trims a narration opening and the rule it leaves, noting it in the trace', () => {
    const draft = splitDraft(
      "I don't need that skill — this isn't a frontend task. Let me just write the request.\n\n---\n\n**Subject:** Refund",
      'web',
    );
    const out = applyDirectives([{ kind: 'deliver', to: 'web', start: '**Subject:** Refund' }], draft, 'web')!;
    expect(out).toMatchObject({ decision: 'trim', silent: false });
    expect(out.text).toBe(
      "<internal>Trimmed from the reply: I don't need that skill — this isn't a frontend task. Let me just write the request.\n\n---</internal>\n" +
        '<message to="web">**Subject:** Refund</message>',
    );
  });

  it('never trims on an inexact quote or past the opening', () => {
    const long = splitDraft(`${'Intro. '.repeat(80)}Answer.`, 'web');
    expect(trimOpening(long.body, 'Answer.').text).toBe(long.body);
    expect(trimOpening('Now the answer.\n\nAnswer.', 'Answr.').text).toBe('Now the answer.\n\nAnswer.');
    expect(trimOpening('> "I\'ve reviewed the case."', "I've reviewed").text).toBe('> "I\'ve reviewed the case."');
    expect(trimOpening('Now the answer.\n\n## Found', '## Found')).toEqual({ text: '## Found', dropped: 'Now the answer.' });
    expect(trimOpening('---\nAnswer.', undefined)).toEqual({ text: 'Answer.', dropped: '' });
  });

  it('notes a reply sent somewhere other than the conversation', () => {
    const out = applyDirectives([{ kind: 'deliver', to: 'treskowitz' }], parts, 'web')!;
    expect(out.text).toBe('<internal>Reply sent to `treskowitz`.</internal>\n<message to="treskowitz">The full answer.</message>');
  });

  it('records a skip as silence with the draft in the trace', () => {
    const out = applyDirectives([{ kind: 'skip', reason: 'Already sent.' }], parts, 'web')!;
    expect(out).toMatchObject({ decision: 'skip', silent: true });
    expect(out.text).toBe('<internal>Not delivered — Already sent.\n\nDraft:\n\nThe full answer.</internal>');
  });

  it('rejects unknown destinations', () => {
    expect(applyDirectives([{ kind: 'deliver', to: 'nobody' }], parts, 'web')).toBeNull();
  });
});

describe('buildDeliveryPrompt', () => {
  it('includes persona, destinations, transcript, sent-this-turn and the draft', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-'));
    const persona = path.join(dir, 'CLAUDE.local.md');
    fs.writeFileSync(persona, 'Language: English only.');
    inbound('in-1', 2, 'Look up uncategorized transactions');
    inbound('in-2', 4, 'Propose how you would categorize them', '2026-09-30T21:02:00.000Z');
    sent('out-1', 'turn-0', '241 uncategorized.', '2026-09-30 21:01:00');
    sent('out-2', 'turn-1', 'On it.', '2026-09-30 21:03:00');
    const request = buildDeliveryPrompt(input('The draft.', { personaPath: persona }), splitDraft('The draft.', 'web'));
    expect(request.system).toContain('You are the delivery step');
    expect(request.system).toContain('**Lab**');
    expect(request.system).toContain('<persona>\nLanguage: English only.\n</persona>');
    expect(request.prompt).toContain('`web` (web channel — Web) ← the latest message came from here');
    expect(request.prompt).toContain('`treskowitz` (peer agent — Treskowitz)');
    expect(request.prompt).toMatch(/Denis: Look up uncategorized[\s\S]*Lab: 241 uncategorized\.[\s\S]*Denis \(this turn answers it\): Propose[\s\S]*Lab \(sent this turn\): On it\./);
    expect(request.prompt).toContain('<sent_this_turn>\nTo `web`: On it.\n</sent_this_turn>');
    expect(request.prompt).toContain('<draft>\nThe draft.\n</draft>');
    fs.rmSync(dir, { recursive: true });
  });

  it('orders scheduled-task rows stored as zone-less UTC regardless of the container timezone', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      inbound('in-1', 2, 'first', '2026-09-30T21:00:00.000Z');
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, content, channel_type, platform_id, thread_id)
           VALUES ('task-1', 4, 'task', '2026-09-30 21:05:00', ?, 'web', 'room', 'thread')`,
        )
        .run(JSON.stringify({ prompt: 'daily check' }));
      inbound('in-3', 6, 'third', '2026-09-30T21:10:00.000Z');
      expect(buildTranscript(route, 'turn-1', 'Lab')).toMatch(/first[\s\S]*Scheduled task: daily check[\s\S]*third/);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('keeps the newest whole messages within budget', () => {
    for (let i = 0; i < 20; i++) inbound(`m-${i}`, 2 * i + 2, `${i}:${'x'.repeat(3_000)}`, `2026-09-30T21:${String(i).padStart(2, '0')}:00.000Z`);
    const transcript = buildTranscript(route, 'turn-1', 'Lab');
    expect(transcript.length).toBeLessThanOrEqual(24_000);
    expect(transcript).toContain('19:x');
    expect(transcript).not.toContain(': 0:x');
    for (const entry of transcript.split('\n\n')) expect(entry).toMatch(/x{3000}$/);
  });
});

describe('runDeliveryTurn', () => {
  it('returns null without calling the model when nothing needs routing', async () => {
    const seen: CompletionRequest[] = [];
    expect(await runDeliveryTurn(completing('<deliver to="web"/>', seen), input('<message to="web">hi</message>'))).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('delivers the "summary above" draft with its content', async () => {
    const draft = '| Merchant | Category |\n|---|---|\n| Costco | Groceries |\n<message to="web">Proposed categorization above.</message>';
    const out = await runDeliveryTurn(completing('<deliver to="web"/>'), input(draft));
    expect(out).toMatchObject({ decision: 'deliver', silent: false, usage });
    expect(out!.text).toBe(
      '<message to="web">| Merchant | Category |\n|---|---|\n| Costco | Groceries |\n\nProposed categorization above.</message>',
    );
  });

  it('keeps addressed peer blocks and draft notes alongside the routed reply', async () => {
    const out = await runDeliveryTurn(
      completing('<deliver to="web"/>'),
      input('<internal>checked</internal>Answer.<message to="treskowitz">FYI</message>'),
    );
    expect(out!.text).toBe(
      '<internal>checked</internal>\n<message to="treskowitz">FYI</message>\n<message to="web">Answer.</message>',
    );
  });

  it('falls back to the reply route when the call fails or answers unusably', async () => {
    const failing: Complete = async () => {
      throw new Error('502');
    };
    expect(await runDeliveryTurn(failing, input('Answer.'))).toMatchObject({
      text: '<message to="web">Answer.</message>',
      decision: 'fallback',
      silent: false,
    });
    expect(await runDeliveryTurn(completing('<deliver to="nobody"/>'), input('Answer.'))).toMatchObject({
      text: '<message to="web">Answer.</message>',
      decision: 'fallback',
    });
  });

  it('falls back to the trace when the turn already answered the reply route', async () => {
    sent('sent', 'turn-1', 'Answer.');
    const out = await runDeliveryTurn(completing('garbage'), input('Answer.'));
    expect(out).toMatchObject({ decision: 'fallback', silent: true });
    expect(out!.text).toContain('<internal>Reply not delivered');
  });

  it('propagates an abort instead of falling back', async () => {
    const controller = new AbortController();
    const aborting: Complete = async () => {
      controller.abort();
      throw new Error('aborted');
    };
    await expect(runDeliveryTurn(aborting, input('Answer.'), controller.signal)).rejects.toThrow('aborted');
  });
});

describe('native work prompt', () => {
  it('drops the wrap contract when replies are unwrapped', () => {
    const prompt = buildSystemPromptAddendum('Lab', { unwrappedReplies: true });
    expect(prompt).not.toContain('<message to=');
    expect(prompt).toContain('Write it as plain text that starts with the answer; it is delivered verbatim');
    expect(prompt).toContain('`send_message` MCP tool with `to="name"`');
    expect(buildSystemPromptAddendum('Lab')).toContain('Wrap each delivered message');
  });

  it('ships a native core fragment without the wrap contract', () => {
    const core = fs.readFileSync(path.join(import.meta.dir, 'providers/native/core.md'), 'utf8');
    expect(core).not.toContain('<message to=');
    expect(core).toContain('## Sending messages');
    expect(core).toContain('start with the answer');
  });
});

describe('poll-loop integration', () => {
  async function until(predicate: () => boolean): Promise<void> {
    for (let n = 0; n < 400; n++) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error('turn did not settle');
  }

  function provider(events: ProviderEvent[], complete?: AgentProvider['complete'], pushes: string[] = []): AgentProvider {
    return {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      ...(complete ? { complete, unwrappedReplies: true } : {}),
      query: () => ({
        events: (async function* () {
          yield* events;
        })(),
        push: (message: string) => {
          pushes.push(message);
          return true;
        },
        end: () => {},
        abort: () => {},
      }),
    };
  }

  async function run(p: AgentProvider): Promise<{ text: string | undefined; outcome: string }> {
    inbound('in-2', 2, 'Propose categories');
    const controller = new AbortController();
    const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
    try {
      await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE phase='settled'").get());
      const row = getOutboundDb()
        .prepare("SELECT content FROM messages_out WHERE kind = 'chat' AND channel_type = 'web' ORDER BY seq DESC LIMIT 1")
        .get() as { content: string } | undefined;
      const turn = getOutboundDb().prepare('SELECT outcome FROM turns').get() as { outcome: string };
      return { text: row ? (JSON.parse(row.content) as { text: string }).text : undefined, outcome: turn.outcome };
    } finally {
      controller.abort();
      await loop;
    }
  }

  it('routes an unwrapped result through the delivery turn instead of nudging', async () => {
    const pushes: string[] = [];
    const seen: CompletionRequest[] = [];
    const result = await run(
      provider([{ type: 'result', text: 'Groceries, Travel, Utilities.' }], completing('<deliver to="web"/>', seen), pushes),
    );
    expect(result).toEqual({ text: 'Groceries, Travel, Utilities.', outcome: 'replied' });
    expect(seen).toHaveLength(1);
    expect(pushes).toHaveLength(0);
    const turn = getOutboundDb().prepare('SELECT id FROM turns').get() as { id: string };
    const metadata = JSON.parse(
      (getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(`turn-metadata:${turn.id}`) as {
        value: string;
      }).value,
    );
    // Settled billing, not an in-flight partial call.
    expect(metadata.status).toBe('final');
  });

  it('treats a delivery-turn skip as intentional silence', async () => {
    const result = await run(
      provider([{ type: 'result', text: 'Nothing new.' }], completing('<internal>Nothing to report.</internal>')),
    );
    expect(result).toEqual({ text: undefined, outcome: 'silent' });
  });

  it('treats an <internal>-only draft as intentional silence without a delivery call', async () => {
    const seen: CompletionRequest[] = [];
    const result = await run(
      provider([{ type: 'result', text: '<internal>Nothing new since last check.</internal>' }], completing('', seen)),
    );
    expect(result).toEqual({ text: undefined, outcome: 'silent' });
    expect(seen).toHaveLength(0);
  });

  it('leaves a report-only retry to the fixed report route', async () => {
    const seen: CompletionRequest[] = [];
    const pushes: string[] = [];
    const result = await run(
      provider(
        [
          { type: 'progress', step: { kind: 'tool', id: 't1', tool: 'bash', status: 'completed' } },
          { type: 'result', text: null, strippedToEmpty: true },
          { type: 'result', text: 'The command succeeded.' },
        ],
        completing('<internal>skip</internal>', seen),
        pushes,
      ),
    );
    expect(pushes.some((p) => p.includes('Tools are disabled for this recovery turn'))).toBe(true);
    expect(result).toEqual({ text: 'The command succeeded.', outcome: 'replied' });
    expect(seen).toHaveLength(0);
  });

  it('keeps the wrapping nudge for providers without completions', async () => {
    const pushes: string[] = [];
    await run(
      provider(
        [
          { type: 'result', text: 'unwrapped' },
          { type: 'result', text: '<message to="web">wrapped</message>' },
        ],
        undefined,
        pushes,
      ),
    );
    expect(pushes.some((p) => p.includes('Your reply was not delivered'))).toBe(true);
  });
});
