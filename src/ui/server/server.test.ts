import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../webhook-server.js', async (original) => ({
  ...(await original<typeof import('../../webhook-server.js')>()),
  ensureSharedHttpServer: vi.fn(),
  mountHandler: vi.fn(),
  mountUpgradeHandler: vi.fn(),
}));
import { startUi, stopUi } from './server.js';

afterEach(async () => {
  await stopUi();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('owns one configuration watcher in the enabled UI lifecycle, not per socket', async () => {
  const watch = vi.spyOn(fs, 'watch');
  vi.stubEnv('UI_ENABLED', 'false');
  startUi();
  expect(watch).not.toHaveBeenCalled();
  vi.stubEnv('UI_ENABLED', 'true');
  startUi();
  startUi();
  expect(watch).toHaveBeenCalledOnce();
  const close = vi.spyOn(watch.mock.results[0].value, 'close');
  await stopUi();
  expect(close).toHaveBeenCalledOnce();
});
