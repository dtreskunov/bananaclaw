import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from './routes.js';

const build = vi.hoisted(() => ({ version: 'before-build' }));
vi.mock('./asset-version.js', () => ({ chatAssetVersion: () => build.version }));

let server: http.Server;
let origin: string;
beforeEach(async () => {
  build.version = 'before-build';
  server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('chat asset cache busting', () => {
  it('updates every shell asset URL after a UI rebuild in the same host process', async () => {
    const first = await fetch(`${origin}/ui/chat/`);
    const html = await first.text();
    expect(first.headers.get('cache-control')).toContain('no-store');
    for (const name of ['appearance.js', 'app.js', 'app.css']) expect(html).toContain(`dist/${name}?v=before-build`);
    build.version = 'after-build';
    const refreshed = await (await fetch(`${origin}/ui/chat/`)).text();
    for (const name of ['appearance.js', 'app.js', 'app.css'])
      expect(refreshed).toContain(`dist/${name}?v=after-build`);
    expect(refreshed).not.toContain('v=before-build');
  });

  it('uses the same current stamp for the service-worker cache and shell', async () => {
    const oldWorker = await (await fetch(`${origin}/ui/chat/sw.js`)).text();
    expect(oldWorker).toContain("const CACHE_VERSION = 'before-build'");
    build.version = 'after-build';
    const worker = await fetch(`${origin}/ui/chat/sw.js`);
    expect(worker.headers.get('cache-control')).toContain('no-store');
    expect(await worker.text()).toContain("const CACHE_VERSION = 'after-build'");
    expect(await (await fetch(`${origin}/ui/chat/`)).text()).toContain('v=after-build');
  });
});
