import { expect, it, spyOn } from 'bun:test';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import * as state from '../db/session-state.js';
import * as connection from '../db/connection.js';
import { ClaudeProvider } from './claude.js';

it('captures builtin metadata in actual SDK post-tool hooks and preserves failure outcomes', async () => {
  const append = spyOn(state, 'appendActivity').mockImplementation(() => {});
  const clear = spyOn(connection, 'clearContainerToolInFlight').mockImplementation(() => {});
  const sdkQuery = spyOn(sdk, 'query').mockImplementation(() =>
    Object.assign((async function* () {})(), { close() {} }) as ReturnType<typeof sdk.query>,
  );
  try {
    for await (const _ of new ClaudeProvider().query({ prompt: 'fixture', cwd: process.cwd() }).events) {}
    const hooks = sdkQuery.mock.calls[0][0].options?.hooks;
    const post = hooks?.PostToolUse?.[0].hooks[0];
    const failure = hooks?.PostToolUseFailure?.[0].hooks[0];
    if (typeof post !== 'function' || typeof failure !== 'function') throw new Error('Missing SDK post-tool hooks');
    const input = {
      session_id: 'fixture', transcript_path: '/tmp/fixture.jsonl', cwd: process.cwd(),
      tool_name: 'mcp__nanoclaw__send_email', tool_use_id: 'email-1',
      tool_input: { to: 'alice@example.test', subject: 'Report', body: 'private body' },
    };
    const context = { signal: new AbortController().signal };
    await post({ ...input, hook_event_name: 'PostToolUse', tool_response: { isError: false } }, undefined, context);
    expect(append.mock.calls.at(-1)?.[0]).toEqual({
      kind: 'tool', id: 'email-1', tool: input.tool_name, status: 'completed',
      detail: 'alice@example.test', description: 'Subject: Report',
    });
    await post({ ...input, hook_event_name: 'PostToolUse',
      tool_response: { isError: true, content: [{ type: 'text', text: 'Not permitted' }] } }, undefined, context);
    expect(append.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'error', detail: 'alice@example.test', description: 'Subject: Report', error: 'Not permitted',
    });
    await failure({ ...input, hook_event_name: 'PostToolUseFailure', error: 'Aborted', is_interrupt: true }, undefined, context);
    expect(append.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'interrupted', detail: 'alice@example.test', description: 'Subject: Report',
    });
  } finally {
    sdkQuery.mockRestore();
    clear.mockRestore();
    append.mockRestore();
  }
});
