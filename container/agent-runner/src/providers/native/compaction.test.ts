import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { compactNativeContext, isContextOverflow, planCompaction } from './compaction.js';
import { NativeStore } from './store.js';

let root: string;
let store: NativeStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.native-compaction-'));
  store = new NativeStore(path.join(root, 'state.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('context overflow detection', () => {
  it.each([
    new Error('invalid params, context window exceeds limit (2013)'),
    { responseBody: '{"error":{"message":"context window exceeds limit (2013)"}}' },
    { cause: { error: { code: 'context_length_exceeded' } } },
    new Error('This model has a maximum context length of 8192 tokens'),
    { errors: [new Error('prompt is too long')] },
  ])('recognizes a context-specific API rejection', (error) => expect(isContextOverflow(error)).toBe(true));

  it.each([
    new Error('Unauthorized'),
    { status: 400, code: 2013 },
    new Error('429 rate limited'),
    new Error('Unsupported audio format'),
    { statusCode: 401, message: 'maximum context length' },
    { responseBody: '{"error":{"message":"Unauthorized"},"echo":"context window exceeds limit (2013)"}' },
  ])('does not compact unrelated errors', (error) => expect(isContextOverflow(error)).toBe(false));
});

function seed(): { conversation: string; protectedRef: string } {
  const conversation = store.createConversation();
  store.append(conversation, [
    { role: 'user', content: 'Earlier requirements '.repeat(200) },
    { role: 'assistant', content: 'Previously completed work '.repeat(100) },
  ]);
  const protectedRef = store.append(conversation, [{ role: 'user', content: 'Current pending request' }]);
  store.append(conversation, [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'write-1', toolName: 'write', input: { path: 'once.txt' } }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'write-1',
          toolName: 'write',
          output: { type: 'text', value: 'File was written' },
        },
      ],
    },
    { role: 'assistant', content: 'Continue with remaining work' },
  ]);
  return { conversation, protectedRef };
}

it('preserves current input and complete tool pairs while persisting a non-destructive summary', async () => {
  const { conversation, protectedRef } = seed();
  const original = store.messages(conversation);
  const plan = planCompaction(store.contextEntries(conversation), new Set([protectedRef]), 1);
  expect(plan.retainedRefs).toEqual([protectedRef]);
  let prompts = '';
  await compactNativeContext({
    store,
    conversation,
    protectedInputs: new Set([protectedRef]),
    attempt: 2,
    signal: new AbortController().signal,
    summarize: async (prompt) => {
      prompts += prompt;
      return 'Earlier work done; once.txt was written. Continue remaining work.';
    },
  });
  expect(prompts).toContain('write-1');
  expect(prompts).not.toContain('Current pending request');
  expect(store.messages(conversation)).toEqual(original);
  expect(JSON.stringify(store.contextMessages(conversation))).toContain('Current pending request');
  expect(JSON.stringify(store.contextMessages(conversation))).toContain('once.txt was written');
  store.close();
  store = new NativeStore(path.join(root, 'state.db'));
  expect(store.contextMessages(conversation)).toHaveLength(3);
  const checkpoint = store.append(conversation, [{ role: 'assistant', content: 'Final answer' }]);
  const fork = store.fork(conversation, checkpoint)!;
  expect(store.messages(fork)).toEqual(store.messages(conversation));
});

it('never cuts between an assistant tool call and its result', () => {
  const { conversation, protectedRef } = seed();
  const plan = planCompaction(store.contextEntries(conversation), new Set([protectedRef]), 2);
  const types = plan.prefix.map((entry) => entry.message.role);
  expect(types).toEqual(['user', 'assistant']);
  expect(
    store
      .contextEntries(conversation)
      .slice(-3)
      .map((entry) => entry.message.role),
  ).toEqual(['assistant', 'tool', 'assistant']);
});

it('omits inline media only from summarizer input, retaining the original transcript', async () => {
  const { conversation, protectedRef } = seed();
  store.updateMessage(conversation, store.contextEntries(conversation)[0].ref!, {
    role: 'user',
    content: [
      { type: 'text', text: 'Old diagram' },
      { type: 'image', image: 'data:image/png;base64,PRIVATE_MEDIA_BYTES' },
    ],
  });
  let promptText = '';
  await compactNativeContext({
    store,
    conversation,
    protectedInputs: new Set([protectedRef]),
    attempt: 1,
    signal: new AbortController().signal,
    summarize: async (prompt) => {
      promptText += prompt;
      return 'Earlier requirements and diagram were considered.';
    },
  });
  expect(promptText).not.toContain('PRIVATE_MEDIA_BYTES');
  expect(JSON.stringify(store.messages(conversation))).toContain('PRIVATE_MEDIA_BYTES');
});

it('does not persist failed or non-reducing compaction', async () => {
  const { conversation, protectedRef } = seed();
  const before = store.contextMessages(conversation);
  await expect(
    compactNativeContext({
      store,
      conversation,
      protectedInputs: new Set([protectedRef]),
      attempt: 1,
      signal: new AbortController().signal,
      summarize: async () => {
        throw new Error('Summary service unavailable');
      },
    }),
  ).rejects.toThrow('Summary service unavailable');
  expect(store.contextMessages(conversation)).toEqual(before);
  await expect(
    compactNativeContext({
      store,
      conversation,
      protectedInputs: new Set([protectedRef]),
      attempt: 1,
      signal: new AbortController().signal,
      summarize: async () => '',
    }),
  ).rejects.toThrow('empty or oversized');
  expect(store.contextMessages(conversation)).toEqual(before);
});

it.each([
  ['oversized', 'x'.repeat(17_000), 'empty or oversized'],
  ['non-reducing', 'x'.repeat(10_000), 'did not reduce context'],
])('rejects a %s summary without changing the prompt projection', async (_name, summary, expected) => {
  const { conversation, protectedRef } = seed();
  const before = store.contextMessages(conversation);
  await expect(
    compactNativeContext({
      store,
      conversation,
      protectedInputs: new Set([protectedRef]),
      attempt: 1,
      signal: new AbortController().signal,
      summarize: async () => summary,
    }),
  ).rejects.toThrow(expected);
  expect(store.contextMessages(conversation)).toEqual(before);
  expect(store.messages(conversation)).toEqual(before);
});

it('does not save a partial summary if a later fragment fails', async () => {
  const { conversation, protectedRef } = seed();
  const before = store.contextMessages(conversation);
  let calls = 0;
  await expect(
    compactNativeContext({
      store,
      conversation,
      protectedInputs: new Set([protectedRef]),
      attempt: 1,
      signal: new AbortController().signal,
      summarize: async () => {
        if (++calls === 2) throw new Error('Second fragment failed');
        return 'Earlier work is complete.';
      },
    }),
  ).rejects.toThrow('Second fragment failed');
  expect(calls).toBe(2);
  expect(store.contextMessages(conversation)).toEqual(before);
});

it('rejects excessive fragments and cancellation before calling the summarizer', async () => {
  const { conversation, protectedRef } = seed();
  const before = store.contextMessages(conversation);
  let calls = 0;
  const summarize = async () => {
    calls++;
    return 'Earlier work is complete.';
  };
  const options = { store, conversation, protectedInputs: new Set([protectedRef]), attempt: 1, summarize };
  await expect(
    compactNativeContext({
      ...options,
      contextWindow: 512,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('64-chunk recovery budget');
  const controller = new AbortController();
  controller.abort(new Error('Compaction cancelled'));
  await expect(compactNativeContext({ ...options, signal: controller.signal })).rejects.toThrow('Compaction cancelled');
  expect(calls).toBe(0);
  expect(store.contextMessages(conversation)).toEqual(before);
});

it('invalidates a summary when history is rolled back before its boundary', async () => {
  const { conversation, protectedRef } = seed();
  await compactNativeContext({
    store,
    conversation,
    protectedInputs: new Set([protectedRef]),
    attempt: 2,
    signal: new AbortController().signal,
    summarize: async () => 'Completed prior work.',
  });
  const first = store.contextEntries(conversation).find((entry) => entry.ref !== null)!.ref!;
  store.replaceAfter(conversation, first, []);
  expect(store.contextEntries(conversation).every((entry) => entry.ref !== null)).toBe(true);
});
