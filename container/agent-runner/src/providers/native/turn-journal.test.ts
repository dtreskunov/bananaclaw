import { describe, expect, it } from 'bun:test';
import { jsonSchema, tool, type ToolExecutionOptions } from 'ai';
import { NativeStore } from './store.js';
import { INTERRUPTED_TOOL, NativeTurnJournal } from './turn-journal.js';

const options = (toolCallId: string): ToolExecutionOptions => ({ toolCallId, messages: [] });

describe('incremental native turn journal', () => {
  it('cancels only one of two parallel calls, journals its result, and leaves the query usable', async () => {
    const store = new NativeStore(':memory:');
    const turnController = new AbortController();
    try {
      const conversation = store.createConversation();
      const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'Run parallel tools' });
      let release!: (value: string) => void;
      let siblingSignal: AbortSignal | undefined;
      const tools = journal.wrap({
        bash: tool({
          inputSchema: jsonSchema({ type: 'object' }),
          execute: async (_input, options) => {
            if (options.toolCallId === 'target')
              return new Promise<string>((_resolve, reject) => {
                options.abortSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
              });
            siblingSignal = options.abortSignal;
            return new Promise<string>((resolve) => { release = resolve; });
          },
        }),
      }, turnController.signal);
      const target = Promise.resolve(tools.bash.execute!({}, options('target'))).catch((error: unknown) => error);
      const sibling = tools.bash.execute!({}, options('sibling'));
      expect(journal.stopTool('missing')).toBe(false);
      expect(journal.stopTool('target')).toBe(true);
      expect(journal.stopTool('target')).toBe(true);
      expect(await target).toEqual(new Error(INTERRUPTED_TOOL));
      expect(turnController.signal.aborted).toBe(false);
      expect(siblingSignal!.aborted).toBe(false);
      expect(journal.stopTool('target')).toBe(false);
      release('Sibling completed');
      expect(await sibling).toBe('Sibling completed');
      await journal.settle();
      expect(journal.activity()).toEqual([
        { kind: 'tool', id: 'target', tool: 'bash', status: 'interrupted', error: INTERRUPTED_TOOL },
        { kind: 'tool', id: 'sibling', tool: 'bash', status: 'completed' },
      ]);
      const history = JSON.stringify(store.messages(conversation));
      expect(history).toContain(INTERRUPTED_TOOL);
      expect(history).toContain('Sibling completed');
      expect(history).not.toContain('The user stopped this turn');
    } finally { store.close(); }
  });
  it('cancels a just-announced call before execution, but refuses a call already completed', async () => {
    const store = new NativeStore(':memory:');
    try {
      const conversation = store.createConversation();
      const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'Do not start the stopped call' });
      let executions = 0;
      const tools = journal.wrap({
        read: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => { executions++; return 'done'; } }),
      }, new AbortController().signal);
      journal.announceTool('before-start');
      expect(journal.stopTool('before-start')).toBe(true);
      await expect(tools.read.execute!({}, options('before-start'))).rejects.toThrow(INTERRUPTED_TOOL);
      expect(executions).toBe(0);
      await tools.read.execute!({}, options('completed'));
      journal.announceTool('completed');
      expect(journal.stopTool('completed')).toBe(false);
      expect(executions).toBe(1);
    } finally { store.close(); }
  });

  it('persists async multimodal conversion once across incremental saves, stops and forks', async () => {
    const store = new NativeStore(':memory:');
    try {
      const conversation = store.createConversation();
      const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'inspect screenshot' });
      let conversions = 0;
      let executions = 0;
      const output = { path: '/tmp/screenshot.png', data: 'AQID' };
      const modelOutput = { type: 'content', value: [
        { type: 'text', text: output.path },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: output.data } },
      ] } as const;
      const tools = journal.wrap({
        view_image: tool({
          inputSchema: jsonSchema({ type: 'object' }),
          execute: async () => { executions++; return output; },
          toModelOutput: async () => {
            conversions++;
            await Promise.resolve();
            return { ...modelOutput, value: [...modelOutput.value] };
          },
        }),
      }, new AbortController().signal);
      expect(await tools.view_image.execute!({}, options('image'))).toEqual(output);
      expect(store.messages(conversation).at(-1)).toMatchObject({
        role: 'tool', content: [{ output: modelOutput }],
      });
      expect(await tools.view_image.toModelOutput!({ toolCallId: 'image', input: {}, output })).toEqual(modelOutput);
      await journal.settle();
      journal.save(true);
      const child = store.fork(conversation, journal.checkpoint)!;
      expect(store.messages(child)).toEqual(store.messages(conversation));
      expect(JSON.stringify(store.messages(child))).toContain('"type":"file"');
      expect(conversions).toBe(1);
      expect(executions).toBe(1);
    } finally { store.close(); }
  });

  it('retains builtin inputs and MCP error outcomes without changing model result history', async () => {
    const store = new NativeStore(':memory:');
    try {
      const conversation = store.createConversation();
      const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'Send report' });
      const output = { isError: true, content: [{ type: 'text', text: 'Not permitted' }] };
      const name = 'mcp__nanoclaw__send_email';
      const tools = journal.wrap({
        [name]: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => output }),
      }, new AbortController().signal);
      expect(await tools[name].execute!({ to: 'alice@example.test', subject: 'Report', body: 'private body' }, options('email'))).toEqual(output);
      expect(journal.activity()).toEqual([{
        kind: 'tool', id: 'email', tool: name, status: 'error',
        detail: 'alice@example.test', description: 'Subject: Report', error: 'Not permitted',
      }]);
      expect(store.messages(conversation).at(-1)).toMatchObject({
        role: 'tool',
        content: [{ type: 'tool-result', output: { type: 'text', value: JSON.stringify(output) } }],
      });
    } finally {
      store.close();
    }
  });

  it('keeps steering and earlier completed actions across later saves, stops and forks', async () => {
    const store = new NativeStore(':memory:');
    try {
      const conversation = store.createConversation();
      const journal = new NativeTurnJournal(store, conversation, { role: 'user', content: 'original' });
      const tools = journal.wrap({
        send: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'delivered' }),
      }, new AbortController().signal);
      await tools.send.execute!({}, options('sent'));
      const complete = store.messages(conversation).slice(1);
      journal.finishSegment(complete);
      expect(journal.applySteering('first', { role: 'user', content: 'change direction' })).toBe(true);
      expect(journal.applySteering('first', { role: 'user', content: 'duplicate' })).toBe(false);
      journal.appendText('new response');
      journal.save();
      journal.save(true);
      const history = store.messages(conversation);
      expect(JSON.stringify(history).match(/change direction/g)).toHaveLength(1);
      expect(JSON.stringify(history).match(/delivered/g)).toHaveLength(1);
      expect(journal.activity()).toEqual([{ kind: 'tool', id: 'sent', tool: 'send', status: 'completed' }]);
      const child = store.fork(conversation, journal.checkpoint)!;
      expect(store.appliedSteering(child, ['first'])).toEqual(['first']);
      expect(store.messages(child)).toEqual(history);
    } finally {
      store.close();
    }
  });

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
        'mcp__nanoclaw__send_email': tool({
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
      const execution = tools.mcp__nanoclaw__send_email.execute!(
        { to: 'alice@example.test', subject: 'Report', body: 'private body' }, options('external'),
      );
      controller.abort();
      await expect(execution).rejects.toThrow('AbortError');
      await journal.settle();
      journal.save(true);
      expect(JSON.stringify(store.messages(conversation))).toContain(INTERRUPTED_TOOL);
      const fork = store.fork(conversation, journal.checkpoint);
      expect(fork).not.toBeNull();
      expect(store.messages(fork!)).toEqual(store.messages(conversation));
      expect(journal.activity()).toEqual([
        { kind: 'tool', id: 'external', tool: 'mcp__nanoclaw__send_email', status: 'interrupted',
          detail: 'alice@example.test', description: 'Subject: Report', error: INTERRUPTED_TOOL },
      ]);
    } finally {
      store.close();
    }
  });
});
