import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';

import { NativeStore } from './store.js';
import { applyMediaQuarantines, mediaKeys } from './media-recovery.js';

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
  it('marks only explicitly finished turns, persists them, and keeps fork/rollback boundaries exact', () => {
    const conversation = store.createConversation();
    const first = store.append(conversation, [{ role: 'user', content: 'first input' }]);
    const middle = store.append(conversation, [{ role: 'assistant', content: 'working notes' }]);
    const last = store.append(conversation, [{ role: 'assistant', content: 'final answer' }]);
    expect(store.contextEntries(conversation).some(entry => entry.finished)).toBe(false);
    store.finishTurn(conversation, first, last);
    store.append(conversation, [{ role: 'user', content: 'active input' }]);
    store.close();
    store = new NativeStore(path.join(root, 'state.db'));
    expect(store.contextEntries(conversation).map(entry => !!entry.finished)).toEqual([true, true, true, false]);
    const early = store.fork(conversation, middle)!;
    const late = store.fork(conversation, last)!;
    expect(store.contextEntries(early).some(entry => entry.finished)).toBe(false);
    expect(store.contextEntries(late).every(entry => entry.finished)).toBe(true);
    store.replaceAfter(conversation, middle, [{ role: 'assistant', content: 'replaced final answer' }]);
    expect(store.contextEntries(conversation).some(entry => entry.finished)).toBe(false);
    for (const [start, end] of [['no', last], [last, first], [first, '99999']])
      expect(() => store.finishTurn(conversation, start, end)).toThrow('Invalid finished-turn boundary');
    expect(() => store.finishTurn(early, first, last)).toThrow('Invalid finished-turn boundary');
  });

  it('persists model-scoped media quarantines without changing transcripts or leaking future confirmations into forks', () => {
    const conversation = store.createConversation();
    const media: ModelMessage = { role: 'user', content: [
      { type: 'file', mediaType: 'application/pdf', data: 'opaque original media' },
    ] };
    const source = store.append(conversation, [media]);
    const confirmed = store.append(conversation, [{ role: 'assistant', content: 'Accepted retry' }]);
    const key = mediaKeys([media])[0];
    const original = store.messages(conversation);
    store.quarantineMedia(conversation, 'model-A', key, confirmed, 'Original parameter rejection');
    store.close();
    store = new NativeStore(path.join(root, 'state.db'));
    expect(store.messages(conversation)).toEqual(original);
    expect(store.mediaQuarantines(conversation, 'model-A').get(key)).toBe('Original parameter rejection');
    expect(store.mediaQuarantines(conversation, 'model-B').size).toBe(0);
    const early = store.fork(conversation, source)!;
    const late = store.fork(conversation, confirmed)!;
    expect(store.mediaQuarantines(early, 'model-A').size).toBe(0);
    expect(store.mediaQuarantines(late, 'model-A').get(key)).toBe('Original parameter rejection');
    store.saveCompaction(conversation, source, [source], 'Compacted earlier history');
    expect(mediaKeys(applyMediaQuarantines(
      store.contextMessages(conversation), store.mediaQuarantines(conversation, 'model-A'),
    ))).toEqual([]);
    store.replaceAfter(conversation, source, [{ role: 'assistant', content: 'Rolled back confirmation' }]);
    expect(store.mediaQuarantines(conversation, 'model-A').size).toBe(0);
  });

  it('rejects media quarantine confirmations outside the conversation', () => {
    const conversation = store.createConversation();
    const foreign = store.append(store.createConversation(), [{ role: 'user', content: 'foreign' }]);
    expect(() => store.quarantineMedia(conversation, 'model-A', 'key', foreign, 'Rejected')).toThrow(
      'Invalid media quarantine checkpoint',
    );
    expect(store.mediaQuarantines(conversation, 'model-A').size).toBe(0);
  });

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
