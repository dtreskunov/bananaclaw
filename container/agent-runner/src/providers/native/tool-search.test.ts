import { describe, expect, it, mock, spyOn } from 'bun:test';
import { dynamicTool, InvalidToolInputError, jsonSchema, NoSuchToolError, type ModelMessage } from 'ai';

import type { McpToolEntry } from './mcp-client.js';
import {
  DeferredMcpTools,
  mcpToolSearchMode,
  TOOL_SEARCH,
} from './tool-search.js';

function entry(server: string, toolName: string, description: string, inputSchema: unknown = {}): McpToolEntry {
  return {
    name: `mcp__${server}__${toolName}`,
    server,
    toolName,
    description,
    inputSchema,
    tool: dynamicTool({ description, inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ok' }),
  };
}

const entries = [
  entry('calendar', 'list_events', 'List calendar events in a date range.'),
  entry('calendar', 'createEvent', 'Create a new calendar entry.'),
  entry('files', 'search_files', 'Find files by name.'),
  entry('files', 'list_events', 'List file change events.'),
  entry('home', 'get_state', 'Read the state of a smart home device.'),
];

function toolsWith(entries: McpToolEntry[], history: ModelMessage[] = []): DeferredMcpTools {
  return new DeferredMcpTools({
    servers: [...new Set(entries.map((entry) => entry.server))],
    load: async (servers) => entries.filter((entry) => servers.includes(entry.server)),
  }, history);
}

async function runSearch(tools: DeferredMcpTools, query: string, max_results?: number, server?: string, abortSignal?: AbortSignal) {
  const search = tools.toolSet()[TOOL_SEARCH];
  return (await search.execute!({ query, max_results, server }, { toolCallId: 'call', messages: [], abortSignal })) as {
    loaded: string[];
    tools: Array<{ name: string; description: string }>;
    note: string;
  };
}

describe('mcpToolSearchMode', () => {
  it('defaults to always and preserves explicit modes and boolean aliases', () => {
    expect(mcpToolSearchMode(undefined)).toBe('always');
    expect(mcpToolSearchMode('always')).toBe('always');
    expect(mcpToolSearchMode(true)).toBe('always');
    expect(mcpToolSearchMode('never')).toBe('never');
    expect(mcpToolSearchMode(false)).toBe('never');
  });

  it('warns about retired or invalid values and explicitly falls back to always', () => {
    const logger = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(mcpToolSearchMode('auto')).toBe('always');
      expect(logger).toHaveBeenCalledWith(expect.stringContaining('Replace retired auto settings with always'));
      expect(mcpToolSearchMode('sometimes')).toBe('always');
      expect(logger).toHaveBeenCalledTimes(2);
    } finally {
      logger.mockRestore();
    }
  });
});

describe('lazy MCP tool search', () => {
  function catalog() {
    const load = mock(async (servers: string[], _signal?: AbortSignal) =>
      entries.filter((entry) => servers.includes(entry.server)));
    return { servers: ['calendar', 'files', 'home'], load };
  }

  it('advertises undiscovered integrations without starting discovery, even with restored tool history', () => {
    const source = catalog();
    const tools = new DeferredMcpTools(source, [{
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'mcp__home__get_state', input: {} }],
    }]);
    expect(Object.keys(tools.toolSet())).toEqual([TOOL_SEARCH]);
    expect(tools.instructions()).toContain('**home** (discover on demand');
    expect(tools.instructions()).toContain('undiscovered does not mean unavailable');
    expect(source.load).not.toHaveBeenCalled();
  });

  it('discovers only an explicitly selected server and filters previously discovered tools', async () => {
    const source = catalog();
    const tools = new DeferredMcpTools(source);
    await runSearch(tools, 'events');
    source.load.mockClear();
    const output = await runSearch(tools, 'events', undefined, 'files');
    expect(source.load).toHaveBeenCalledWith(['files'], undefined);
    expect(output.loaded).toEqual(['mcp__files__list_events']);
    expect((await runSearch(tools, 'select:mcp__calendar__list_events', undefined, 'files')).loaded).toEqual([]);
  });

  it('routes fully qualified selections to their servers but searches every server for bare names', async () => {
    const source = catalog();
    const tools = new DeferredMcpTools(source);
    await runSearch(tools, 'select:mcp__home__get_state,mcp__calendar__list_events');
    expect(source.load).toHaveBeenLastCalledWith(['home', 'calendar'], undefined);
    expect(Object.keys(tools.toolSet())).toContain('mcp__home__get_state');
    await runSearch(tools, 'select:list_events');
    expect(source.load).toHaveBeenLastCalledWith(source.servers, undefined);
    await expect(runSearch(tools, 'events', undefined, 'missing')).rejects.toThrow('Unknown MCP server');
  });

  it('uses the longest server prefix for exact selections', async () => {
    const load = mock(async (_servers: string[]) => []);
    const tools = new DeferredMcpTools({ servers: ['home', 'home__assistant'], load });
    await runSearch(tools, 'select:mcp__home__assistant__get_state');
    expect(load).toHaveBeenCalledWith(['home__assistant'], undefined);
  });

  it('reports discovery failures rather than claiming there were no matching tools, and permits retry', async () => {
    const source = catalog();
    source.load.mockRejectedValueOnce(new Error('calendar discovery timed out'));
    const tools = new DeferredMcpTools(source);
    await expect(runSearch(tools, 'events')).rejects.toThrow('calendar discovery timed out');
    expect((await runSearch(tools, 'events')).loaded).toContain('mcp__calendar__list_events');
  });

  it('propagates tool cancellation and restores known history only after discovering its server', async () => {
    const source = catalog();
    const tools = new DeferredMcpTools(source, [{
      role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'old', toolName: TOOL_SEARCH,
        output: { type: 'json', value: { loaded: ['mcp__home__get_state'] } },
      }],
    }]);
    const controller = new AbortController();
    await runSearch(tools, 'calendar', undefined, 'calendar', controller.signal);
    expect(source.load).toHaveBeenLastCalledWith(['calendar'], controller.signal);
    expect(tools.loadedNames()).not.toContain('mcp__home__get_state');
    await runSearch(tools, 'unmatched', undefined, 'home');
    expect(tools.loadedNames()).toContain('mcp__home__get_state');
  });

  it('repairs a direct fully qualified call without doing network discovery during repair', async () => {
    const source = catalog();
    const tools = new DeferredMcpTools(source);
    const toolCall = { type: 'tool-call' as const, toolCallId: 'x', toolName: 'mcp__home__get_state', input: '{}' };
    const result = await tools.repairToolCall({
      messages: [], tools: {}, inputSchema: () => ({}), toolCall,
      error: new NoSuchToolError({ toolName: toolCall.toolName, availableTools: [TOOL_SEARCH] }),
    } as never);
    expect(result).toMatchObject({ toolName: TOOL_SEARCH, input: '{"query":"select:mcp__home__get_state"}' });
    expect(source.load).not.toHaveBeenCalled();
  });

  it('rejects ambiguous sanitized server prefixes before discovery', () => {
    expect(() => new DeferredMcpTools({ servers: ['a_b', 'a.b'], load: async () => [] }))
      .toThrow('MCP server name collision');
  });
});

describe('DeferredMcpTools', () => {
  it('exposes only tool_search until tools are loaded', () => {
    expect(Object.keys(toolsWith(entries).toolSet())).toEqual([TOOL_SEARCH]);
  });

  it('lists configured servers without requiring their tool catalog', () => {
    const catalog = toolsWith(entries).instructions();
    expect(catalog).toContain('- **calendar** (discover on demand, prefix `mcp__calendar__`)');
    expect(catalog).toContain('- **home** (discover on demand, prefix `mcp__home__`)');
    expect(catalog).not.toContain('list_events');
    expect(catalog).not.toContain('smart home device');
  });

  it('ranks name matches above description matches and loads results', async () => {
    const tools = toolsWith(entries);
    const output = await runSearch(tools, 'calendar events', 2);
    expect(output.loaded).toEqual(['mcp__calendar__list_events', 'mcp__calendar__createEvent']);
    expect(Object.keys(tools.toolSet())).toEqual([TOOL_SEARCH, ...output.loaded]);
    expect(output.tools[0]).toEqual({
      name: 'mcp__calendar__list_events',
      description: 'List calendar events in a date range.',
    });
  });

  it('matches camelCase words, prefixes and plurals', async () => {
    const tools = toolsWith(entries);
    expect((await runSearch(tools, 'create event')).loaded[0]).toBe('mcp__calendar__createEvent');
    expect((await runSearch(tools, 'stat')).loaded).toEqual(['mcp__home__get_state']);
    expect((await runSearch(tools, 'devices')).loaded).toEqual(['mcp__home__get_state']);
  });

  it('selects exact and unambiguous bare names', async () => {
    const tools = toolsWith(entries);
    const output = await runSearch(tools, 'select: mcp__files__search_files, get_state, list_events, nope');
    expect(output.loaded).toEqual(['mcp__files__search_files', 'mcp__home__get_state']);
    expect((await runSearch(tools, 'zzz')).note).toContain('No matching tools');
  });

  it('evicts the least recently used tools beyond the cap', async () => {
    const many = Array.from({ length: 35 }, (_, index) => entry('bulk', `tool_${index}`, 'Bulk tool.'));
    const tools = toolsWith(many);
    await runSearch(tools, `select:${many.map((item) => item.name).join(',')}`);
    expect(tools.loadedNames()).toEqual(many.slice(0, 30).map((item) => item.name));
    await runSearch(tools, 'select:mcp__bulk__tool_0');
    await runSearch(tools, 'select:mcp__bulk__tool_30');
    expect(tools.loadedNames()).toHaveLength(30);
    expect(tools.loadedNames()).toContain('mcp__bulk__tool_0');
    expect(tools.loadedNames()).toContain('mcp__bulk__tool_30');
    expect(tools.loadedNames()).not.toContain('mcp__bulk__tool_1');
  });

  it('restores the loaded set from history after discovery', async () => {
    const history: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'mcp__home__get_state', input: {} },
          { type: 'tool-call', toolCallId: 'b', toolName: 'mcp__gone__tool', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c',
            toolName: TOOL_SEARCH,
            output: { type: 'json', value: { loaded: ['mcp__files__search_files', 'mcp__gone__tool', 7] } },
          },
        ],
      },
    ];
    const tools = toolsWith(entries, history);
    await runSearch(tools, 'unmatched');
    expect(tools.loadedNames()).toEqual([
      'mcp__home__get_state',
      'mcp__files__search_files',
    ]);
  });

  it('restores history in last-used order, including repeated tool names', async () => {
    const history: ModelMessage[] = [{
      role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'mcp__home__get_state', input: {} },
        { type: 'tool-call', toolCallId: 'b', toolName: 'mcp__files__search_files', input: {} },
        { type: 'tool-call', toolCallId: 'c', toolName: 'mcp__home__get_state', input: {} },
      ],
    }];
    const tools = toolsWith(entries, history);
    await runSearch(tools, 'unmatched');
    expect(tools.loadedNames()).toEqual([
      'mcp__files__search_files', 'mcp__home__get_state',
    ]);
  });

  it('restores tool_search results the journal saved as text', async () => {
    const history: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'd',
            toolName: TOOL_SEARCH,
            output: { type: 'text', value: JSON.stringify({ loaded: ['mcp__calendar__createEvent'] }) },
          },
          {
            type: 'tool-result',
            toolCallId: 'e',
            toolName: TOOL_SEARCH,
            output: { type: 'text', value: 'not json' },
          },
        ],
      },
    ];
    const tools = toolsWith(entries, history);
    await runSearch(tools, 'unmatched');
    expect(tools.loadedNames()).toEqual(['mcp__calendar__createEvent']);
  });

  it('marks executed tools as recently used and keeps catalog order in the tool set', async () => {
    const tools = toolsWith(entries);
    await runSearch(tools, 'select:mcp__home__get_state,mcp__calendar__list_events');
    const loaded = tools.toolSet();
    expect(Object.keys(loaded)).toEqual([TOOL_SEARCH, 'mcp__calendar__list_events', 'mcp__home__get_state']);
    expect(tools.loadedNames()).toEqual(['mcp__home__get_state', 'mcp__calendar__list_events']);
    expect(await loaded['mcp__home__get_state'].execute!({}, { toolCallId: 'use', messages: [] })).toBe('ok');
    expect(tools.loadedNames()).toEqual(['mcp__calendar__list_events', 'mcp__home__get_state']);
  });

  it('repairs calls to unloaded catalog tools into a tool_search select', async () => {
    const tools = toolsWith(entries);
    await runSearch(tools, 'unmatched');
    const toolCall = { type: 'tool-call' as const, toolCallId: 'x', toolName: 'get_state', input: '{"id":1}' };
    const repairOptions = { messages: [], tools: {}, inputSchema: () => ({}) } as never;
    const noSuchTool = (toolName: string) => new NoSuchToolError({ toolName, availableTools: [TOOL_SEARCH] });

    expect(await tools.repairToolCall({ ...repairOptions, toolCall, error: noSuchTool('get_state') })).toEqual({
      ...toolCall,
      toolName: TOOL_SEARCH,
      input: '{"query":"select:mcp__home__get_state"}',
    });
    expect(
      await tools.repairToolCall({
        ...repairOptions,
        toolCall: { ...toolCall, toolName: 'unknown' },
        error: noSuchTool('unknown'),
      }),
    ).toBeNull();
    expect(
      await tools.repairToolCall({
        ...repairOptions,
        toolCall,
        error: new InvalidToolInputError({ toolName: 'get_state', toolInput: '{}', cause: new Error('bad') }),
      }),
    ).toBeNull();
  });
});
