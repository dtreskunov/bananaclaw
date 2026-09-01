import fs from 'node:fs';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ DATA_DIR: '/tmp/nanoclaw-session-link-test' }));

import {
  getSessionSignalActivity,
  getSessionSignalLastSeenAt,
  getSessionSignalTurnEndedAt,
  getSessionSignalUsage,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopAllSessionSignalServers,
  stopSessionSignalServer,
} from './session-link.js';

const SESSION_ID = 'session-a';

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sessionLinkSocketPath(SESSION_ID));
    socket.once('connect', () => resolve(socket));
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

beforeEach(async () => {
  fs.rmSync('/tmp/nanoclaw-session-link-test', { recursive: true, force: true });
  await startSessionSignalServer(SESSION_ID);
});

afterEach(async () => {
  await stopAllSessionSignalServers();
  await stopSessionSignalServer(SESSION_ID, true);
  fs.rmSync('/tmp/nanoclaw-session-link-test', { recursive: true, force: true });
});

describe('session signal link', () => {
  it('accepts bounded live state for only the mounted session', async () => {
    const socket = await connect();
    socket.write(`${JSON.stringify({ v: 1, type: 'activity.clear' })}\n`);
    socket.write(
      `${JSON.stringify({
        v: 1,
        type: 'activity',
        step: { kind: 'tool', id: 'read-1', tool: 'read', status: 'running', detail: 'src/index.ts' },
      })}\n`,
    );
    socket.write(
      `${JSON.stringify({
        v: 1,
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
    socket.write(`${JSON.stringify({ v: 1, type: 'turn.end' })}\n`);

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
        v: 1,
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
        v: 1,
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
        v: 1,
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
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(getSessionSignalUsage(SESSION_ID)).toBeNull();
  });

  it('rejects pathological numeric telemetry', async () => {
    const socket = await connect();
    socket.write(
      `${JSON.stringify({
        v: 1,
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
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(getSessionSignalUsage(SESSION_ID)).toBeNull();
  });

  it('rejects payload attempts to choose another session', async () => {
    const socket = await connect();
    socket.write(`${JSON.stringify({ v: 1, type: 'heartbeat', sessionId: 'attempted-spoof' })}\n`);
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(getSessionSignalLastSeenAt('attempted-spoof')).toBe(0);
  });

  it('recreates the socket path for reconnect after a host restart', async () => {
    const first = await connect();
    first.destroy();
    await stopSessionSignalServer(SESSION_ID);
    await startSessionSignalServer(SESSION_ID);

    const second = await connect();
    second.write(`${JSON.stringify({ v: 1, type: 'heartbeat' })}\n`);
    await waitFor(() => getSessionSignalLastSeenAt(SESSION_ID) > 0);
    second.destroy();
  });

  it('keeps the frame budget across reconnects', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await connect();
    for (let i = 0; i < 256; i++) {
      first.write(
        `${JSON.stringify({
          v: 1,
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
        v: 1,
        type: 'activity',
        step: { kind: 'notification', id: 'bypassed-budget', text: 'no' },
      })}\n`,
    );
    await new Promise<void>((resolve) => second.once('close', () => resolve()));
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
    const starting = startSessionSignalServer(SESSION_ID);
    await Promise.all([stopping, starting]);

    const replacement = await connect();
    replacement.write(`${JSON.stringify({ v: 1, type: 'heartbeat' })}\n`);
    await waitFor(() => getSessionSignalLastSeenAt(SESSION_ID) > 0);
    first.destroy();
    replacement.destroy();
  });

  it('releases retained live state when a container lifecycle ends', async () => {
    const socket = await connect();
    socket.write(`${JSON.stringify({ v: 1, type: 'heartbeat' })}\n`);
    await waitFor(() => getSessionSignalLastSeenAt(SESSION_ID) > 0);
    await stopSessionSignalServer(SESSION_ID, true);
    expect(getSessionSignalLastSeenAt(SESSION_ID)).toBe(0);
    socket.destroy();
  });
});
