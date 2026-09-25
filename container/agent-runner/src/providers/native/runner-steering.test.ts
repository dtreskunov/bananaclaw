import { expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { NativeProvider } from '../native.js';
import * as attachments from './attachments.js';
import { clearNativeCatalogForTest } from './catalog.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../../db/connection.js';
import { getPendingMessages } from '../../db/messages-in.js';
import { getContinuation } from '../../db/session-state.js';
import { runPollLoop } from '../../poll-loop.js';
import * as link from '../../session-link.js';
import { readInputEditReceipt, readInputState } from '../../steering.js';
import type { ProviderEvent } from '../types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for native runner steering');
}

function response(text: string): Response {
  const base = { id: 'native-integration', object: 'chat.completion.chunk', created: 1, model: 'test-model' };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

it('runs real native steering through runPollLoop as one durable batch and one logical turn', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.native-runner-'));
  const previousBase = process.env.NATIVE_BASE_URL;
  const previousState = process.env.NATIVE_STATE_PATH;
  const previousProtocol = process.env.NATIVE_PROTOCOL;
  const preparationStarted = gate();
  const preparationRelease = gate();
  const firstRelease = gate();
  const secondRelease = gate();
  const requests: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  const turns: Array<link.ActiveTurn | null> = [];
  let active: link.ActiveTurn | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as Record<string, unknown>);
      const index = requests.length;
      await (index === 1 ? firstRelease.promise : secondRelease.promise);
      return response(index === 1 ? 'original draft' : '<message to="web-test">Steered reply</message>');
    },
  });
  process.env.NATIVE_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.NATIVE_STATE_PATH = path.join(root, 'state.db');
  delete process.env.NATIVE_PROTOCOL;
  clearNativeCatalogForTest();
  const realFetch = globalThis.fetch;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    String(input) === 'https://models.dev/api.json'
      ? Promise.resolve(Response.json({}))
      : realFetch(input, init));
  const prepare = attachments.prepareNativeUserMessage;
  let firstPreparation = true;
  const prepareSpy = spyOn(attachments, 'prepareNativeUserMessage').mockImplementation(async (...args) => {
    if (firstPreparation) {
      firstPreparation = false;
      preparationStarted.resolve();
      await preparationRelease.promise;
    }
    return prepare(...args);
  });
  const turnSpy = spyOn(link, 'signalTurnState').mockImplementation((turn) => {
    active = turn;
    turns.push(turn);
  });
  initTestSessionDb();
  getInboundDb().prepare(
    "INSERT INTO destinations (name, type, channel_type, platform_id) VALUES ('web-test', 'channel', 'web', 'room')",
  ).run();
  const insert = (id: string, seq: number, turnId?: string) => {
    getInboundDb().prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, platform_id, thread_id, trigger, sender_identity, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', 'web', 'room', 'thread', 1, 'web:owner', ?)`,
    ).run(id, seq, JSON.stringify({
      text: id,
      ...(turnId ? { inputHandling: { mode: 'steer', turnId } } : {}),
    }));
    link.emitHostEventForTesting();
  };
  insert('initial', 2);
  const provider = new NativeProvider({ model: 'local/test-model' });
  const query = provider.query.bind(provider);
  const querySpy = spyOn(provider, 'query').mockImplementation((input) => {
    const handle = query(input);
    return {
      ...handle,
      events: (async function* () {
        for await (const event of handle.events) {
          events.push(event);
          yield event;
        }
      })(),
    };
  });
  const loop = runPollLoop({ provider, providerName: 'native', cwd: root, signal: controller.signal });
  const editRequestId = randomUUID();
  try {
    await preparationStarted.promise;
    const turn = active as link.ActiveTurn | null;
    expect(turn?.supportsSteering).toBe(true);
    expect(turn?.supportsInputEditing).toBe(true);
    insert('guidance', 4, turn!.id);
    await until(() => readInputState('guidance')?.status === 'steering');
    expect(requests).toHaveLength(0);
    expect(getPendingMessages().map((message) => message.id)).toContain('guidance');
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('guidance'))
      .toBeNull();

    getInboundDb().prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, thread_id, trigger, sender_identity, content)
       VALUES (?, 6, 'system', datetime('now'), 'web', 'room', 'thread', 0, 'web:owner', ?)`,
    ).run(`edit-${editRequestId}`, JSON.stringify({
      action: 'edit_input', requestId: editRequestId, messageId: 'guidance',
      expectedText: 'guidance', replacementText: 'edited direction',
    }));
    link.emitHostEventForTesting();
    await until(() => readInputEditReceipt(editRequestId)?.status === 'accepted');
    preparationRelease.resolve();
    await until(() => requests.length === 1);
    expect(JSON.stringify(requests[0].messages)).not.toContain('guidance');
    firstRelease.resolve();
    await until(() => requests.length === 2 && readInputState('guidance')?.status === 'applied');
    expect(active?.id).toBe(turn!.id);
    expect(JSON.stringify(requests[1].messages)).toContain('edited direction');
    expect(JSON.stringify(requests[1].messages)).not.toContain('edit_input');
    expect(JSON.stringify(requests[1].messages)).not.toContain('>guidance<');
    expect(JSON.stringify(requests[1].messages)).toContain('original draft');
    expect(getPendingMessages()).toEqual([]);
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('guidance'))
      .toEqual({ status: 'processing' });
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(provider.appliedSteering(getContinuation('native')!, ['guidance'])).toEqual(['guidance']);

    secondRelease.resolve();
    await until(() => active === null &&
      (getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('guidance') as
        { status: string } | null)?.status === 'completed');
    expect(getOutboundDb().prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all())
      .toEqual([
        { message_id: `edit-${editRequestId}`, status: 'completed' },
        { message_id: 'guidance', status: 'completed' }, { message_id: 'initial', status: 'completed' },
      ]);
    expect(getOutboundDb().prepare('SELECT platform_id, thread_id FROM messages_out').all())
      .toEqual([{ platform_id: 'room', thread_id: 'thread' }]);
    expect(getOutboundDb().prepare('SELECT input_tokens, output_tokens, num_turns FROM turn_usage').all())
      .toEqual([{ input_tokens: 8, output_tokens: 6, num_turns: 2 }]);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(events.findIndex((event) => event.type === 'steering_applied'))
      .toBeLessThan(events.findIndex((event) => event.type === 'result'));
    expect(new Set(turns.flatMap((turn) => turn ? [turn.id] : [])).size).toBe(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
  } finally {
    controller.abort();
    preparationRelease.resolve();
    firstRelease.resolve();
    secondRelease.resolve();
    await loop;
    querySpy.mockRestore();
    turnSpy.mockRestore();
    prepareSpy.mockRestore();
    fetchSpy.mockRestore();
    link.resetHostEventsForTesting();
    closeSessionDb();
    server.stop(true);
    clearNativeCatalogForTest();
    if (previousBase === undefined) delete process.env.NATIVE_BASE_URL;
    else process.env.NATIVE_BASE_URL = previousBase;
    if (previousState === undefined) delete process.env.NATIVE_STATE_PATH;
    else process.env.NATIVE_STATE_PATH = previousState;
    if (previousProtocol === undefined) delete process.env.NATIVE_PROTOCOL;
    else process.env.NATIVE_PROTOCOL = previousProtocol;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
