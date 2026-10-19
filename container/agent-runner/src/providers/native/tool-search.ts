/**
 * On-demand loading of external MCP tools for the native provider.
 *
 * The model sees configured server names plus `tool_search`, without waiting
 * for discovery. Searching loads matching tools for the next model step.
 * History restores known tools only after their server is discovered.
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
export type McpToolSearchMode = 'always' | 'never';

const MAX_LOADED = 30;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_RESULT_DESCRIPTION = 300;

export function mcpToolSearchMode(value: unknown): McpToolSearchMode {
  if (value === undefined || value === true || value === 'always') return 'always';
  if (value === false || value === 'never') return 'never';
  console.error(
    `[native-provider] Unsupported model_params.mcp_tool_search: ${JSON.stringify(value)}; ` +
      'using always. Supported modes: always, never. Replace retired auto settings with always.',
  );
  return 'always';
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

export interface DeferredMcpSource {
  servers: string[];
  load: (servers: string[], signal?: AbortSignal) => Promise<McpToolEntry[]>;
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
  private readonly index: IndexedEntry[] = [];
  private readonly byName = new Map<string, McpToolEntry>();
  /** Catalog tools whose execution marks them recently used, as restore() does. */
  private readonly trackedTools = new Map<string, Tool>();
  /** Insertion order is recency order; the oldest entry is evicted first. */
  private readonly loaded = new Set<string>();
  private readonly searchTool;

  constructor(
    private readonly source: DeferredMcpSource,
    private readonly history: readonly ModelMessage[] = [],
  ) {
    const prefixes = source.servers.map(mcpToolPrefix);
    if (new Set(prefixes).size !== prefixes.length) throw new Error('MCP server name collision');
    this.searchTool = tool({
      description:
        'Discover and load external MCP tools. Pass keywords describing the task ' +
        '(e.g. "calendar events"), or "select:<name>[,<name>...]" for exact tool names. ' +
        'Optionally specify a configured server to avoid waiting for unrelated servers. ' +
        'Loaded tools become callable on your next step.',
      inputSchema: jsonSchema<{ query: string; max_results?: number; server?: string }>({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, or select:<name>[,<name>...]' },
          max_results: { type: 'number', description: `Maximum tools to load (default ${DEFAULT_RESULTS})` },
          server: { type: 'string', description: 'Exact configured MCP server name; omit to search all servers.' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async ({ query, max_results, server }, { abortSignal }) => {
        const servers = this.searchServers(query, server);
        this.addEntries(await this.source.load(servers, abortSignal));
        return this.runSearch(query, max_results, server);
      },
    });
  }

  private addEntries(entries: readonly McpToolEntry[]): void {
    const added = new Set<string>();
    for (const entry of entries) {
      if (this.byName.has(entry.name)) continue;
      added.add(entry.name);
      this.index.push({
        entry,
        nameWords: new Set(words(`${entry.server} ${entry.toolName}`)),
        descriptionWords: new Set(words(entry.description)),
      });
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
    this.restore(this.history, added);
  }

  private searchServers(query: string, server?: string): string[] {
    const servers = this.source.servers;
    if (server !== undefined) {
      if (!servers.includes(server)) throw new Error(`Unknown MCP server: ${server}`);
      return [server];
    }
    if (!/^select:/i.test(query.trim())) return servers;
    const selected = query
      .trim()
      .slice('select:'.length)
      .split(',')
      .map((name) =>
        [...servers]
          .sort((a, b) => b.length - a.length)
          .find((configured) => name.trim().startsWith(mcpToolPrefix(configured))),
      );
    return selected.length && selected.every((name) => name !== undefined) ? [...new Set(selected)] : servers;
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
    return [
      '## External tools (load on demand)',
      '',
      `Tools from the MCP servers below are not loaded yet. Before using one, call \`${TOOL_SEARCH}\``,
      'with keywords for the task or `select:<name>` for exact names from this catalog; matching',
      'tools become callable on your next step. Never claim to have used a tool you did not call.',
      '',
      'Servers below are configured but discovered only when searched; undiscovered does not mean unavailable.',
      'Use the optional server argument for a targeted search. Discovery failures are tool errors, not empty catalogs.',
      'After a restart, search again before calling an external tool from history.',
      '',
      ...this.source.servers.map(
        (server) => `- **${server}** (discover on demand, prefix \`${mcpToolPrefix(server)}\`)`,
      ),
    ].join('\n');
  }

  search(query: string, limit = DEFAULT_RESULTS, server?: string): McpToolEntry[] {
    const max = Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_RESULTS)));
    const trimmed = query.trim();
    if (/^select:/i.test(trimmed)) {
      const selected = trimmed
        .slice('select:'.length)
        .split(',')
        .map((name) => this.resolve(name.trim()))
        .filter((entry): entry is McpToolEntry => !!entry && (!server || entry.server === server));
      return [...new Set(selected)].slice(0, MAX_LOADED);
    }
    const terms = words(trimmed);
    if (terms.length === 0) return [];
    return this.index
      .filter((item) => !server || item.entry.server === server)
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
    const name =
      entry?.name ??
      (this.source.servers.some((server) => toolCall.toolName.startsWith(mcpToolPrefix(server)))
        ? toolCall.toolName
        : undefined);
    if (!name) return null;
    return { ...toolCall, toolName: TOOL_SEARCH, input: JSON.stringify({ query: `select:${name}` }) };
  };

  private runSearch(query: string, limit: number | undefined, server?: string): SearchOutput {
    const matches = this.search(query, limit, server);
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
    if (name.startsWith('mcp__')) return undefined;
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

  private restore(history: readonly ModelMessage[], added: Set<string>): void {
    for (const message of history) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === 'tool-call' && added.has(part.toolName)) this.touch(part.toolName);
        if (part.type === 'tool-result' && part.toolName === TOOL_SEARCH) {
          for (const name of loadedFromResult(part.output)) if (added.has(name)) this.touch(name);
        }
      }
    }
  }
}
