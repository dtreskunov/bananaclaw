import fs from 'node:fs';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-session-link-test',
}));

import {
  getSessionSignalActivity,
  getSessionSignalLastSeenAt,
  getSessionSignalTurnEndedAt,
  getSessionSignalUsage,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopAllSessionSignalServers,
  stopSessionSignalServer,
  notifySessionHostState,
} from './session-link.js';
import { inboundDbPath, initSessionFolder, outboundDbPath } from './session-manager.js';
import { insertMessage } from './db/session-db.js';
import Database from 'better-sqlite3';

const SESSION_ID = 'session-a';
const AGENT_GROUP_ID = 'agent-a';

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sessionLinkSocketPath(SESSION_ID));
    socket.once('connect', () => {
      socket.resume();
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

function parsedFrames(value: string): Array<Record<string, unknown>> {
  return value
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  fs.rmSync('/tmp/nanoclaw-session-link-test', { recursive: true, force: true });
  initSessionFolder(AGENT_GROUP_ID, SESSION_ID);
  await startSessionSignalServer(SESSION_ID, AGENT_GROUP_ID);
});

afterEach(async () => {
  await stopAllSessionSignalServers();
  await stopSessionSignalServer(SESSION_ID, true);
  fs.rmSync('/tmp/nanoclaw-session-link-test', { recursive: true, force: true });
});

describe('session signal link', () => {
  it('accepts bounded live state for only the mounted session', async () => {
    const socket = await connect();
    socket.write(`${JSON.stringify({ v: 3, type: 'activity.clear' })}\n`);
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'activity',
        step: { kind: 'tool', id: 'read-1', tool: 'read', status: 'running', detail: 'src/index.ts' },
      })}\n`,
    );
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'usage',
        usage: {
          cost_usd: 0.1,
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          model: 'test/model',
        },
      })}\n`,
    );
    socket.write(`${JSON.stringify({ v: 3, type: 'turn.end' })}\n`);

    await waitFor(() => getSessionSignalTurnEndedAt(SESSION_ID) > 0);
    expect(getSessionSignalActivity(SESSION_ID)).toEqual([
      expect.objectContaining({ text: expect.stringContaining('src/index.ts') }),
    ]);
    expect(getSessionSignalUsage(SESSION_ID)).toMatchObject({ input_tokens: 100, model: 'test/model' });
    expect(getSessionSignalLastSeenAt(SESSION_ID)).toBeGreaterThan(0);
    socket.destroy();
  });

  it('accepts every declared live activity and usage field', async () => {
    const socket = await connect();
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'activity',
        step: {
          kind: 'tool',
          id: 'schema-rejected',
          tool: 'bash',
          status: 'error',
          error: 'invalid arguments',
          rejectedBeforeExecution: true,
        },
      })}\n`,
    );
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'usage',
        usage: {
          cost_usd: 0.1,
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          duration_api_ms: 250,
          model: 'test/model',
        },
      })}\n`,
    );

    await waitFor(() => getSessionSignalUsage(SESSION_ID)?.duration_api_ms === 250);
    expect(JSON.parse(getSessionSignalActivity(SESSION_ID)[0].text)).toMatchObject({
      rejectedBeforeExecution: true,
    });
    socket.destroy();
  });

  it('rejects malformed frames without applying them', async () => {
    const socket = await connect();
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'usage',
        usage: {
          cost_usd: 0,
          input_tokens: -1,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          model: 'bad',
        },
      })}\n`,
    );
    await waitFor(() => socket.destroyed);
    expect(getSessionSignalUsage(SESSION_ID)).toBeNull();
  });

  it('rejects pathological numeric telemetry', async () => {
    const socket = await connect();
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'usage',
        usage: {
          cost_usd: 1e308,
          input_tokens: Number.MAX_SAFE_INTEGER + 1,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          model: 'bad',
        },
      })}\n`,
    );
    await waitFor(() => socket.destroyed);
    expect(getSessionSignalUsage(SESSION_ID)).toBeNull();
  });

  it('rejects payload attempts to choose another session', async () => {
    const socket = await connect();
    socket.write(`${JSON.stringify({ v: 3, type: 'heartbeat', sessionId: 'attempted-spoof' })}\n`);
    await waitFor(() => socket.destroyed);
    expect(getSessionSignalLastSeenAt('attempted-spoof')).toBe(0);
  });

  it('recreates the socket path for reconnect after a host restart', async () => {
    const first = await connect();
    first.destroy();
    await stopSessionSignalServer(SESSION_ID);
    await startSessionSignalServer(SESSION_ID, AGENT_GROUP_ID);

    const second = await connect();
    second.write(`${JSON.stringify({ v: 3, type: 'heartbeat' })}\n`);
    await waitFor(() => getSessionSignalLastSeenAt(SESSION_ID) > 0);
    second.destroy();
  });

  it('keeps the frame budget across reconnects', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await connect();
    for (let i = 0; i < 256; i++) {
      first.write(
        `${JSON.stringify({
          v: 3,
          type: 'activity',
          step: { kind: 'notification', id: `first-${i}`, text: 'ok' },
        })}\n`,
      );
    }
    await waitFor(() => getSessionSignalActivity(SESSION_ID).length === 128);
    first.destroy();
    await new Promise<void>((resolve) => first.once('close', () => resolve()));

    const second = await connect();
    second.write(
      `${JSON.stringify({
        v: 3,
        type: 'activity',
        step: { kind: 'notification', id: 'bypassed-budget', text: 'no' },
      })}\n`,
    );
    await waitFor(() => second.destroyed);
    expect(getSessionSignalActivity(SESSION_ID).some((line) => line.text.includes('bypassed-budget'))).toBe(false);
    now.mockRestore();
  });

  it('suspends the listener after excessive connection churn', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      for (let attempt = 0; attempt < 33; attempt++) {
        const socket = await connect();
        socket.destroy();
        await new Promise<void>((resolve) => socket.once('close', () => resolve()));
      }
      await waitFor(() => !fs.existsSync(sessionLinkSocketPath(SESSION_ID)));
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(fs.existsSync(sessionLinkSocketPath(SESSION_ID))).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('does not let overlapping stop unlink a replacement listener', async () => {
    const first = await connect();
    const stopping = stopSessionSignalServer(SESSION_ID);
    const starting = startSessionSignalServer(SESSION_ID, AGENT_GROUP_ID);
    await Promise.all([stopping, starting]);

    const replacement = await connect();
    replacement.write(`${JSON.stringify({ v: 3, type: 'heartbeat' })}\n`);
    await waitFor(() => getSessionSignalLastSeenAt(SESSION_ID) > 0);
    first.destroy();
    replacement.destroy();
  });

  it('releases retained live state when a container lifecycle ends', async () => {
    const socket = await connect();
    socket.write(`${JSON.stringify({ v: 3, type: 'heartbeat' })}\n`);
    await waitFor(() => getSessionSignalLastSeenAt(SESSION_ID) > 0);
    await stopSessionSignalServer(SESSION_ID, true);
    expect(getSessionSignalLastSeenAt(SESSION_ID)).toBe(0);
    socket.destroy();
  });

  it('commits and acknowledges a durable message exactly once', async () => {
    const socket = await connect();
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    const frame = {
      v: 3,
      type: 'durable',
      eventId: 'event-1',
      sequence: 1,
      event: {
        type: 'message.upsert',
        payload: {
          id: 'out-1',
          seq: 1,
          in_reply_to: null,
          timestamp: '2026-09-01 00:00:00',
          deliver_after: null,
          recurrence: null,
          kind: 'chat',
          platform_id: 'chat-1',
          channel_type: 'web',
          thread_id: null,
          content_base64: Buffer.from('{"text":"hello"}').toString('base64'),
        },
      },
    };
    socket.write(`${JSON.stringify(frame)}\n`);
    await waitFor(() => response.includes('"type":"ack"'));
    socket.write(`${JSON.stringify(frame)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(response.match(/"type":"ack"/g)).toHaveLength(2);

    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT id, seq, content FROM messages_out').all()).toEqual([
        { id: 'out-1', seq: 1, content: '{"text":"hello"}' },
      ]);
      expect(db.prepare('SELECT event_id, sequence FROM applied_runner_events').all()).toEqual([
        { event_id: 'event-1', sequence: 1 },
      ]);
    } finally {
      db.close();
      socket.destroy();
    }
  });

  it.each([
    ['unknown event', 'unknown.event', {}, 'unknown durable event type: unknown.event'],
    [
      'oversized state',
      'state.upsert',
      { key: 'continuation:native', value: 'x'.repeat(1024 * 1024 + 1), updated_at: '2026-09-01 00:00:00' },
      'invalid state.upsert payload',
    ],
    [
      'invalid declared timeout',
      'container.upsert',
      {
        id: 1,
        current_tool: 'Bash',
        tool_declared_timeout_ms: 6 * 60 * 60 * 1000 + 1,
        tool_started_at: '2026-09-01 00:00:00',
        updated_at: '2026-09-01 00:00:00',
      },
      'invalid container.upsert payload',
    ],
  ])('returns a fatal NACK for %s', async (_label, type, payload, expectedError) => {
    const socket = await connect();
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.write(
      `${JSON.stringify({
        v: 3,
        type: 'durable',
        eventId: 'event-bad',
        sequence: 1,
        event: { type, payload },
      })}\n`,
    );
    await waitFor(() => response.includes('"type":"nack"'));

    expect(parsedFrames(response).find((frame) => frame.type === 'nack')).toEqual({
      v: 3,
      type: 'nack',
      eventId: 'event-bad',
      fatal: true,
      code: 'durable_rejected',
      error: expectedError,
    });
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
    } finally {
      db.close();
      socket.destroy();
    }
  });

  it('rejects a sequence gap and a conflicting event replay', async () => {
    const message = {
      id: 'out-1',
      seq: 1,
      in_reply_to: null,
      timestamp: '2026-09-01 00:00:00',
      deliver_after: null,
      recurrence: null,
      kind: 'chat',
      platform_id: 'chat-1',
      channel_type: 'web',
      thread_id: null,
      content_base64: Buffer.from('{"text":"hello"}').toString('base64'),
    };
    const gap = await connect();
    let gapResponse = '';
    gap.setEncoding('utf8');
    gap.on('data', (chunk) => {
      gapResponse += chunk;
    });
    gap.write(
      `${JSON.stringify({
        v: 3,
        type: 'durable',
        eventId: 'event-gap',
        sequence: 2,
        event: { type: 'message.upsert', payload: message },
      })}\n`,
    );
    await waitFor(() => gapResponse.includes('"type":"nack"'));
    expect(parsedFrames(gapResponse).find((frame) => frame.type === 'nack')).toEqual({
      v: 3,
      type: 'nack',
      eventId: 'event-gap',
      fatal: true,
      code: 'durable_rejected',
      error: 'out-of-order durable event',
    });
    gap.destroy();

    const valid = await connect();
    let ack = '';
    valid.setEncoding('utf8');
    valid.on('data', (chunk) => {
      ack += chunk;
    });
    valid.write(
      `${JSON.stringify({
        v: 3,
        type: 'durable',
        eventId: 'event-1',
        sequence: 1,
        event: { type: 'message.upsert', payload: message },
      })}\n`,
    );
    await waitFor(() => ack.includes('"type":"ack"'));
    valid.write(
      `${JSON.stringify({
        v: 3,
        type: 'durable',
        eventId: 'event-1',
        sequence: 1,
        event: {
          type: 'message.upsert',
          payload: {
            ...message,
            content_base64: Buffer.from('{"text":"changed"}').toString('base64'),
          },
        },
      })}\n`,
    );
    await waitFor(() => ack.includes('"type":"nack"'));
    const responses = ack
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(responses.at(-1)).toEqual({
      v: 3,
      type: 'nack',
      eventId: 'event-1',
      fatal: true,
      code: 'durable_rejected',
      error: 'conflicting durable event replay',
    });

    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT content FROM messages_out').pluck().all()).toEqual(['{"text":"hello"}']);
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('replays a host event until the runner acknowledges its local commit', async () => {
    const first = await connect();
    let firstResponse = '';
    first.setEncoding('utf8');
    first.on('data', (chunk) => {
      firstResponse += chunk;
    });

    const inDb = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      insertMessage(inDb, {
        id: 'in-1',
        kind: 'chat',
        timestamp: '2026-09-01 00:00:00',
        channelType: 'web',
        platformId: 'chat-1',
        threadId: null,
        content: '{"text":"hello"}',
        processAfter: null,
        recurrence: null,
      });
    } finally {
      inDb.close();
    }
    notifySessionHostState(SESSION_ID);
    await waitFor(() => parsedFrames(firstResponse).some((frame) => frame.type === 'host.event'));
    const firstEvent = parsedFrames(firstResponse).find((frame) => frame.type === 'host.event')!;
    expect(firstEvent).toMatchObject({ v: 3, type: 'host.event', sequence: 1, event: { type: 'sequence.floor' } });

    first.destroy();
    await waitFor(() => first.destroyed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let secondResponse = '';
    const second = net.createConnection(sessionLinkSocketPath(SESSION_ID));
    second.setEncoding('utf8');
    second.on('data', (chunk) => {
      secondResponse += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      second.once('connect', resolve);
      second.once('error', reject);
    });
    await waitFor(() => parsedFrames(secondResponse).some((frame) => frame.type === 'host.event'));
    const replay = parsedFrames(secondResponse).find((frame) => frame.type === 'host.event')!;
    expect(replay).toMatchObject({ eventId: firstEvent.eventId, sequence: firstEvent.sequence });

    second.write(`${JSON.stringify({ v: 3, type: 'host.ack', eventId: replay.eventId })}\n`);
    await waitFor(() => parsedFrames(secondResponse).filter((frame) => frame.type === 'host.event').length === 2);
    const message = parsedFrames(secondResponse).filter((frame) => frame.type === 'host.event')[1];
    expect(message).toMatchObject({ sequence: 2, event: { type: 'message.upsert' } });
    expect(
      Buffer.from(
        ((message.event as { payload: { content_base64: string } }).payload.content_base64),
        'base64',
      ).toString('utf8'),
    ).toBe('{"text":"hello"}');
    second.write(`${JSON.stringify({ v: 3, type: 'host.ack', eventId: message.eventId })}\n`);
    await waitFor(() => {
      const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS count FROM pending_host_events').get() as { count: number }).count === 0;
      } finally {
        db.close();
      }
    });
    second.destroy();
  });
});
