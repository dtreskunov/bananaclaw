import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import { isAddressableTurn, onTurnStop, SessionSignalClient } from './session-link.js';

const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
const roots: string[] = [];

type TestFrame = { type: string; eventId?: string };

function createSocketPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
  roots.push(root);
  return path.join(root, 'runner.sock');
}

function pendingEventCount(): number {
  return (getOutboundDb().prepare('SELECT count(*) AS n FROM pending_runner_events').get() as { n: number }).n;
}

function acknowledge(socket: net.Socket, frame: TestFrame): void {
  if (frame.type === 'durable' && frame.eventId) {
    socket.write(`${JSON.stringify({ v: 5, type: 'ack', eventId: frame.eventId })}\n`);
  }
}

async function listen(
  socketPath: string,
  lines: string[],
  onFrame?: (socket: net.Socket, frame: TestFrame) => void,
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        lines.push(line);
        onFrame?.(socket, JSON.parse(line) as TestFrame);
        buffer = buffer.slice(newline + 1);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  servers.push(server);
  return server;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  closeSessionDb();
});

describe('SessionSignalClient', () => {
  it('recovers a dead socket without its close callback and drains the queued report', async () => {
    initTestSessionDb();
    const socketPath = createSocketPath();
    const lines: string[] = [];
    await listen(socketPath, lines, acknowledge);
    const createConnection = net.createConnection.bind(net);
    let transport: net.Socket | undefined;
    const connectSpy = spyOn(net, 'createConnection').mockImplementation(
      (...args: Parameters<typeof net.createConnection>) => {
        transport = createConnection(...args);
        return transport;
      },
    );
    const client = new SessionSignalClient(socketPath);
    try {
      void client.start();
      await waitFor(() => lines.some((line) => JSON.parse(line).type === 'turn.state'));
      const dead = transport!;
      // A lost lifecycle notification must not leave the pump pinned to a dead transport.
      dead.removeAllListeners('end');
      dead.removeAllListeners('close');
      sockets[0].end();
      await waitFor(() => dead.destroyed);
      writeMessageOut({ id: 'recovered-report', kind: 'chat', content: '{"text":"Recovered final report."}' });
      await waitFor(() => pendingEventCount() === 0, 2000);
      await client.drain();
      expect(sockets.length).toBe(2);
      expect(transport).not.toBe(dead);
      expect(lines.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'durable')).toHaveLength(1);
    } finally {
      client.stop();
      connectSpy.mockRestore();
    }
  });

  it('reconnects when the host never completes readiness, even with an empty runner journal', async () => {
    initTestSessionDb();
    const socketPath = createSocketPath();
    const lines: string[] = [];
    const server = await listen(socketPath, lines);
    server.on('connection', (socket) => {
      if (sockets.length > 1) socket.write('{"v":5,"type":"host.ready"}\n');
    });
    const epoch = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(epoch);
    const client = new SessionSignalClient(socketPath);
    try {
      const ready = client.start();
      await waitFor(() => lines.some((line) => JSON.parse(line).type === 'turn.state'));
      now.mockReturnValue(epoch + 9999);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sockets).toHaveLength(1);
      expect(sockets[0].destroyed).toBe(false);
      now.mockReturnValue(epoch + 10_000);
      await waitFor(() => sockets.length === 2);
      await ready;
      expect(pendingEventCount()).toBe(0);
    } finally {
      client.stop();
      now.mockRestore();
    }
  });

  it('keeps a productive initial host sync connected when it takes longer than the readiness timeout', async () => {
    initTestSessionDb();
    const socketPath = createSocketPath();
    const lines: string[] = [];
    await listen(socketPath, lines);
    const epoch = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(epoch);
    const client = new SessionSignalClient(socketPath);
    const acknowledged = () => lines.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'host.ack');
    try {
      const ready = client.start();
      await waitFor(() => sockets.length === 1);
      for (let sequence = 1; sequence <= 3; sequence++) {
        now.mockReturnValue(epoch + sequence * 4000);
        sockets[0].write(
          `${JSON.stringify({
            v: 5,
            type: 'host.event',
            eventId: `sync-${sequence}`,
            sequence,
            event: { type: 'sequence.floor', payload: { seq: sequence * 2 } },
          })}\n`,
        );
        await waitFor(() => acknowledged().length === sequence);
      }
      now.mockReturnValue(epoch + 21_999);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sockets).toHaveLength(1);
      expect(acknowledged().map((frame) => frame.eventId)).toEqual(['sync-1', 'sync-2', 'sync-3']);
      sockets[0].write('{"v":5,"type":"host.ready"}\n');
      await ready;
    } finally {
      client.stop();
      now.mockRestore();
    }
  });

  it('does not let a delayed close from a stopped generation schedule retries after restart', async () => {
    initTestSessionDb();
    const socketPath = createSocketPath();
    const lines: string[] = [];
    const server = await listen(socketPath, lines, acknowledge);
    server.on('connection', (socket) => socket.write('{"v":5,"type":"host.ready"}\n'));
    const client = new SessionSignalClient(socketPath);
    try {
      await client.start();
      client.stop();
      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sockets.length).toBe(2);
      client.heartbeat();
      await waitFor(
        () => lines.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'heartbeat').length >= 3,
      );
    } finally {
      client.stop();
    }
  });

  it('reconnects and drains after the host half-closes with an unacknowledged journal head', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'saved-report', kind: 'chat', content: '{"text":"Report preserved."}' });
    const socketPath = createSocketPath();
    const lines: string[] = [];
    const seen: string[] = [];
    await listen(socketPath, lines, (socket, frame) => {
      if (frame.type !== 'durable' || !frame.eventId) return;
      seen.push(frame.eventId);
      if (socket === sockets[0]) socket.end();
      else {
        acknowledge(socket, frame);
        socket.write('{"v":5,"type":"host.ready"}\n');
      }
    });
    const client = new SessionSignalClient(socketPath);
    try {
      await client.start();
      await client.drain();
      expect(sockets).toHaveLength(2);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      expect(pendingEventCount()).toBe(0);
    } finally {
      client.stop();
    }
  });

  it('reconnects after a lost durable ACK and drains the same journal head', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'ack-lost', kind: 'chat', content: '{"text":"Saved reply."}' });
    const socketPath = createSocketPath();
    const lines: string[] = [];
    const seen: string[] = [];
    const server = await listen(socketPath, lines, (socket, frame) => {
      if (frame.type !== 'durable' || !frame.eventId) return;
      seen.push(frame.eventId);
      if (socket !== sockets[0]) acknowledge(socket, frame);
    });
    server.on('connection', (socket) => socket.write('{"v":5,"type":"host.ready"}\n'));
    const epoch = Date.now();
    const now = spyOn(Date, 'now').mockReturnValue(epoch);
    const client = new SessionSignalClient(socketPath);
    try {
      await client.start();
      await waitFor(() => seen.length === 1);
      now.mockReturnValue(epoch + 9999);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sockets).toHaveLength(1);
      expect(sockets[0].destroyed).toBe(false);
      expect(seen).toHaveLength(1);
      now.mockReturnValue(epoch + 10_000);
      await waitFor(() => seen.length === 2);
      await client.drain();
      expect(sockets).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      expect(pendingEventCount()).toBe(0);
    } finally {
      client.stop();
      now.mockRestore();
    }
  });

  it('only advertises safely addressable turns without inventing routing for background inputs', () => {
    const turn = {
      id: 'f90c3a48-713b-4852-96e0-494d8279d87c',
      status: 'running' as const,
      channelType: 'web',
      platformId: 'chat-1',
      threadId: null,
    };
    expect(isAddressableTurn(turn)).toBe(true);
    expect(isAddressableTurn({ ...turn, channelType: '' })).toBe(false);
    expect(isAddressableTurn({ ...turn, platformId: 'bad\nroute' })).toBe(false);
    expect(isAddressableTurn({ ...turn, threadId: '' })).toBe(false);
    expect(isAddressableTurn({ ...turn, threadId: 'a'.repeat(1025) })).toBe(false);
    expect(isAddressableTurn({ ...turn, id: 'bad:id' })).toBe(false);
  });

  it('commits host events before ACK and waits for host.ready at startup', async () => {
    initTestSessionDb();
    const socketPath = createSocketPath();
    const acknowledgements: TestFrame[] = [];
    const server = await listen(socketPath, [], (socket, frame) => {
      if (frame.type !== 'host.ack') return;
      acknowledgements.push(frame);
      socket.write('{"v":5,"type":"host.ready"}\n');
    });
    server.on('connection', (socket) => {
      socket.write(
        `${JSON.stringify({
          v: 5,
          type: 'host.event',
          eventId: 'host-1',
          sequence: 1,
          event: {
            type: 'message.upsert',
            payload: {
              id: 'in-1',
              seq: 2,
              kind: 'chat',
              timestamp: '2026-09-01 00:00:00',
              status: 'pending',
              process_after: null,
              recurrence: null,
              series_id: 'in-1',
              tries: 0,
              trigger: 1,
              platform_id: 'chat-1',
              channel_type: 'web',
              thread_id: null,
              content_base64: Buffer.from('{"text":"hello"}').toString('base64'),
              source_session_id: null,
              on_wake: 0,
              sender_user_id: null,
              sender_identity: 'web:user-1',
            },
          },
        })}\n`,
      );
    });
    const client = new SessionSignalClient(socketPath);
    await client.start();

    expect(acknowledgements).toEqual([{ v: 5, type: 'host.ack', eventId: 'host-1' }]);
    expect(getOutboundDb().prepare('SELECT id, content FROM messages_in').get()).toEqual({
      id: 'in-1',
      content: '{"text":"hello"}',
    });
    client.stop();
  });

  it('sends live signals and replays the bounded current snapshot after reconnect', async () => {
    const socketPath = createSocketPath();
    const firstLines: string[] = [];
    const firstServer = await listen(socketPath, firstLines);
    const client = new SessionSignalClient(socketPath);
    client.start();
    await waitFor(() => firstLines.length >= 4);

    client.clearActivity();
    client.appendActivity({ kind: 'tool', id: 'read-1', tool: 'read', status: 'running', detail: 'src/index.ts' }, 100);
    client.updateUsage({
      cost_usd: 0.1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'test/model',
    });
    client.endTurn();
    client.updateTurn({ id: 'turn-1', status: 'stopping', channelType: 'web', platformId: 'chat-1', threadId: null });
    await waitFor(() => firstLines.some((line) => line.includes('src/index.ts')));

    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => firstServer.close(() => resolve()));
    servers.splice(servers.indexOf(firstServer), 1);
    fs.rmSync(socketPath, { force: true });

    const replayed: string[] = [];
    await listen(socketPath, replayed);
    await waitFor(() => replayed.some((line) => line.includes('src/index.ts')));
    expect(replayed.map((line) => JSON.parse(line).type)).toEqual([
      'heartbeat',
      'activity.clear',
      'activity',
      'usage',
      'turn.end',
      'turn.state',
    ]);
    expect(JSON.parse(replayed.at(-1)!).turn).toMatchObject({ id: 'turn-1', status: 'stopping' });
    client.stop();
  });

  it('accepts exact stop frames and drains committed cancellation before clearing state', async () => {
    initTestSessionDb();
    const socketPath = createSocketPath();
    const lines: string[] = [];
    await listen(socketPath, lines, acknowledge);
    const client = new SessionSignalClient(socketPath);
    const ids: string[] = [];
    const unsubscribe = onTurnStop((id) => ids.push(id));
    try {
      void client.start();
      await waitFor(() => sockets.length > 0);
      sockets[0].write('{"v":5,"type":"turn.stop","turnId":"active"}\n');
      await waitFor(() => ids.length > 0);
      expect(ids).toEqual(['active']);
      writeMessageOut({ id: 'stopped', kind: 'chat', content: '{"text":"Stopped by user."}' });
      await client.drain();
      expect(pendingEventCount()).toBe(0);
    } finally {
      unsubscribe();
      client.stop();
    }
  });

  it('replays a trigger-journaled durable row until the host acknowledges it', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'out-1', kind: 'chat', content: '{"text":"hello"}' });
    expect(pendingEventCount()).toBe(1);

    const socketPath = createSocketPath();
    const lines: string[] = [];
    await listen(socketPath, lines, acknowledge);
    const client = new SessionSignalClient(socketPath);
    client.start();

    await waitFor(() => pendingEventCount() === 0);
    const durable = lines.map((line) => JSON.parse(line)).find((frame) => frame.type === 'durable');
    expect(durable).toMatchObject({
      v: 5,
      sequence: 1,
      event: {
        type: 'message.upsert',
        payload: {
          id: 'out-1',
          seq: 1,
          kind: 'chat',
          turn_id: null,
        },
      },
    });
    expect(JSON.parse(Buffer.from(durable.event.payload.content_base64, 'base64').toString())).toMatchObject({
      text: 'hello',
      timelinePosition: expect.any(Number),
    });
    client.stop();
  });

  it('does not send the next durable event until the current event is acknowledged', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'out-1', kind: 'chat', content: '{"text":"first"}' });
    writeMessageOut({ id: 'out-2', kind: 'chat', content: '{"text":"second"}' });

    const socketPath = createSocketPath();
    const lines: string[] = [];
    await listen(socketPath, lines);
    const client = new SessionSignalClient(socketPath);
    client.start();

    const durableFrames = () => lines.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'durable');
    await waitFor(() => durableFrames().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(durableFrames()).toHaveLength(1);

    sockets[0].write(`${JSON.stringify({ v: 5, type: 'ack', eventId: durableFrames()[0].eventId })}\n`);
    await waitFor(() => durableFrames().length === 2);
    expect(durableFrames().map((frame) => frame.sequence)).toEqual([1, 2]);
    client.stop();
  });

  it('blocks later journal events behind a malformed head', async () => {
    initTestSessionDb();
    const db = getOutboundDb();
    db.prepare(
      `INSERT INTO pending_runner_events (event_id, event_type, payload, created_at)
       VALUES ('bad', 'message.upsert', 'not-json', datetime('now'))`,
    ).run();
    writeMessageOut({ id: 'out-2', kind: 'chat', content: '{"text":"later"}' });

    const socketPath = createSocketPath();
    const lines: string[] = [];
    await listen(socketPath, lines, acknowledge);
    const failures: string[] = [];
    const client = new SessionSignalClient(socketPath, (message) => failures.push(message));
    client.start();
    await waitFor(() => failures.length === 1);

    expect(failures[0]).toContain('durable event 1 blocked');
    expect(lines.some((line) => JSON.parse(line).type === 'durable')).toBe(false);
    expect(pendingEventCount()).toBe(2);
    client.stop();
  });

  it('retains a journal event and stops after a fatal host NACK', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'out-1', kind: 'chat', content: '{"text":"hello"}' });

    const socketPath = createSocketPath();
    let durableFrames = 0;
    await listen(socketPath, [], (socket, frame) => {
      if (frame.type !== 'durable' || !frame.eventId) return;
      durableFrames++;
      socket.write(
        `${JSON.stringify({
          v: 5,
          type: 'nack',
          eventId: frame.eventId,
          fatal: true,
          code: 'durable_rejected',
          error: 'invalid state value',
        })}\n`,
      );
    });

    const failures: string[] = [];
    const client = new SessionSignalClient(socketPath, (message) => failures.push(message));
    client.start();
    await waitFor(() => failures.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(failures[0]).toContain('host rejected event: invalid state value');
    expect(durableFrames).toBe(1);
    expect(pendingEventCount()).toBe(1);
    client.stop();
  });

  it('does not retain an oversized activity frame that would poison reconnect replay', async () => {
    const socketPath = createSocketPath();
    const firstLines: string[] = [];
    const firstServer = await listen(socketPath, firstLines);
    const client = new SessionSignalClient(socketPath);
    client.start();
    await waitFor(() => firstLines.length >= 4);

    client.appendActivity(
      {
        kind: 'patch',
        id: 'oversized',
        files: Array.from({ length: 100 }, (_, index) => `${index}-${'x'.repeat(200)}`),
      },
      100,
    );
    client.updateUsage({
      cost_usd: 0.1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'test/model',
    });
    client.endTurn();
    await waitFor(() => firstLines.some((line) => line.includes('turn.end')));
    expect(firstLines.some((line) => line.includes('oversized'))).toBe(false);

    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => firstServer.close(() => resolve()));
    servers.splice(servers.indexOf(firstServer), 1);
    fs.rmSync(socketPath, { force: true });

    const replayed: string[] = [];
    await listen(socketPath, replayed);
    await waitFor(() => replayed.some((line) => line.includes('turn.end')));
    expect(replayed.some((line) => line.includes('oversized'))).toBe(false);
    expect(replayed.some((line) => line.includes('test/model'))).toBe(true);
    client.stop();
  });
});
