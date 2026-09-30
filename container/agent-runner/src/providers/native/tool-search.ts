/**
 * On-demand loading of external MCP tools for the native provider.
 *
 * Large MCP servers can contribute hundreds of tool schemas, which would be
 * resent on every model step. In deferred mode the model sees only a compact
 * catalog of tool names plus `tool_search`; searching loads matching tools,
 * which become callable from the next step. The loaded set is rebuilt from the
 * conversation history on each turn, so it survives restarts and forks
 * without extra state.
 */
import {
  jsonSchema,
  NoSuchToolError,
  tool,
  type ModelMessage,
  type Tool,
  type ToolCallRepairFunction,
  type ToolResultPart,
  type ToolSet,
} from 'ai';

import type { McpToolEntry } from './mcp-client.js';
import { mcpToolPrefix } from './mcp-names.js';

export const TOOL_SEARCH = 'tool_search';
export type McpToolSearchMode = 'auto' | 'always' | 'never';

/** `auto` defers once the external schemas exceed roughly this many tokens. */
export const AUTO_DEFER_TOKENS = 8_000;
const MAX_LOADED = 30;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_RESULT_DESCRIPTION = 300;

export function mcpToolSearchMode(value: unknown): McpToolSearchMode {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === true || value === 'always') return 'always';
  if (value === false || value === 'never') return 'never';
  console.error(`[native-provider] Ignoring invalid model_params.mcp_tool_search: ${JSON.stringify(value)}`);
  return 'auto';
}

export function estimateMcpToolTokens(entries: readonly McpToolEntry[]): number {
  const chars = entries.reduce(
    (total, entry) =>
      total + entry.name.length + entry.description.length + JSON.stringify(entry.inputSchema ?? {}).length,
    0,
  );
  return Math.ceil(chars / 4);
}

export function shouldDeferMcpTools(entries: readonly McpToolEntry[], mode: McpToolSearchMode): boolean {
  if (entries.length === 0 || mode === 'never') return false;
  return mode === 'always' || estimateMcpToolTokens(entries) > AUTO_DEFER_TOKENS;
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1)
    .map(stem);
}

interface IndexedEntry {
  entry: McpToolEntry;
  nameWords: Set<string>;
  descriptionWords: Set<string>;
}

interface SearchOutput {
  loaded: string[];
  tools: Array<{ name: string; description: string }>;
  note: string;
}

/**
 * Completed segments store results as `json`; the turn journal stores
 * interrupted ones as JSON `text`.
 */
function loadedFromResult(output: ToolResultPart['output']): string[] {
  let value: unknown;
  if (output.type === 'json') value = output.value;
  else if (output.type === 'text') {
    try {
      value = JSON.parse(output.value);
    } catch {
      return [];
    }
  }
  const loaded = (value as { loaded?: unknown } | null | undefined)?.loaded;
  return Array.isArray(loaded) ? loaded.filter((name): name is string => typeof name === 'string') : [];
}

export class DeferredMcpTools {
  private readonly index: IndexedEntry[];
  private readonly byName = new Map<string, McpToolEntry>();
  /** Catalog tools whose execution marks them recently used, as restore() does. */
  private readonly trackedTools = new Map<string, Tool>();
  /** Insertion order is recency order; the oldest entry is evicted first. */
  private readonly loaded = new Set<string>();
  private readonly searchTool;

  constructor(entries: readonly McpToolEntry[], history: readonly ModelMessage[] = []) {
    this.index = entries.map((entry) => ({
      entry,
      nameWords: new Set(words(`${entry.server} ${entry.toolName}`)),
      descriptionWords: new Set(words(entry.description)),
    }));
    for (const entry of entries) {
      this.byName.set(entry.name, entry);
      const execute = entry.tool.execute;
      this.trackedTools.set(
        entry.name,
        execute
          ? {
              ...entry.tool,
              execute: (input, options) => {
                this.touch(entry.name);
                return execute(input, options);
              },
            }
          : entry.tool,
      );
    }
    this.restore(history);
    this.searchTool = tool({
      description:
        'Load external MCP tools listed in the external tools catalog. Pass keywords describing the task ' +
        '(e.g. "calendar events"), or "select:<name>[,<name>...]" for exact tool names. Loaded tools become ' +
        'callable on your next step.',
      inputSchema: jsonSchema<{ query: string; max_results?: number }>({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, or select:<name>[,<name>...]' },
          max_results: { type: 'number', description: `Maximum tools to load (default ${DEFAULT_RESULTS})` },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async ({ query, max_results }) => this.runSearch(query, max_results),
    });
  }

  loadedNames(): string[] {
    return [...this.loaded];
  }

  /**
   * `tool_search` plus the loaded tools, in catalog order so the serialized
   * tool list stays stable for provider prompt caching. Rebuild every step.
   */
  toolSet(): ToolSet {
    const tools: ToolSet = { [TOOL_SEARCH]: this.searchTool };
    for (const [name, loadedTool] of this.trackedTools) if (this.loaded.has(name)) tools[name] = loadedTool;
    return tools;
  }

  instructions(): string {
    const servers = new Map<string, McpToolEntry[]>();
    for (const entry of this.byName.values()) {
      const list = servers.get(entry.server) ?? [];
      list.push(entry);
      servers.set(entry.server, list);
    }
    return [
      '## External tools (load on demand)',
      '',
      `Tools from the MCP servers below are not loaded yet. Before using one, call \`${TOOL_SEARCH}\``,
      'with keywords for the task or `select:<name>` for exact names from this catalog; matching',
      'tools become callable on your next step. Never claim to have used a tool you did not call.',
      '',
      ...[...servers].map(([server, list]) => {
        const prefix = mcpToolPrefix(server);
        const names = list.map((entry) => entry.name.slice(prefix.length)).join(', ');
        return `- **${server}** (${list.length} tools, prefix \`${prefix}\`): ${names}`;
      }),
    ].join('\n');
  }

  search(query: string, limit = DEFAULT_RESULTS): McpToolEntry[] {
    const max = Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_RESULTS)));
    const trimmed = query.trim();
    if (/^select:/i.test(trimmed)) {
      const selected = trimmed
        .slice('select:'.length)
        .split(',')
        .map((name) => this.resolve(name.trim()))
        .filter((entry): entry is McpToolEntry => !!entry);
      return [...new Set(selected)].slice(0, MAX_LOADED);
    }
    const terms = words(trimmed);
    if (terms.length === 0) return [];
    return this.index
      .map((item) => ({ item, score: terms.reduce((total, term) => total + this.score(item, term), 0) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.entry.name.length - b.item.entry.name.length)
      .slice(0, max)
      .map(({ item }) => item.entry);
  }

  /**
   * A direct call to a catalog tool that is not loaded yet becomes a
   * `tool_search` select, so the model gets it loaded instead of an error
   * listing every available tool.
   */
  readonly repairToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, error }) => {
    if (!NoSuchToolError.isInstance(error)) return null;
    const entry = this.resolve(toolCall.toolName);
    if (!entry) return null;
    return { ...toolCall, toolName: TOOL_SEARCH, input: JSON.stringify({ query: `select:${entry.name}` }) };
  };

  private runSearch(query: string, limit: number | undefined): SearchOutput {
    const matches = this.search(query, limit);
    for (const entry of matches) this.touch(entry.name);
    return {
      loaded: matches.map((entry) => entry.name),
      tools: matches.map((entry) => ({
        name: entry.name,
        description:
          entry.description.length > MAX_RESULT_DESCRIPTION
            ? `${entry.description.slice(0, MAX_RESULT_DESCRIPTION)}…`
            : entry.description,
      })),
      note:
        matches.length > 0
          ? 'These tools are now loaded. Call them directly with the arguments they require.'
          : 'No matching tools. Try different keywords, or select:<name> with a name from the catalog.',
    };
  }

  private score({ nameWords, descriptionWords }: IndexedEntry, term: string): number {
    if (nameWords.has(term)) return 3;
    if (term.length >= 3 && [...nameWords].some((word) => word.startsWith(term))) return 2;
    return descriptionWords.has(term) ? 1 : 0;
  }

  /** Exact exposed name, or an unambiguous bare tool name. */
  private resolve(name: string): McpToolEntry | undefined {
    const exact = this.byName.get(name);
    if (exact) return exact;
    const bare = name.split('__').at(-1)!;
    const matches = [...this.byName.values()].filter(
      (entry) => entry.toolName === bare || entry.name.endsWith(`__${bare}`),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private touch(name: string): void {
    this.loaded.delete(name);
    this.loaded.add(name);
    while (this.loaded.size > MAX_LOADED) this.loaded.delete(this.loaded.values().next().value!);
  }

  private restore(history: readonly ModelMessage[]): void {
    for (const message of history) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === 'tool-call' && this.byName.has(part.toolName)) this.touch(part.toolName);
        if (part.type === 'tool-result' && part.toolName === TOOL_SEARCH) {
          for (const name of loadedFromResult(part.output)) if (this.byName.has(name)) this.touch(name);
        }
      }
    }
  }
}
