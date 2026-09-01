import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import { SessionSignalClient } from './session-link.js';

const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
const roots: string[] = [];

async function listen(socketPath: string, lines: string[], acknowledge = false): Promise<net.Server> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, newline));
        if (acknowledge) {
          const frame = JSON.parse(lines.at(-1)!) as { type?: string; eventId?: string };
          if (frame.type === 'durable' && frame.eventId) {
            socket.write(`${JSON.stringify({ v: 2, type: 'ack', eventId: frame.eventId })}\n`);
          }
        }
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
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
  it('sends live signals and replays the bounded current snapshot after reconnect', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'runner.sock');
    const firstLines: string[] = [];
    const firstServer = await listen(socketPath, firstLines);
    const client = new SessionSignalClient(socketPath);
    client.start();
    await waitFor(() => firstLines.length >= 4);

    client.clearActivity();
    client.appendActivity({ kind: 'tool', id: 'read-1', tool: 'read', status: 'running', detail: 'src/index.ts' });
    client.updateUsage({
      cost_usd: 0.1,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'test/model',
    });
    client.endTurn();
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
    ]);
    client.stop();
  });

  it('replays a trigger-journaled durable row until the host acknowledges it', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'out-1', kind: 'chat', content: '{"text":"hello"}' });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM pending_runner_events').get()).toEqual({ n: 1 });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'runner.sock');
    const lines: string[] = [];
    await listen(socketPath, lines, true);
    const client = new SessionSignalClient(socketPath);
    client.start();

    await waitFor(
      () => (getOutboundDb().prepare('SELECT COUNT(*) AS n FROM pending_runner_events').get() as { n: number }).n === 0,
    );
    const durable = lines.map((line) => JSON.parse(line)).find((frame) => frame.type === 'durable');
    expect(durable).toMatchObject({
      v: 2,
      sequence: 1,
      event: {
        type: 'message.upsert',
        payload: {
          id: 'out-1',
          seq: 1,
          kind: 'chat',
          content_base64: Buffer.from('{"text":"hello"}').toString('base64'),
        },
      },
    });
    client.stop();
  });

  it('does not send the next durable event until the current event is acknowledged', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'out-1', kind: 'chat', content: '{"text":"first"}' });
    writeMessageOut({ id: 'out-2', kind: 'chat', content: '{"text":"second"}' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'runner.sock');
    const lines: string[] = [];
    await listen(socketPath, lines);
    const client = new SessionSignalClient(socketPath);
    client.start();

    const durableFrames = () => lines.map((line) => JSON.parse(line)).filter((frame) => frame.type === 'durable');
    await waitFor(() => durableFrames().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(durableFrames()).toHaveLength(1);

    sockets[0].write(`${JSON.stringify({ v: 2, type: 'ack', eventId: durableFrames()[0].eventId })}\n`);
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

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'runner.sock');
    const lines: string[] = [];
    await listen(socketPath, lines, true);
    const failures: string[] = [];
    const client = new SessionSignalClient(socketPath, (message) => failures.push(message));
    client.start();
    await waitFor(() => failures.length === 1);

    expect(failures[0]).toContain('durable event 1 blocked');
    expect(lines.some((line) => JSON.parse(line).type === 'durable')).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS count FROM pending_runner_events').get() as { count: number }).count).toBe(
      2,
    );
    client.stop();
  });

  it('retains a journal event and stops after a fatal host NACK', async () => {
    initTestSessionDb();
    writeMessageOut({ id: 'out-1', kind: 'chat', content: '{"text":"hello"}' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'runner.sock');
    let durableFrames = 0;
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buffer.slice(0, newline)) as { type?: string; eventId?: string };
          buffer = buffer.slice(newline + 1);
          if (frame.type !== 'durable' || !frame.eventId) continue;
          durableFrames++;
          socket.write(
            `${JSON.stringify({
              v: 2,
              type: 'nack',
              eventId: frame.eventId,
              fatal: true,
              code: 'durable_rejected',
              error: 'invalid state value',
            })}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    servers.push(server);

    const failures: string[] = [];
    const client = new SessionSignalClient(socketPath, (message) => failures.push(message));
    client.start();
    await waitFor(() => failures.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(failures[0]).toContain('host rejected event: invalid state value');
    expect(durableFrames).toBe(1);
    expect(
      (getOutboundDb().prepare('SELECT COUNT(*) AS count FROM pending_runner_events').get() as { count: number }).count,
    ).toBe(1);
    client.stop();
  });

  it('does not retain an oversized activity frame that would poison reconnect replay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-link-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'runner.sock');
    const firstLines: string[] = [];
    const firstServer = await listen(socketPath, firstLines);
    const client = new SessionSignalClient(socketPath);
    client.start();
    await waitFor(() => firstLines.length >= 4);

    client.appendActivity({
      kind: 'patch',
      id: 'oversized',
      files: Array.from({ length: 100 }, (_, index) => `${index}-${'x'.repeat(200)}`),
    });
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
