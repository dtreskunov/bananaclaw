import { describe, expect, test } from 'bun:test';

import { mcpServersToFxConfig, resolveCommandPath } from './mcp-to-fx.js';
import {
  activityStepFromUpdate,
  buildPrompt,
  buildPromptBlocks,
  mapToolStatus,
  refusalMessage,
  sessionOpenRequest,
  unstartableMcpServer,
  withoutMcpServers,
} from './fx.js';

describe('mcpServersToFxConfig', () => {
  const resolve = (c: string) => (c.startsWith('/') ? c : `/usr/bin/${c}`);

  test('fills the args and env arrays fx requires even when absent', () => {
    const out = mcpServersToFxConfig({ tools: { command: '/opt/tools/serve' } }, resolve, undefined, {});
    expect(out).toEqual([{ name: 'tools', command: '/opt/tools/serve', args: [], env: [] }]);
  });

  test('resolves a bare command to an absolute path', () => {
    const out = mcpServersToFxConfig({ t: { command: 'bun', args: ['x.ts'] } }, resolve, undefined, {});
    expect(out[0]).toMatchObject({ command: '/usr/bin/bun', args: ['x.ts'] });
  });

  // fx passes this env verbatim and adds nothing, so a server declaring only
  // its API key would run with no PATH and fail to find its own interpreter.
  test('carries PATH and HOME through, letting declared values win', () => {
    const out = mcpServersToFxConfig(
      { a: { command: '/bin/a' }, b: { command: '/bin/b', env: { PATH: '/only' } } },
      resolve,
      undefined,
      { PATH: '/base/bin', HOME: '/home/agent' },
    );
    expect(out[0]).toMatchObject({
      env: [{ name: 'PATH', value: '/base/bin' }, { name: 'HOME', value: '/home/agent' }],
    });
    expect(out[1]).toMatchObject({
      env: [{ name: 'PATH', value: '/only' }, { name: 'HOME', value: '/home/agent' }],
    });
  });

  test('converts env and headers objects into name/value arrays', () => {
    const out = mcpServersToFxConfig(
      {
        stdio: { command: '/bin/s', env: { TOKEN: 'a' } },
        remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
      },
      resolve,
      undefined,
      {},
    );
    expect(out[0]).toMatchObject({ env: [{ name: 'TOKEN', value: 'a' }] });
    expect(out[1]).toEqual({
      type: 'http',
      name: 'remote',
      url: 'https://example.test/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }],
    });
  });

  test('preserves the sse transport', () => {
    const out = mcpServersToFxConfig({ r: { type: 'sse', url: 'https://e.test/x' } }, resolve, undefined, {});
    expect(out[0]).toMatchObject({ type: 'sse' });
  });

  test('returns an empty array when no servers are configured', () => {
    expect(mcpServersToFxConfig(undefined, resolve, undefined, {})).toEqual([]);
  });

  test('resolveCommandPath leaves an absolute command untouched', () => {
    expect(resolveCommandPath('/bin/sh')).toBe('/bin/sh');
  });
});

describe('degrading past an MCP server that will not start', () => {
  test('names the server fx refused to start', () => {
    expect(unstartableMcpServer(new Error("Required MCP server 'MiniMax' failed to start: McpInitFailed"))).toBe(
      'MiniMax',
    );
    expect(unstartableMcpServer(new Error('session/new: connection closed'))).toBeUndefined();
  });

  test('drops only the named server from the config', () => {
    const servers = { a: { command: '/bin/a' }, b: { command: '/bin/b' } };
    expect(withoutMcpServers(servers, new Set(['b']))).toEqual({ a: { command: '/bin/a' } });
    expect(withoutMcpServers(servers, new Set())).toBe(servers);
    expect(withoutMcpServers(undefined, new Set(['b']))).toBeUndefined();
  });
});

describe('mapToolStatus', () => {
  test('maps fx statuses onto the activity vocabulary', () => {
    expect(mapToolStatus('completed')).toBe('completed');
    expect(mapToolStatus('failed')).toBe('error');
    expect(mapToolStatus('in_progress')).toBe('running');
    expect(mapToolStatus(undefined)).toBe('pending');
  });
});

describe('activityStepFromUpdate', () => {
  test('turns a tool_call update into a tool step', () => {
    const step = activityStepFromUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'bash',
      status: 'in_progress',
    });
    expect(step).toMatchObject({ kind: 'tool', id: 'tc-1', tool: 'bash', status: 'running' });
  });

  test('ignores message chunks, which are accumulated as result text instead', () => {
    expect(activityStepFromUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } })).toBeNull();
    expect(activityStepFromUpdate({ sessionUpdate: 'available_commands_update' })).toBeNull();
  });

  test('takes detail from the command the call was invoked with', () => {
    const step = activityStepFromUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'exit_code=0\n' } }],
      command_result: { command: 'pwd && uname -a' },
    });
    expect(step).toMatchObject({ detail: 'pwd && uname -a', status: 'completed' });
  });

  test('carries name and detail onto a tool_call_update that omits them', () => {
    const seen = new Map();
    activityStepFromUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Running', kind: 'execute', status: 'pending' },
      seen,
    );
    const running = activityStepFromUpdate(
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' },
      seen,
    );
    // Without the carry-over the name would fall back to the literal "tool",
    // making every fx call look identical to the runaway-turn guard.
    expect(running).toMatchObject({ tool: 'Running', title: 'Running', status: 'running' });
  });

  test('keeps distinct calls distinct once each reports its command', () => {
    const seen = new Map();
    const done = ['pwd', 'ls /tmp'].map((command, i) => {
      const id = `tc-${i}`;
      activityStepFromUpdate({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Running', status: 'pending' }, seen);
      return activityStepFromUpdate(
        { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', command_result: { command } },
        seen,
      );
    });
    expect(done).toMatchObject([{ detail: 'pwd' }, { detail: 'ls /tmp' }]);
  });

  test('does not pass streamed command output off as the command', () => {
    const seen = new Map();
    activityStepFromUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Running', kind: 'execute', status: 'pending' },
      seen,
    );
    // fx streams a shell call's stdout on `content` well before it reports the
    // command, so taking it would show output where the argument belongs.
    const running = activityStepFromUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: '/workspace/agent\n' } }],
      },
      seen,
    );
    expect(running?.kind === 'tool' && running.detail).toBeUndefined();
  });

  test('does not pass a tool result off as the invocation', () => {
    const step = activityStepFromUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '{"images":[{"image_id":1}]}' } }],
    });
    expect(step?.kind === 'tool' && step.detail).toBeUndefined();
  });

  test('takes detail from a web progress label without repeating its verb', () => {
    const seen = new Map();
    activityStepFromUpdate(
      { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Fetching', kind: 'read', status: 'pending' },
      seen,
    );
    const step = activityStepFromUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'Fetching https://example.com/a' } }],
      },
      seen,
    );
    expect(step).toMatchObject({ title: 'Fetching', detail: 'https://example.com/a' });
  });

  test('reports the failure text of a failed call', () => {
    const step = activityStepFromUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
    });
    expect(step).toMatchObject({ status: 'error', error: 'permission denied' });
  });

  test('reads a thought chunk from the single-block content shape', () => {
    const step = activityStepFromUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    expect(step).toMatchObject({ kind: 'internal', text: 'hmm' });
  });
});

describe('buildPrompt', () => {
  test('fences harness instructions so they cannot read as user speech', () => {
    expect(buildPrompt('what is fx?', 'route replies to web-mg-web-s')).toBe(
      '<system>\nroute replies to web-mg-web-s\n</system>\n\nwhat is fx?',
    );
  });

  test('leaves the prompt untouched when there are no instructions', () => {
    expect(buildPrompt('what is fx?')).toBe('what is fx?');
  });
});

describe('buildPromptBlocks', () => {
  test('sends a bare text block when there are no attachments', () => {
    expect(buildPromptBlocks('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  // fx advertises promptCapabilities.image === false, so attachments have to be
  // referenced by path rather than inlined as content blocks.
  test('appends a path manifest instead of inline image blocks', () => {
    const blocks = buildPromptBlocks('look', [
      { path: '/workspace/agent/inbox/m1/a.jpg', mime: 'image/jpeg', filename: 'a.jpg' },
    ]);
    expect(blocks).toHaveLength(1);
    expect(String((blocks[0] as { text: string }).text)).toContain('/workspace/agent/inbox/m1/a.jpg');
  });
});

describe('refusalMessage', () => {
  const now = 1_000_000;

  test('names the gateway status and reason over fx chain-of-thought', () => {
    const message = refusalMessage('Let me set the thread title...', {
      status: 429,
      message: 'Free tier requests on this model are rate-limited.',
      at: now - 1000,
    }, now);
    expect(message).toBe('AI Gateway returned 429: Free tier requests on this model are rate-limited.');
  });

  test('ignores an upstream error left over from an earlier turn', () => {
    const message = refusalMessage('partial', { status: 429, message: 'old', at: now - 120_000 }, now);
    expect(message).toBe('partial');
  });

  test('falls back to a generic hint when there is nothing else', () => {
    expect(refusalMessage('   ', null, now)).toContain('check AI Gateway credentials');
  });
});

describe('sessionOpenRequest', () => {
  const mcpServers = [{ name: 'nanoclaw', command: 'bun', args: [], env: [] }];

  test('sends the MCP list on session/load so resumed sessions keep their tools', () => {
    const { method, params } = sessionOpenRequest({ cwd: '/workspace', continuation: 'sess-1' }, mcpServers);
    expect(method).toBe('session/load');
    expect(params).toEqual({ sessionId: 'sess-1', cwd: '/workspace', mcpServers });
  });

  test('creates a new session when there is nothing to continue', () => {
    const { method, params } = sessionOpenRequest({ cwd: '/workspace' }, mcpServers);
    expect(method).toBe('session/new');
    expect(params).toEqual({ cwd: '/workspace', mcpServers });
  });
});
