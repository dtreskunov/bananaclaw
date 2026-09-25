import { describe, expect, it } from 'bun:test';
import { jsonSchema, tool, type ToolExecutionOptions } from 'ai';
import { NativeStore } from './store.js';
import { INTERRUPTED_TOOL, NativeTurnJournal } from './turn-journal.js';

const options = (toolCallId: string): ToolExecutionOptions => ({ toolCallId, messages: [] });

describe('incremental native turn journal', () => {
  it('persists completed actions and unknown in-flight results as valid pairs without replay duplicates', async () => {
    const store = new NativeStore(':memory:');
    const conversation = store.createConversation();
    const controller = new AbortController();
    const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'cancelled input' });
    let executed = 0;
    let release!: (value: string) => void;
    const tools = journal.wrap(
      {
        write: tool({
          inputSchema: jsonSchema({ type: 'object' }),
          execute: async () => {
            executed++;
            return 'file written';
          },
        }),
        remote: tool({
          inputSchema: jsonSchema({ type: 'object' }),
          execute: async () => {
            executed++;
            return new Promise<string>((resolve) => {
              release = resolve;
            });
          },
        }),
      },
      controller.signal,
    );
    try {
      await tools.write.execute!({}, options('completed'));
      const pending = tools.remote.execute!({}, options('unknown'));
      expect(JSON.stringify(store.messages(conversation))).toContain(INTERRUPTED_TOOL);
      controller.abort();
      expect(() => tools.write.execute!({}, options('must-not-run'))).toThrow();
      release('remote action completed before cancellation settled');
      await pending;
      await journal.settle();
      journal.save(true);
      journal.save(true);
      const history = store.messages(conversation);
      expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
      expect(JSON.stringify(history)).toContain('file written');
      expect(JSON.stringify(history)).toContain('remote action completed');
      expect(JSON.stringify(history)).not.toContain(INTERRUPTED_TOOL);
      expect(executed).toBe(2);
      expect(history.at(-1)?.content).toContain('cancelled, not pending');
      const next = new NativeTurnJournal(store, conversation, { role: 'user', content: 'next request' });
      next.finish([{ role: 'assistant', content: 'next response' }]);
      expect(JSON.stringify(store.messages(conversation)).match(/file written/g)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('does not label an aborted external action as failed without side effects', async () => {
    const store = new NativeStore(':memory:');
    const conversation = store.createConversation();
    const controller = new AbortController();
    const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'run external action' });
    const tools = journal.wrap(
      {
        remote: tool({
          inputSchema: jsonSchema({ type: 'object' }),
          execute: async (_input, options) =>
            new Promise((_, reject) => {
              options.abortSignal!.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
            }),
        }),
      },
      controller.signal,
    );
    try {
      const execution = tools.remote.execute!({}, options('external'));
      controller.abort();
      await expect(execution).rejects.toThrow('AbortError');
      await journal.settle();
      journal.save(true);
      expect(JSON.stringify(store.messages(conversation))).toContain(INTERRUPTED_TOOL);
      const fork = store.fork(conversation, journal.checkpoint);
      expect(fork).not.toBeNull();
      expect(store.messages(fork!)).toEqual(store.messages(conversation));
      expect(journal.activity()).toEqual([
        { kind: 'tool', id: 'external', tool: 'remote', status: 'interrupted', error: INTERRUPTED_TOOL },
      ]);
    } finally {
      store.close();
    }
  });
});
