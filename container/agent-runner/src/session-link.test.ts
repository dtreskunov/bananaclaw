import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { SessionSignalClient } from './session-link.js';

const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
const roots: string[] = [];

async function listen(socketPath: string, lines: string[]): Promise<net.Server> {
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, newline));
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
