import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';

import { NativeStore } from './store.js';

let root: string;
let store: NativeStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-store-'));
  store = new NativeStore(path.join(root, 'state.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NativeStore', () => {
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
});
