import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeBudgetExceeded, NativeStore } from './store.js';

let root: string;
let store: NativeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-budget-'));
  store = new NativeStore(path.join(root, 'state.db'));
});
afterEach(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
const usage = {
  cost_usd: 0, model: 'test', input_tokens: 100, cache_read_tokens: 50, cache_write_tokens: 10,
  output_tokens: 20, reasoning_tokens: 10, context_tokens: 180, duration_api_ms: 123,
};

it('reserves before a request, replaces estimates with actual usage and survives reopening', () => {
  const conversation = store.createConversation();
  const call = store.reserveCall(conversation, 'input', 'work', 1000, 2000);
  expect(store.budget(conversation, 'input')).toEqual({ calls: 1, tokens: 3000 });
  store.finishCall(call.id, usage);
  expect(store.budget(conversation, 'input')).toEqual({ calls: 1, tokens: 180 });
  expect(store.lastContext(conversation)).toBe(180);
  const summary = store.reserveCall(conversation, 'input', 'summary', 1000, 1000);
  store.finishCall(summary.id, { ...usage, context_tokens: undefined });
  expect(store.lastContext(conversation)).toBe(180);
  store.close();
  store = new NativeStore(path.join(root, 'state.db'));
  expect(store.budget(conversation, 'input')).toEqual({ calls: 2, tokens: 360 });
  expect(store.budget(conversation, 'explicit continuation')).toEqual({ calls: 0, tokens: 0 });
  expect(store.budget(store.createConversation(), 'input')).toEqual({ calls: 0, tokens: 0 });
});

it('counts unfinished reservations against both hard ceilings after a crash', () => {
  const conversation = store.createConversation();
  for (let i = 0; i < 20; i++) store.reserveCall(conversation, 'calls', 'work', 1, 1);
  expect(() => store.reserveCall(conversation, 'calls', 'handoff', 1, 1)).toThrow(NativeBudgetExceeded);
  store.reserveCall(conversation, 'tokens', 'work', 1_999_999, 1);
  store.close();
  store = new NativeStore(path.join(root, 'state.db'));
  expect(() => store.reserveCall(conversation, 'calls', 'work', 1, 1)).toThrow('20 model requests');
  expect(() => store.reserveCall(conversation, 'tokens', 'work', 1, 1)).toThrow('2000000');
});

it('caps output to remaining capacity and stops if actual usage exceeds a reservation', () => {
  const conversation = store.createConversation();
  const call = store.reserveCall(conversation, 'input', 'work', 1_999_990, 1000);
  expect(call.maxOutputTokens).toBe(10);
  store.finishCall(call.id, { ...usage, input_tokens: 2_000_000 });
  expect(() => store.reserveCall(conversation, 'input', 'work', 1, 1)).toThrow(NativeBudgetExceeded);
  for (const [input, output] of [[-1, 1], [1, 0], [1, Infinity], [NaN, 1]])
    expect(() => store.reserveCall(conversation, 'invalid', 'work', input, output)).toThrow('Invalid');
});
