import { expect, it, spyOn } from 'bun:test';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { ClaudeProvider } from './claude.js';
import type { ProviderEvent } from './types.js';

function scripted(messages: unknown[]) {
  return spyOn(sdk, 'query').mockImplementation(() =>
    Object.assign((async function* () {
      for (const message of messages) {
        await Bun.sleep(5);
        yield message;
      }
    })(), { close() {} }) as unknown as ReturnType<typeof sdk.query>,
  );
}

const assistant = (id: string, content: unknown[], usage: object, parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'claude-test', content, usage } });

it('reports each main-thread call with an estimated time and settles the result onto the last one', async () => {
  const sdkQuery = scripted([
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      { input_tokens: 10, output_tokens: 2 }),
    assistant('sub', [{ type: 'text', text: 'side' }], { input_tokens: 100, output_tokens: 100 }, 't1'),
    { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [] } },
    assistant('m2', [{ type: 'text', text: 'done' }], { input_tokens: 20, output_tokens: 1 }),
    assistant('m2', [{ type: 'text', text: 'done' }], { input_tokens: 20, output_tokens: 5 }),
    {
      type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.3,
      usage: { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-test': { costUSD: 0.3, contextWindow: 200_000, maxOutputTokens: 64_000 } },
    },
  ]);
  try {
    const events: ProviderEvent[] = [];
    for await (const event of new ClaudeProvider().query({ prompt: 'go', cwd: process.cwd() }).events) {
      if (event.type !== 'activity') events.push(event);
    }
    const calls = events.flatMap((event) => event.type === 'usage_call' ? [event.data] : []);
    expect(calls).toEqual([
      expect.objectContaining({ id: 'm1', input_tokens: 10, output_tokens: 2, cost_usd: 0 }),
      expect.objectContaining({
        id: 'm2', model: 'claude-test', input_tokens: 30, output_tokens: 7, cost_usd: 0.3,
        context_tokens: 25, context_window: 200_000, max_output_tokens: 64_000,
      }),
    ]);
    expect(calls.every((call) => typeof call.duration_api_ms === 'number' && call.duration_api_ms >= 0)).toBe(true);
    // The tool call's model step must precede the tool's own row.
    expect(events.findIndex((event) => event.type === 'usage_call'))
      .toBeLessThan(events.findIndex((event) => event.type === 'progress'));
    expect(events.at(-1)).toEqual({ type: 'result', text: 'done' });
  } finally {
    sdkQuery.mockRestore();
  }
});
