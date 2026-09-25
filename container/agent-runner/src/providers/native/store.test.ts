import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';

import { NativeStore } from './store.js';

let root: string;
let store: NativeStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.native-store-'));
  store = new NativeStore(path.join(root, 'state.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NativeStore', () => {
  it('atomically persists steering and recovers deduplication after reopening, including forks', () => {
    const conversation = store.createConversation();
    const before = store.append(conversation, [{ role: 'user', content: 'original' }]);
    const applied = store.appendSteering(conversation, 'guidance', { role: 'user', content: 'new direction' })!;
    store.close();
    store = new NativeStore(path.join(root, 'state.db'));
    expect(store.appliedSteering(conversation, ['guidance', 'unapplied'])).toEqual(['guidance']);
    expect(store.appendSteering(conversation, 'guidance', { role: 'user', content: 'duplicate' })).toBeNull();
    const early = store.fork(conversation, before)!;
    const late = store.fork(conversation, applied)!;
    expect(store.appliedSteering(early, ['guidance'])).toEqual([]);
    expect(store.appliedSteering(late, ['guidance'])).toEqual(['guidance']);
    expect(store.messages(late)).toEqual(store.messages(conversation));
    expect(JSON.stringify(store.messages(conversation))).not.toContain('duplicate');
  });

  it('persists complete model messages and forks at an exact checkpoint', () => {
    const conversation = store.createConversation();
    const first = store.append(conversation, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
    ] as ModelMessage[]);
    store.append(conversation, [
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'answer two' },
    ] as ModelMessage[]);

    const fork = store.fork(conversation, first);

    expect(fork).not.toBeNull();
    expect(store.messages(fork!)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
    ]);
    expect(store.messages(conversation)).toHaveLength(4);
  });

  it('rejects checkpoints outside the parent conversation', () => {
    const first = store.createConversation();
    const second = store.createConversation();
    const foreign = store.append(second, [{ role: 'user', content: 'foreign' }]);
    expect(store.fork(first, foreign)).toBeNull();
  });

  it('removes acknowledgements when the corresponding input is rolled back', () => {
    const conversation = store.createConversation();
    const anchor = store.append(conversation, [{ role: 'user', content: 'original' }]);
    store.appendSteering(conversation, 'rolled-back', { role: 'user', content: 'guidance' });
    store.replaceAfter(conversation, anchor, [{ role: 'assistant', content: 'replacement' }]);
    expect(store.appliedSteering(conversation, ['rolled-back'])).toEqual([]);
  });
});
