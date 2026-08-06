import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type RenotifyPolicy = (deliveryOrigin: string | null, hasExistingNotification: boolean) => boolean;

function loadRenotifyPolicy(): RenotifyPolicy {
  const source = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const sandbox: {
    self: { addEventListener: () => void };
    policy?: RenotifyPolicy;
  } = {
    self: { addEventListener: () => {} },
  };
  vm.runInNewContext(`${source}\n;globalThis.policy = shouldRenotify;`, sandbox);
  if (!sandbox.policy) throw new Error('service worker policy was not loaded');
  return sandbox.policy;
}

describe('service worker notification cadence', () => {
  const shouldRenotify = loadRenotifyPolicy();

  it('alerts for the first mid-turn update', () => {
    expect(shouldRenotify('send_message', false)).toBe(true);
  });

  it('silently replaces repeated mid-turn updates', () => {
    expect(shouldRenotify('send_message', true)).toBe(false);
  });

  it('re-alerts for final and legacy responses', () => {
    expect(shouldRenotify('response', true)).toBe(true);
    expect(shouldRenotify(null, true)).toBe(true);
  });
});
