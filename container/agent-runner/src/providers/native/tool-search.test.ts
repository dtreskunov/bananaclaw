import { describe, expect, it } from 'bun:test';
import { dynamicTool, InvalidToolInputError, jsonSchema, NoSuchToolError, type ModelMessage } from 'ai';

import type { McpToolEntry } from './mcp-client.js';
import {
  AUTO_DEFER_TOKENS,
  DeferredMcpTools,
  mcpToolSearchMode,
  shouldDeferMcpTools,
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

async function runSearch(tools: DeferredMcpTools, query: string, max_results?: number) {
  const search = tools.toolSet()[TOOL_SEARCH];
  return (await search.execute!({ query, max_results }, { toolCallId: 'call', messages: [] })) as {
    loaded: string[];
    tools: Array<{ name: string; description: string }>;
    note: string;
  };
}

describe('mcpToolSearchMode', () => {
  it('parses modes and falls back to auto', () => {
    expect(mcpToolSearchMode(undefined)).toBe('auto');
    expect(mcpToolSearchMode('always')).toBe('always');
    expect(mcpToolSearchMode(true)).toBe('always');
    expect(mcpToolSearchMode('never')).toBe('never');
    expect(mcpToolSearchMode(false)).toBe('never');
    expect(mcpToolSearchMode('sometimes')).toBe('auto');
  });
});

describe('shouldDeferMcpTools', () => {
  it('defers in auto mode only above the size threshold', () => {
    const big = entry('big', 'tool', 'x'.repeat(AUTO_DEFER_TOKENS * 4 + 4));
    expect(shouldDeferMcpTools(entries, 'auto')).toBe(false);
    expect(shouldDeferMcpTools([big], 'auto')).toBe(true);
    expect(shouldDeferMcpTools([big], 'never')).toBe(false);
    expect(shouldDeferMcpTools(entries, 'always')).toBe(true);
    expect(shouldDeferMcpTools([], 'always')).toBe(false);
  });
});

describe('DeferredMcpTools', () => {
  it('exposes only tool_search until tools are loaded', () => {
    expect(Object.keys(new DeferredMcpTools(entries).toolSet())).toEqual([TOOL_SEARCH]);
  });

  it('lists servers and short names in the catalog', () => {
    const catalog = new DeferredMcpTools(entries).instructions();
    expect(catalog).toContain('- **calendar** (2 tools, prefix `mcp__calendar__`): list_events, createEvent');
    expect(catalog).toContain('- **home** (1 tools, prefix `mcp__home__`): get_state');
    expect(catalog).not.toContain('smart home device');
  });

  it('ranks name matches above description matches and loads results', async () => {
    const tools = new DeferredMcpTools(entries);
    const output = await runSearch(tools, 'calendar events', 2);
    expect(output.loaded).toEqual(['mcp__calendar__list_events', 'mcp__calendar__createEvent']);
    expect(Object.keys(tools.toolSet())).toEqual([TOOL_SEARCH, ...output.loaded]);
    expect(output.tools[0]).toEqual({
      name: 'mcp__calendar__list_events',
      description: 'List calendar events in a date range.',
    });
  });

  it('matches camelCase words, prefixes and plurals', () => {
    const tools = new DeferredMcpTools(entries);
    expect(tools.search('create event').map((item) => item.name)[0]).toBe('mcp__calendar__createEvent');
    expect(tools.search('stat').map((item) => item.name)).toEqual(['mcp__home__get_state']);
    expect(tools.search('devices').map((item) => item.name)).toEqual(['mcp__home__get_state']);
  });

  it('selects exact and unambiguous bare names', async () => {
    const tools = new DeferredMcpTools(entries);
    const output = await runSearch(tools, 'select: mcp__files__search_files, get_state, list_events, nope');
    expect(output.loaded).toEqual(['mcp__files__search_files', 'mcp__home__get_state']);
    expect((await runSearch(tools, 'zzz')).note).toContain('No matching tools');
  });

  it('evicts the least recently used tools beyond the cap', async () => {
    const many = Array.from({ length: 35 }, (_, index) => entry('bulk', `tool_${index}`, 'Bulk tool.'));
    const tools = new DeferredMcpTools(many);
    await runSearch(tools, `select:${many.map((item) => item.name).join(',')}`);
    expect(tools.loadedNames()).toEqual(many.slice(0, 30).map((item) => item.name));
    await runSearch(tools, 'select:mcp__bulk__tool_0');
    await runSearch(tools, 'select:mcp__bulk__tool_30');
    expect(tools.loadedNames()).toHaveLength(30);
    expect(tools.loadedNames()).toContain('mcp__bulk__tool_0');
    expect(tools.loadedNames()).toContain('mcp__bulk__tool_30');
    expect(tools.loadedNames()).not.toContain('mcp__bulk__tool_1');
  });

  it('restores the loaded set from history', () => {
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
    expect(new DeferredMcpTools(entries, history).loadedNames()).toEqual([
      'mcp__home__get_state',
      'mcp__files__search_files',
    ]);
  });

  it('restores tool_search results the journal saved as text', () => {
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
    expect(new DeferredMcpTools(entries, history).loadedNames()).toEqual(['mcp__calendar__createEvent']);
  });

  it('marks executed tools as recently used and keeps catalog order in the tool set', async () => {
    const tools = new DeferredMcpTools(entries);
    await runSearch(tools, 'select:mcp__home__get_state,mcp__calendar__list_events');
    const loaded = tools.toolSet();
    expect(Object.keys(loaded)).toEqual([TOOL_SEARCH, 'mcp__calendar__list_events', 'mcp__home__get_state']);
    expect(tools.loadedNames()).toEqual(['mcp__home__get_state', 'mcp__calendar__list_events']);
    expect(await loaded['mcp__home__get_state'].execute!({}, { toolCallId: 'use', messages: [] })).toBe('ok');
    expect(tools.loadedNames()).toEqual(['mcp__calendar__list_events', 'mcp__home__get_state']);
  });

  it('repairs calls to unloaded catalog tools into a tool_search select', async () => {
    const tools = new DeferredMcpTools(entries);
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
