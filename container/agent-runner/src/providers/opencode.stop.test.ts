import { expect, it } from 'bun:test';
import { settleOpenCodeAbort } from './opencode.js';

it('waits for OpenCode session abort without killing the continuation runtime', async () => {
  let release!: (result: {}) => void;
  let settled = false;
  let killed = false;
  const stop = settleOpenCodeAbort(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    async () => {
      killed = true;
    },
  ).then(() => {
    settled = true;
  });
  await Bun.sleep(5);
  expect(settled).toBe(false);
  release({});
  await stop;
  expect(settled).toBe(true);
  expect(killed).toBe(false);
});

it('bounds a hung session abort and awaits the process fallback before settlement', async () => {
  let signal: AbortSignal | undefined;
  let killed = false;
  let releaseKill!: () => void;
  let settled = false;
  const stop = settleOpenCodeAbort(
    (value) => {
      signal = value;
      return new Promise(() => {});
    },
    () => {
      killed = true;
      return new Promise((resolve) => {
        releaseKill = resolve;
      });
    },
    10,
  ).then(() => {
    settled = true;
  });
  await Bun.sleep(30);
  expect(signal!.aborted).toBe(true);
  expect(killed).toBe(true);
  expect(settled).toBe(false);
  releaseKill();
  await stop;
  expect(settled).toBe(true);
});

it('falls back when an older OpenCode server does not support session abort', async () => {
  let killed = 0;
  await settleOpenCodeAbort(
    async () => ({ error: { status: 404 } }),
    async () => {
      killed++;
    },
  );
  expect(killed).toBe(1);
});
