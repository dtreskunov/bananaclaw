import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  compactNativeContext, COMPACTION_INSTRUCTIONS, createCompactionPolicy, isContextOverflow, planCompaction, shouldCompactContext,
  MAX_COMPACTION_LEAVES, MAX_COMPACTION_REQUESTS,
} from './compaction.js';
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

function compactionOptions(conversation: string, protectedRef: string, attempt = 1) {
  return {
    store,
    conversation,
    protectedInputs: new Set([protectedRef]),
    attempt,
    signal: new AbortController().signal,
  };
}

it('preserves current input and complete tool pairs while persisting a non-destructive summary', async () => {
  const { conversation, protectedRef } = seed();
  const original = store.messages(conversation);
  const plan = planCompaction(store.contextEntries(conversation), new Set([protectedRef]), 1);
  expect(plan.retainedRefs).toEqual([protectedRef]);
  let prompts = '';
  await compactNativeContext({
    ...compactionOptions(conversation, protectedRef, 2),
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
    ...compactionOptions(conversation, protectedRef),
    summarize: async (prompt) => {
      promptText += prompt;
      return 'Earlier requirements and diagram were considered.';
    },
  });
  expect(promptText).not.toContain('PRIVATE_MEDIA_BYTES');
  expect(JSON.stringify(store.messages(conversation))).toContain('PRIVATE_MEDIA_BYTES');
});

it('does not persist failed or empty compaction', async () => {
  const { conversation, protectedRef } = seed();
  const before = store.contextMessages(conversation);
  for (const [summarize, expected] of [
    [async () => { throw new Error('Summary service unavailable'); }, 'Summary service unavailable'],
    [async () => '', 'empty summary'],
  ] as const) {
    await expect(compactNativeContext({
      ...compactionOptions(conversation, protectedRef), summarize,
    })).rejects.toThrow(expected);
    expect(store.contextMessages(conversation)).toEqual(before);
  }
});

it.each([
  ['oversized', 'x'.repeat(17_000), 'oversized summary'],
  ['non-reducing', 'x'.repeat(1000), 'did not reduce context'],
])('rejects a %s summary without changing the prompt projection', async (_name, summary, expected) => {
  const { conversation, protectedRef } = seed();
  if (_name === 'non-reducing') {
    for (const entry of store.contextEntries(conversation).slice(0, 2)) {
      store.updateMessage(conversation, entry.ref!, { role: 'user', content: 'Done.' });
    }
  }
  const before = store.contextMessages(conversation);
  await expect(
    compactNativeContext({
      ...compactionOptions(conversation, protectedRef),
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
      ...compactionOptions(conversation, protectedRef),
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
  const options = { ...compactionOptions(conversation, protectedRef), summarize };
  await expect(
    compactNativeContext({
      ...options,
      contextWindow: 512,
    }),
  ).rejects.toThrow('request budget is too small');
  const controller = new AbortController();
  controller.abort(new Error('Compaction cancelled'));
  await expect(compactNativeContext({ ...options, signal: controller.signal })).rejects.toThrow('Compaction cancelled');
  expect(calls).toBe(0);
  expect(store.contextMessages(conversation)).toEqual(before);
});

it('invalidates a summary when history is rolled back before its boundary', async () => {
  const { conversation, protectedRef } = seed();
  await compactNativeContext({
    ...compactionOptions(conversation, protectedRef, 2),
    summarize: async () => 'Completed prior work.',
  });
  const first = store.contextEntries(conversation).find((entry) => entry.ref !== null)!.ref!;
  store.replaceAfter(conversation, first, []);
  expect(store.contextEntries(conversation).every((entry) => entry.ref !== null)).toBe(true);
});

it.each([
  [749_999, 1_000_000, false],
  [750_000, 1_000_000, true],
  [800_000, 1_000_000, true],
  [undefined, 1_000_000, false],
  [750_000, undefined, false],
  [750_000, 0, false],
  [Number.NaN, 1_000_000, false],
  [750_000, Number.POSITIVE_INFINITY, false],
  [-1, 1_000_000, false],
])('checks measured utilization (%s / %s)', (tokens, window, expected) => {
  expect(shouldCompactContext(tokens, window)).toBe(expected);
});

describe('per-turn compaction policy', () => {
  it('derives unique ordinals from separate proactive and emergency attempts', () => {
    const policy = createCompactionPolicy(1_000_000);
    expect(policy.proactive()).toBeUndefined();
    expect(policy.recover('media')).toMatchObject({ ordinal: 1, attempt: 1 });
    policy.observe(750_000);
    expect(policy.proactive()).toMatchObject({ ordinal: 2, attempt: 1, detail: expect.stringContaining('75%') });
    policy.observe(undefined);
    expect(policy.proactive()).toBeUndefined();
    expect(policy.canRecover()).toBe(true);
    expect(policy.recover('context')).toMatchObject({ ordinal: 3, attempt: 2 });
    expect(policy.canRecover()).toBe(false);
    expect(() => policy.recover('context')).toThrow('context recovery exhausted');
    policy.observe(800_000);
    expect(policy.proactive()).toMatchObject({ ordinal: 4, attempt: 1 });
    expect(policy.proactive()).toBe('limit');
    expect(policy.proactive()).toBeUndefined();
  });

  it('disables proactive failures without disabling emergency recovery', () => {
    const policy = createCompactionPolicy(1_000_000);
    policy.observe(750_000);
    expect(policy.proactive()).toBeDefined();
    policy.disableProactive();
    policy.observe(800_000);
    expect(policy.proactive()).toBeUndefined();
    expect(policy.recover('context')).toMatchObject({ attempt: 1, ordinal: 2 });
    expect(policy.recover('media')).toMatchObject({ attempt: 2, ordinal: 3 });
    expect(() => policy.recover('media')).toThrow('media budget recovery exhausted');
  });

  it('does not spend proactive attempts on unknown or below-threshold measurements', () => {
    const unknown = createCompactionPolicy(undefined);
    unknown.observe(900_000);
    expect(unknown.proactive()).toBeUndefined();
    expect(unknown.recover('context')).toMatchObject({ ordinal: 1, attempt: 1 });
    const policy = createCompactionPolicy(1_000_000);
    for (const tokens of [749_999, undefined, Number.NaN]) {
      policy.observe(tokens);
      expect(policy.proactive()).toBeUndefined();
    }
    policy.observe(750_000);
    expect(policy.proactive()).toMatchObject({ ordinal: 1, attempt: 1 });
  });
});

it('compacts a synthetic two-million-character transcript with oversized tool results within bounded requests', async () => {
  const conversation = store.createConversation();
  store.append(conversation, [
    { role: 'user', content: 'Requirements '.repeat(103_000) },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-one', toolName: 'read', input: { path: 'one.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-one', toolName: 'read',
      output: { type: 'text', value: 'a'.repeat(309_000) } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read-two', toolName: 'read', input: { path: 'two.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-two', toolName: 'read',
      output: { type: 'text', value: 'b'.repeat(309_000) } }] },
  ]);
  const protectedRef = store.append(conversation, [{ role: 'user', content: 'Current request' }]);
  store.append(conversation, [
    { role: 'assistant', content: 'Recent completed work' },
    { role: 'user', content: 'Recent guidance' },
    { role: 'assistant', content: 'Continue now' },
  ]);
  const original = store.messages(conversation);
  const prompts: string[] = [];
  let active = 0;
  let maxActive = 0;
  const result = await compactNativeContext({
    ...compactionOptions(conversation, protectedRef), contextWindow: 1_000_000,
    summarize: async (prompt, request) => {
      prompts.push(prompt);
      expect(Buffer.byteLength(prompt) + Buffer.byteLength(COMPACTION_INSTRUCTIONS) + request.maxOutputTokens)
        .toBeLessThanOrEqual(128_000);
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(1);
      active--;
      return 'Completed file reads. Preserve current requirements and continue remaining work.';
    },
  });
  expect(result.sourceBytes).toBeGreaterThan(1_950_000);
  expect(result.leafChunks).toBeLessThanOrEqual(MAX_COMPACTION_LEAVES);
  expect(result.requests).toBeLessThanOrEqual(MAX_COMPACTION_REQUESTS);
  expect(result.requests).toBe(prompts.length);
  expect(maxActive).toBe(2);
  expect(prompts.some((prompt) => prompt.includes('read/read-one') && prompt.includes('fragment'))).toBe(true);
  expect(prompts.at(-1)).toContain('Chronological summary 1/');
  expect(store.messages(conversation)).toEqual(original);
  expect(JSON.stringify(store.contextMessages(conversation))).toContain('Current request');
  expect(JSON.stringify(store.contextMessages(conversation))).not.toContain('a'.repeat(309_000));
});

function largeHistory(characters: number) {
  const { conversation, protectedRef } = seed();
  store.updateMessage(conversation, store.contextEntries(conversation)[0].ref!, { role: 'user', content: 'x'.repeat(characters) });
  return { ...compactionOptions(conversation, protectedRef), contextWindow: 1_000_000 };
}

it('reserves reasoning and retry output without enlarging the visible summary target', async () => {
  const options = largeHistory(60_000);
  const budgets: number[] = [];
  const logs = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await compactNativeContext({
      ...options, reasoning: true, maxOutputTokens: 512_000,
      summarize: async (prompt, request) => {
        budgets.push(request.maxOutputTokens);
        expect(prompt).toContain('8000 tokens and 32000 UTF-8 bytes');
        expect(Buffer.byteLength(prompt) + Buffer.byteLength(COMPACTION_INSTRUCTIONS) + request.maxOutputTokens)
          .toBeLessThanOrEqual(128_000);
        return budgets.length === 1
          ? { text: '', finishReason: 'length', outputTokens: 16_000, reasoningTokens: 16_000 }
          : { text: 'Previous work completed; continue unfinished tasks.', finishReason: 'stop', outputTokens: 100, reasoningTokens: 40 };
      },
    });
    expect(budgets).toEqual([16_000, 24_000]);
    expect(result.requests).toBe(2);
    expect(logs.mock.calls.some(([line]) => String(line).includes('finish=length') &&
      String(line).includes('summary_bytes=0/32000'))).toBe(true);
    expect(store.contextEntries(options.conversation).some((entry) => entry.ref === null)).toBe(true);
  } finally { logs.mockRestore(); }
});

it.each([
  ['persistent reasoning-only response', '', 24_000, 24_000, 'empty summary'],
  ['oversized bytes', 'x'.repeat(33_000), 100, 40, 'oversized summary'],
  ['oversized visible tokens', 'Short-looking text', 10_000, 1000, 'oversized summary'],
])('preserves history after %s on the one permitted retry', async (_name, text, outputTokens, reasoningTokens, error) => {
  const options = largeHistory(60_000);
  const before = store.contextMessages(options.conversation);
  let calls = 0;
  await expect(compactNativeContext({
    ...options, reasoning: true, maxOutputTokens: 512_000,
    summarize: async () => ++calls === 1
      ? { text: '', finishReason: 'length', outputTokens: 16_000, reasoningTokens: 16_000 }
      : { text, finishReason: text ? 'stop' : 'length', outputTokens, reasoningTokens },
  })).rejects.toThrow(error);
  expect(calls).toBe(2);
  expect(store.contextMessages(options.conversation)).toEqual(before);
});

it.each([
  ['non-truncated response', 'stop', 100, 512_000],
  ['no reported reasoning', 'length', undefined, 512_000],
  ['model generation cap reached', 'length', 9000, 9000],
])('does not retry an empty summary with %s', async (_name, finishReason, reasoningTokens, maxOutputTokens) => {
  const options = largeHistory(60_000);
  let calls = 0;
  await expect(compactNativeContext({
    ...options, reasoning: true, maxOutputTokens,
    summarize: async () => {
      calls++;
      return { text: '', finishReason, outputTokens: reasoningTokens, reasoningTokens };
    },
  })).rejects.toThrow('empty summary');
  expect(calls).toBe(1);
  expect(store.contextEntries(options.conversation).every((entry) => entry.ref !== null)).toBe(true);
});

it('does not retry reasoning-only output after cancellation', async () => {
  const options = largeHistory(60_000);
  const controller = new AbortController();
  let calls = 0;
  await expect(compactNativeContext({
    ...options, reasoning: true, maxOutputTokens: 512_000, signal: controller.signal,
    summarize: async () => {
      calls++;
      controller.abort(new Error('Compaction stopped'));
      return { text: '', finishReason: 'length', outputTokens: 16_000, reasoningTokens: 16_000 };
    },
  })).rejects.toThrow('Compaction stopped');
  expect(calls).toBe(1);
});

it('keeps reasoning-aware leaf requests and their retries within the shared request budget', async () => {
  const options = largeHistory(1_950_000);
  const seen = new Set<string>();
  const result = await compactNativeContext({
    ...options, reasoning: true, maxOutputTokens: 512_000,
    summarize: async (prompt, request) => {
      expect(Buffer.byteLength(prompt) + Buffer.byteLength(COMPACTION_INSTRUCTIONS) + request.maxOutputTokens)
        .toBeLessThanOrEqual(128_000);
      if (!seen.has(prompt)) {
        seen.add(prompt);
        return { text: '', finishReason: 'length', outputTokens: request.maxOutputTokens, reasoningTokens: request.maxOutputTokens };
      }
      return { text: 'Earlier actions completed; preserve current requirements.', finishReason: 'stop', outputTokens: 60, reasoningTokens: 20 };
    },
  });
  expect(result.requests).toBe(seen.size * 2);
  expect(result.requests).toBeLessThanOrEqual(MAX_COMPACTION_REQUESTS);
  expect(result.leafChunks).toBeLessThanOrEqual(MAX_COMPACTION_LEAVES);
});

it('summarizes a fitting single chunk once with the final output budget', async () => {
  const options = largeHistory(2000);
  const original = store.messages(options.conversation);
  let calls = 0;
  const result = await compactNativeContext({
    ...options, maxOutputTokens: 4096,
    summarize: async (prompt, request) => {
      calls++;
      expect(request.maxOutputTokens).toBe(4096);
      expect(prompt).toContain('conversation history');
      expect(prompt).toContain('[Exchange 1;');
      expect(prompt).not.toContain('[Chronological summary');
      return 'Completed earlier work; continue the current pending request.';
    },
  });
  expect(result.leafChunks).toBe(1);
  expect(result.requests).toBe(1);
  expect(calls).toBe(1);
  expect(store.messages(options.conversation)).toEqual(original);
  expect(JSON.stringify(store.contextMessages(options.conversation))).toContain('Current pending request');
});

it('retains the two-stage path when a single leaf does not fit final-request capacity', async () => {
  const options = largeHistory(120_000);
  const budgets: number[] = [];
  const result = await compactNativeContext({
    ...options, summarize: async (_prompt, request) => {
      budgets.push(request.maxOutputTokens);
      return 'Completed earlier work; continue pending requests.';
    },
  });
  expect(result.leafChunks).toBe(1);
  expect(result.requests).toBe(2);
  expect(budgets).toEqual([2048, 8000]);
});

it('packs dense UTF-8 exchanges without repeatedly measuring accumulated chunk prefixes', async () => {
  const conversation = store.createConversation();
  store.append(conversation, Array.from({ length: 500 }, (_, index) =>
    ({ role: 'user' as const, content: `Requirement ${index}: \u{1f642}\u{1f642}` })));
  const protectedRef = store.append(conversation, [{ role: 'user', content: 'Current request' }]);
  store.append(conversation, [{ role: 'assistant', content: 'Recent work' }]);
  const measure = spyOn(Buffer, 'byteLength');
  try {
    const result = await compactNativeContext({
      ...compactionOptions(conversation, protectedRef), contextWindow: 1_000_000,
      summarize: async () => 'Earlier requirements preserved in chronological order.',
    });
    const chunkScans = measure.mock.calls.filter(([text]) => typeof text === 'string' &&
      text.startsWith('[Exchange ') && text.includes('\n\n[Exchange '));
    expect(chunkScans).toHaveLength(2);
    expect(result.requests).toBe(1);
  } finally { measure.mockRestore(); }
});

it('splits context-rejected summarization requests without losing chronological fragment labels', async () => {
  const options = largeHistory(60_000);
  const original = store.messages(options.conversation);
  let rejections = 0;
  const result = await compactNativeContext({
    ...options,
    summarize: async (prompt) => {
      if (Buffer.byteLength(prompt) > 30_000) {
        rejections++;
        throw new Error('context_length_exceeded');
      }
      return 'Earlier work completed; preserve requirements and unknown side effects.';
    },
  });
  expect(rejections).toBeGreaterThan(0);
  expect(result.leafChunks).toBeGreaterThan(1);
  expect(result.requests).toBeLessThanOrEqual(MAX_COMPACTION_REQUESTS);
  expect(store.messages(options.conversation)).toEqual(original);
});

it('rejects work above the leaf limit before making any model calls', async () => {
  const options = largeHistory(4_500_000);
  let calls = 0;
  await expect(compactNativeContext({
    ...options, summarize: async () => { calls++; return 'Earlier work.'; },
  })).rejects.toThrow('leaf chunks');
  expect(calls).toBe(0);
  expect(store.contextEntries(options.conversation).every((entry) => entry.ref !== null)).toBe(true);
});

it.each([false, true])('bounds all splitting and reduction requests with reasoning=%s', async (reasoning) => {
  const options = largeHistory(reasoning ? 1_650_000 : 1_950_000);
  let calls = 0;
  await expect(compactNativeContext({
    ...options, reasoning, maxOutputTokens: 512_000,
    summarize: async (prompt) => {
      calls++;
      if (prompt.includes('Exchange ') && !prompt.includes('Rejected request fragment'))
        throw new Error('context_length_exceeded');
      return 'Completed work; continue pending requests.';
    },
  })).rejects.toThrow('64-request budget');
  expect(calls).toBe(MAX_COMPACTION_REQUESTS);
  expect(store.contextEntries(options.conversation).every((entry) => entry.ref !== null)).toBe(true);
});

it('cancels and settles the sibling request when a parallel leaf fails', async () => {
  const options = largeHistory(240_000);
  let calls = 0;
  let cancelled = false;
  await expect(compactNativeContext({
    ...options,
    summarize: async (_prompt, request) => {
      if (++calls === 1) {
        await Bun.sleep(1);
        throw new Error('Leaf failed');
      }
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => {
        cancelled = true;
        resolve();
      }, { once: true }));
      request.signal.throwIfAborted();
      return 'Never activated';
    },
  })).rejects.toThrow('Leaf failed');
  expect(calls).toBe(2);
  expect(cancelled).toBe(true);
  expect(store.contextEntries(options.conversation).every((entry) => entry.ref !== null)).toBe(true);
});

it('does not activate a summary returned after cancellation', async () => {
  const options = largeHistory(60_000);
  const controller = new AbortController();
  await expect(compactNativeContext({
    ...options, signal: controller.signal,
    summarize: async () => {
      controller.abort(new Error('Compaction cancelled'));
      return 'A late summary';
    },
  })).rejects.toThrow('Compaction cancelled');
  expect(store.contextEntries(options.conversation).every((entry) => entry.ref !== null)).toBe(true);
});

it('reduces multiple levels of summaries within the same work budget', async () => {
  const options = largeHistory(3_700_000);
  let reductions = 0;
  const result = await compactNativeContext({
    ...options,
    summarize: async (prompt) => {
      if (prompt.includes('[Chronological summary')) reductions++;
      return 'Completed work. '.repeat(400);
    },
  });
  expect(reductions).toBeGreaterThan(1);
  expect(result.requests).toBeGreaterThan(result.leafChunks + 1);
  expect(result.requests).toBeLessThanOrEqual(MAX_COMPACTION_REQUESTS);
});

it('preserves UTF-8 characters across oversized exchange fragments', async () => {
  const options = largeHistory(0);
  store.updateMessage(options.conversation, store.contextEntries(options.conversation)[0].ref!, {
    role: 'user', content: '\u{1f642}'.repeat(60_000),
  });
  const prompts: string[] = [];
  await compactNativeContext({
    ...options, summarize: async (prompt) => {
      prompts.push(prompt);
      return 'Earlier requirements preserved.';
    },
  });
  expect(prompts.every((prompt) => !prompt.includes('\ufffd'))).toBe(true);
  expect(prompts.some((prompt) => prompt.includes('\u{1f642}'))).toBe(true);
});

it('reduces leaf results in chronological order rather than completion order', async () => {
  const options = largeHistory(240_000);
  let leaf = 0;
  let reduction = '';
  await compactNativeContext({
    ...options,
    summarize: async (prompt) => {
      if (prompt.includes('[Chronological summary')) {
        reduction = prompt;
        return 'First work then second work.';
      }
      const order = ++leaf;
      if (order === 1) await Bun.sleep(5);
      return `Completed chunk ${order}.`;
    },
  });
  expect(reduction.indexOf('Completed chunk 1.')).toBeLessThan(reduction.indexOf('Completed chunk 2.'));
});

it('surfaces quota errors without splitting or retrying requests', async () => {
  const options = largeHistory(60_000);
  let calls = 0;
  await expect(compactNativeContext({
    ...options, summarize: async () => {
      calls++;
      throw new Error('Token Plan usage limit reached (2056)');
    },
  })).rejects.toThrow('Token Plan usage limit');
  expect(calls).toBe(1);
  expect(store.contextEntries(options.conversation).every((entry) => entry.ref !== null)).toBe(true);
});
