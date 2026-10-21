import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startEgressRelay } from './egress-relay.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function unixServer(onConnection: (socket: net.Socket) => void): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const socketPath = path.join(dir, 'egress.sock');
  const server = net.createServer(onConnection);
  cleanup.push(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(socketPath)));
}

async function relay(socketPath: string): Promise<number> {
  const server = await startEgressRelay(socketPath, 0);
  if (!server) throw new Error('relay did not start');
  cleanup.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

/** Sends each request after the previous reply, like a keep-alive HTTP client. */
function exchange(port: number, requests: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ port, host: '127.0.0.1' });
    const replies: string[] = [];
    client.on('data', (chunk) => {
      replies.push(chunk.toString());
      if (replies.length === requests.length) {
        client.end();
        resolve(replies);
      } else {
        client.write(requests[replies.length]!);
      }
    });
    client.on('error', reject);
    client.on('connect', () => client.write(requests[0]!));
  });
}

describe('startEgressRelay', () => {
  test('is off without a socket path', async () => {
    expect(await startEgressRelay(undefined, 0)).toBeNull();
  });

  test('pipes requests and replies both ways on one connection', async () => {
    const socketPath = await unixServer((socket) => {
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    });
    const port = await relay(socketPath);
    const big = 'x'.repeat(256 * 1024);
    const replies = await exchange(port, ['CONNECT example.com:443 HTTP/1.1\r\n\r\n', 'ping']);
    expect(replies).toEqual(['echo:CONNECT example.com:443 HTTP/1.1\r\n\r\n', 'echo:ping']);

    const received = await new Promise<number>((resolve, reject) => {
      const client = net.connect({ port, host: '127.0.0.1' });
      let total = 0;
      client.on('data', (chunk) => {
        total += chunk.length;
        if (total >= big.length + 'echo:'.length) {
          client.end();
          resolve(total);
        }
      });
      client.on('error', reject);
      client.on('connect', () => client.write(big));
    });
    expect(received).toBeGreaterThanOrEqual(big.length);
  });

  test('closes the client when the gateway ends the connection', async () => {
    const socketPath = await unixServer((socket) => socket.end('bye'));
    const port = await relay(socketPath);
    const result = await new Promise<string>((resolve) => {
      const client = net.connect({ port, host: '127.0.0.1' });
      let received = '';
      client.on('data', (chunk) => (received += chunk.toString()));
      client.on('error', () => {});
      client.on('close', () => resolve(received));
    });
    expect(result).toBe('bye');
  });

  test('closes the client when the gateway socket is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const port = await relay(path.join(dir, 'egress.sock'));
    const closed = await new Promise<boolean>((resolve) => {
      const client = net.connect({ port, host: '127.0.0.1' });
      client.on('error', () => {});
      client.on('close', () => resolve(true));
    });
    expect(closed).toBe(true);
  });

  test('fails to start when the port is taken', async () => {
    const socketPath = await unixServer((socket) => socket.end());
    const port = await relay(socketPath);
    await expect(startEgressRelay(socketPath, port)).rejects.toThrow();
  });
});
