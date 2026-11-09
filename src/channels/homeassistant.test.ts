import type http from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the request handler the adapter registers on setup() so we can
// drive it with synthetic req/res objects. Must be set up before the
// module under test is imported (vi.mock is hoisted).
const mountHandlerSpy =
  vi.fn<(prefix: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void>();
vi.mock('../webhook-server.js', () => ({
  mountHandler: (prefix: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) =>
    mountHandlerSpy(prefix, handler),
}));

// Stub the DB lookups so ensureMessagingGroup is a no-op (already wired).
vi.mock('../db/messaging-groups.js', () => ({
  createMessagingGroup: vi.fn(),
  createMessagingGroupAgent: vi.fn(),
  getMessagingGroupAgents: vi.fn(() => [{ agent_group_id: 'ag-1' }]),
  getMessagingGroupByPlatform: vi.fn(() => ({ id: 'mg-1' })),
}));

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ACKS,
  buildTurn,
  createAdapter,
  extractDisplayQuery,
  extractOutboundText,
  FILLER_INTERVAL_MS,
  FILLERS,
  renderApprovalRequest,
  safeEqual,
  streamEnd,
  streamError,
  streamItem,
} from './homeassistant.js';

describe('buildTurn', () => {
  it('returns just the query as visible text', () => {
    const { text } = buildTurn({ query: 'Turn on the lights' });
    expect(text).toBe('Turn on the lights');
  });

  it('ignores system_prompt and exposed_entities — the agent reads live state via HA MCP', () => {
    const result = buildTurn({
      query: 'Is the kitchen light on?',
      system_prompt: 'Be concise.',
      exposed_entities: [{ entity_id: 'light.kitchen', name: 'Kitchen', state: 'on' }],
    });
    // Visible text is only the user's words — no state blob, no context field.
    expect(result.text).toBe('Is the kitchen light on?');
    expect(result.text).not.toContain('light.kitchen');
    expect(result).not.toHaveProperty('context');
  });

  it('ignores exposed_entities passed as a pre-serialized JSON string', () => {
    const { text } = buildTurn({
      query: 'status?',
      exposed_entities: '[{"entity_id":"switch.fan"}]',
    });
    expect(text).toBe('status?');
    expect(text).not.toContain('switch.fan');
  });

  it('ignores tool_result messages too — our adapter never emits tool_calls so HA never sends them back', () => {
    const { text } = buildTurn({
      query: 'and now?',
      messages: [
        { role: 'user', content: 'turn on fan' },
        { role: 'tool_result', tool_name: 'switch.turn_on', content: '{"success":true}' },
      ],
    });
    expect(text).toBe('and now?');
    expect(text).not.toContain('Tool Result');
    expect(text).not.toContain('success');
  });

  it('returns empty text when there is nothing to send', () => {
    expect(buildTurn({}).text).toBe('');
    expect(buildTurn({ query: '   ' }).text).toBe('');
  });

  it('never plumbs prior user/assistant turns into the prompt — the agent has them via session memory', () => {
    const { text } = buildTurn({
      query: 'the floor one',
      messages: [
        { role: 'user', content: 'turn off the lamp' },
        { role: 'assistant', content: 'Which lamp?' },
        { role: 'user', content: 'the floor one' },
      ],
    });
    expect(text).toBe('the floor one');
    expect(text).not.toContain('[Conversation so far]');
    expect(text).not.toContain('turn off the lamp');
    expect(text).not.toContain('Which lamp?');
  });
});

describe('extractDisplayQuery', () => {
  it('returns text unchanged when no markers are present', () => {
    expect(extractDisplayQuery('turn on the kitchen light')).toBe('turn on the kitchen light');
  });

  it('strips a [Conversation so far] block', () => {
    const text = '[Conversation so far]\nUser: Hi.\nAssistant: Hello.\n[End conversation so far]\n\nWhat time is it?';
    expect(extractDisplayQuery(text)).toBe('What time is it?');
  });

  it('strips [Tool Result] blocks', () => {
    const text = '[Tool Result: HassRespond]\n{"speech":"hi"}\n[End Tool Result]\n\nAh.';
    expect(extractDisplayQuery(text)).toBe('Ah.');
  });

  it('strips both blocks together', () => {
    const text =
      '[Conversation so far]\nUser: Hi.\nAssistant: Hello.\n[End conversation so far]\n\n[Tool Result: HassRespond]\n{"ok":true}\n[End Tool Result]\n\nWhat now?';
    expect(extractDisplayQuery(text)).toBe('What now?');
  });
});

describe('extractOutboundText', () => {
  it('reads markdown then text from object content', () => {
    expect(extractOutboundText({ kind: 'chat', content: { markdown: 'hello' } })).toBe('hello');
    expect(extractOutboundText({ kind: 'chat', content: { text: 'plain' } })).toBe('plain');
  });

  it('prefers markdown over text', () => {
    expect(extractOutboundText({ kind: 'chat', content: { markdown: 'm', text: 't' } })).toBe('m');
  });

  it('handles string content', () => {
    expect(extractOutboundText({ kind: 'chat', content: 'raw' })).toBe('raw');
  });

  it('returns null for non-text payloads', () => {
    expect(extractOutboundText({ kind: 'chat', content: { type: 'card' } })).toBeNull();
    expect(extractOutboundText({ kind: 'chat', content: null })).toBeNull();
  });

  it('renders an approval notice so the HA request settles without authorizing a voice reply', () => {
    const text = extractOutboundText({
      kind: 'chat-sdk',
      content: {
        type: 'approval_request',
        approvalId: 'a1',
        title: 'Which office lamp?',
        body: 'Which office lamp did you want to turn on?',
        options: [
          { label: 'Office Desk Lamp', value: 'Office Desk Lamp' },
          { label: 'Office Floor Lamp', value: 'Office Floor Lamp' },
        ],
      },
    });
    expect(text).toBe(
      'Which office lamp did you want to turn on? Options: Office Desk Lamp or Office Floor Lamp. Review this approval in BananaClaw or its approval message.',
    );
  });
});

describe('renderApprovalRequest', () => {
  it('renders the prompt first with options as a natural inline list', () => {
    expect(
      renderApprovalRequest({
        type: 'approval_request',
        title: 'Pick one',
        body: 'Which lamp?',
        options: [{ label: 'Desk' }, { label: 'Floor' }, { label: 'Corner' }],
      }),
    ).toBe('Which lamp? Options: Desk, Floor, or Corner. Review this approval in BananaClaw or its approval message.');
  });

  it('joins two options with "or"', () => {
    expect(
      renderApprovalRequest({
        type: 'approval_request',
        body: 'Which one?',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
    ).toBe('Which one? Options: A or B. Review this approval in BananaClaw or its approval message.');
  });

  it('falls back to title when body is missing', () => {
    expect(
      renderApprovalRequest({
        type: 'approval_request',
        title: 'Pick one',
        options: [{ label: 'A' }, { label: 'B' }],
      }),
    ).toBe('Pick one Options: A or B. Review this approval in BananaClaw or its approval message.');
  });

  it('renders the prompt alone when there are no usable option labels', () => {
    expect(renderApprovalRequest({ type: 'approval_request', body: 'Review required.', options: [] })).toBe(
      'Review required. Review this approval in BananaClaw or its approval message.',
    );
    expect(renderApprovalRequest({ type: 'approval_request', body: 'Review required.' })).toBe(
      'Review required. Review this approval in BananaClaw or its approval message.',
    );
  });

  it('does not append a question mark to an approval notice', () => {
    expect(renderApprovalRequest({ type: 'approval_request', body: 'Review access' })).toBe(
      'Review access Review this approval in BananaClaw or its approval message.',
    );
  });

  it('renders options alone when there is no prompt', () => {
    expect(
      renderApprovalRequest({ type: 'approval_request', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }),
    ).toBe('Options: A, B, or C. Review this approval in BananaClaw or its approval message.');
  });

  it('returns null for unsupported payloads, including old questions', () => {
    expect(renderApprovalRequest({ type: 'send_card', text: 'x' })).toBeNull();
    expect(renderApprovalRequest({ type: 'ask_question', question: 'Old question' })).toBeNull();
    expect(renderApprovalRequest({ title: 'no type' })).toBeNull();
  });

  it('returns null when an approval has neither body nor options', () => {
    expect(renderApprovalRequest({ type: 'approval_request' })).toBeNull();
    expect(renderApprovalRequest({ type: 'approval_request', options: [{ value: 'x' }] })).toBeNull();
  });
});

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(safeEqual('secret', 'secryt')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(safeEqual('short', 'longervalue')).toBe(false);
  });
});

describe('streaming chunk encoders', () => {
  it('emits one NDJSON line per call, newline-terminated', () => {
    expect(streamItem('hi')).toBe('{"type":"item","content":"hi"}\n');
    expect(streamEnd()).toBe('{"type":"end"}\n');
    expect(streamError('boom')).toBe('{"type":"error","message":"boom"}\n');
  });

  it('escapes embedded newlines and quotes so the line stays parseable', () => {
    const line = streamItem('line1\nline2 with "quotes"');
    // Exactly one trailing newline — the rest must be JSON-escaped.
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).split('\n')).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({ type: 'item', content: 'line1\nline2 with "quotes"' });
  });

  it('round-trips through JSON.parse the way HA s _send_payload_streaming reads it', () => {
    const chunks = [streamItem('thinking...'), streamItem('done'), streamEnd()];
    const parsed = chunks
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(parsed).toEqual([
      { type: 'item', content: 'thinking...' },
      { type: 'item', content: 'done' },
      { type: 'end' },
    ]);
  });
});

// ── Streaming integration: echo + rotating filler timer ─────────────────────
//
// The user gets near-instant voice feedback by streaming an immediate echo
// of their query, then rotating filler words ("Thinking", "Pondering", …)
// every FILLER_INTERVAL_MS until the agent's reply lands. Drive
// `handleRequest` (captured via mountHandler) with fake req/res objects.

interface FakeRes {
  headers?: Record<string, string>;
  status?: number;
  chunks: string[];
  ended: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => FakeRes;
  write: (chunk: string) => boolean;
  end: (chunk?: string) => FakeRes;
  headersSent: boolean;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    chunks: [],
    ended: false,
    headersSent: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    write(chunk) {
      res.chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk));
      res.ended = true;
      return res;
    },
  };
  return res;
}

function fakeReq(body: unknown): http.IncomingMessage {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  // Async iterable that yields the body in one chunk.
  return {
    method: 'POST',
    headers: {},
    [Symbol.asyncIterator]: async function* () {
      yield buf;
    },
  } as unknown as http.IncomingMessage;
}

async function flushMicrotasks(): Promise<void> {
  // handleRequest awaits body-iterator next() twice plus onInboundEvent;
  // flush generously so the production code is past `pending.set` before
  // the test moves on. Cheap and deterministic.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function driveHandler(
  body: unknown,
): Promise<{ res: FakeRes; handler: (req: http.IncomingMessage, res: http.ServerResponse) => void }> {
  mountHandlerSpy.mockClear();
  // Each test gets its own adapter so pending maps don't leak. Use a
  // generous timeoutMs so the request-timeout setTimeout never fires
  // during a fake-timer-driven test, no matter how far we advance.
  const adapter = createAdapter({ agentGroupId: 'ag-1', timeoutMs: 3_600_000 });
  const onInbound = vi.fn().mockResolvedValue(undefined);
  await adapter.setup({
    onInboundEvent: onInbound,
    onAccessChange: vi.fn(),
  } as unknown as Parameters<typeof adapter.setup>[0]);
  const handler = mountHandlerSpy.mock.calls[0][1];
  const res = fakeRes();
  handler(fakeReq(body), res as unknown as http.ServerResponse);
  await flushMicrotasks();
  return { res, handler };
}

describe('streaming response: echo + filler timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("immediately writes the user's query as the first NDJSON item (the echo) when stream:true", async () => {
    const { res } = await driveHandler({
      conversation_id: 'c1',
      query: 'Turn on the kitchen lights',
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('application/x-ndjson');
    expect(res.chunks.length).toBeGreaterThan(0);
    const first = JSON.parse(res.chunks[0].trim());
    expect(first.type).toBe('item');
    expect(first.content).toMatch(/^Turn on the kitchen lights\. \n.+\.\.\.$/);
    // The ack must be one of the known ACKS phrases.
    const ack = first.content.replace('Turn on the kitchen lights. \n', '');
    expect(ACKS).toContain(ack);
    expect(res.ended).toBe(false);
    vi.useRealTimers();
  });

  it('preserves trailing terminal punctuation in the echo (no double-period)', async () => {
    const { res } = await driveHandler({ conversation_id: 'c1', query: 'What time is it?', stream: true });
    const first = JSON.parse(res.chunks[0].trim());
    expect(first.content).toMatch(/^What time is it\? \n.+\.\.\.$/);
    vi.useRealTimers();
  });

  it('emits fillers from the pool, one chunk per FILLER_INTERVAL_MS tick', async () => {
    const { res } = await driveHandler({ conversation_id: 'c1', query: 'hi', stream: true });
    expect(res.chunks).toHaveLength(1); // just the echo

    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS);
    expect(res.chunks).toHaveLength(2);
    const f1 = JSON.parse(res.chunks[1].trim());
    expect(f1.type).toBe('item');
    expect(FILLERS).toContain(f1.content.trim());

    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS);
    const f2 = JSON.parse(res.chunks[2].trim());
    expect(FILLERS).toContain(f2.content.trim());

    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS);
    const f3 = JSON.parse(res.chunks[3].trim());
    expect(FILLERS).toContain(f3.content.trim());
    vi.useRealTimers();
  });

  it('continues emitting fillers until settled (no cap)', async () => {
    const { res } = await driveHandler({ conversation_id: 'c1', query: 'hi', stream: true });
    // Tick many intervals — fillers should keep coming.
    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS * 20);
    // 1 echo + 20 fillers.
    expect(res.chunks.length).toBe(21);
    expect(res.ended).toBe(false);
    vi.useRealTimers();
  });

  it('settles with the final reply, then end, and stops the filler timer', async () => {
    const adapter = createAdapter({ agentGroupId: 'ag-1', timeoutMs: 3_600_000 });
    await adapter.setup({
      onInboundEvent: vi.fn().mockResolvedValue(undefined),
      onAccessChange: vi.fn(),
    } as unknown as Parameters<typeof adapter.setup>[0]);
    const handler = mountHandlerSpy.mock.calls.at(-1)![1];
    const res = fakeRes();
    handler(fakeReq({ conversation_id: 'c1', query: 'hi', stream: true }), res as unknown as http.ServerResponse);
    await flushMicrotasks();

    // Fire one filler so we have something to compare against.
    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS);
    const lengthBeforeReply = res.chunks.length;
    expect(lengthBeforeReply).toBeGreaterThanOrEqual(2);

    await adapter.deliver!('ha:ag-1', 'c1', {
      kind: 'chat',
      content: { text: 'OK, turning them on.' },
    } as Parameters<NonNullable<typeof adapter.deliver>>[2]);

    // Final reply item + end marker, then close.
    const tailParsed = res.chunks.slice(lengthBeforeReply).map((c) => JSON.parse(c.trim()));
    expect(tailParsed).toEqual([{ type: 'item', content: 'OK, turning them on.' }, { type: 'end' }]);
    expect(res.ended).toBe(true);

    // No new chunks even after another interval window.
    const lengthAfterDeliver = res.chunks.length;
    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS * 3);
    expect(res.chunks).toHaveLength(lengthAfterDeliver);
    vi.useRealTimers();
  });

  it('non-streaming requests get the legacy single-JSON body and no filler timer', async () => {
    const adapter = createAdapter({ agentGroupId: 'ag-1', timeoutMs: 3_600_000 });
    await adapter.setup({
      onInboundEvent: vi.fn().mockResolvedValue(undefined),
      onAccessChange: vi.fn(),
    } as unknown as Parameters<typeof adapter.setup>[0]);
    const handler = mountHandlerSpy.mock.calls.at(-1)![1];
    const res = fakeRes();
    // No `stream` field at all → legacy mode.
    handler(fakeReq({ conversation_id: 'c1', query: 'hi' }), res as unknown as http.ServerResponse);
    await flushMicrotasks();

    // No early chunks: legacy mode holds the request silent until deliver.
    expect(res.chunks).toHaveLength(0);
    expect(res.ended).toBe(false);

    // Filler timer should NOT fire in legacy mode.
    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS * 3);
    expect(res.chunks).toHaveLength(0);

    await adapter.deliver!('ha:ag-1', 'c1', {
      kind: 'chat',
      content: { text: 'done' },
    } as Parameters<NonNullable<typeof adapter.deliver>>[2]);
    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.chunks.join(''))).toEqual({ output: 'done' });
    expect(res.ended).toBe(true);
    vi.useRealTimers();
  });

  it('supersedes an in-flight streaming request with an error chunk and stops its filler', async () => {
    const adapter = createAdapter({ agentGroupId: 'ag-1', timeoutMs: 3_600_000 });
    await adapter.setup({
      onInboundEvent: vi.fn().mockResolvedValue(undefined),
      onAccessChange: vi.fn(),
    } as unknown as Parameters<typeof adapter.setup>[0]);
    const handler = mountHandlerSpy.mock.calls.at(-1)![1];

    const res1 = fakeRes();
    handler(fakeReq({ conversation_id: 'c1', query: 'first', stream: true }), res1 as unknown as http.ServerResponse);
    await flushMicrotasks();

    const res2 = fakeRes();
    handler(fakeReq({ conversation_id: 'c1', query: 'second', stream: true }), res2 as unknown as http.ServerResponse);
    await flushMicrotasks();

    // res1 should be closed with an error chunk.
    expect(res1.ended).toBe(true);
    const last1 = JSON.parse(res1.chunks.at(-1)!.trim());
    expect(last1).toEqual({ type: 'error', message: 'superseded' });

    // res1's filler timer must not produce more chunks.
    const before = res1.chunks.length;
    await vi.advanceTimersByTimeAsync(FILLER_INTERVAL_MS * 3);
    expect(res1.chunks).toHaveLength(before);

    // res2 stays open with its own echo as the first chunk.
    expect(res2.ended).toBe(false);
    expect(JSON.parse(res2.chunks[0].trim()).content).toMatch(/^second\. \n.+\.\.\.$/);
    vi.useRealTimers();
  });

  it('FILLERS pool has enough variety for long turns', () => {
    expect(FILLERS.length).toBeGreaterThanOrEqual(10);
  });
});
