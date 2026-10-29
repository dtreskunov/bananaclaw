/**
 * Static credential input and source-migration metadata validation.
 */
import { isManagedKey, queryPlaceholder, type DestinationDto, type InjectionDto } from './gateway-credentials.js';

/** Invalid input or a missing/duplicate key; `status` is the HTTP status to answer with. */
export class KeyInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface KeyPreset {
  id: string;
  label: string;
  key: string;
  destination: DestinationDto;
  obtainUrl?: string;
  hint?: string;
}

export const KEY_PRESETS: KeyPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    key: 'OPENROUTER_API_KEY',
    destination: { match: 'openrouter.ai', injection: { type: 'bearer' } },
    obtainUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    key: 'ANTHROPIC_API_KEY',
    destination: { match: 'api.anthropic.com', injection: { type: 'api-key', name: 'x-api-key' } },
    obtainUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    key: 'OPENAI_API_KEY',
    destination: { match: 'api.openai.com', injection: { type: 'bearer' } },
    obtainUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'github',
    label: 'GitHub',
    key: 'GITHUB_TOKEN',
    destination: { match: 'api.github.com', injection: { type: 'bearer' } },
    hint: 'Use a fine-grained token limited to the repositories the agent needs.',
    obtainUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    key: 'BRAVE_API_KEY',
    destination: { match: 'api.search.brave.com', injection: { type: 'api-key', name: 'X-Subscription-Token' } },
    obtainUrl: 'https://api-dashboard.search.brave.com/app/keys',
  },
  {
    id: 'tavily',
    label: 'Tavily (MCP)',
    key: 'TAVILY_API_KEY',
    destination: { match: 'mcp.tavily.com', injection: { type: 'query', name: queryPlaceholder('TAVILY_API_KEY') } },
    hint: 'Use https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__ as the MCP server URL.',
  },
  {
    id: 'notion',
    label: 'Notion (API)',
    key: 'NOTION_TOKEN',
    destination: { match: 'api.notion.com', injection: { type: 'bearer' } },
  },
];

const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_VALUE_BYTES = 16 * 1024;
const MATCH_RE = /^(\*\.)?[A-Za-z0-9.-]+(:\d{1,5})?(\/\S*)?$/;
const INJECTION_TYPES = new Set(['bearer', 'basic', 'api-key', 'query', 'custom']);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

export function checkKeyName(key: unknown): string {
  if (typeof key !== 'string' || !KEY_NAME_RE.test(key)) {
    throw new KeyInputError(
      'Key names are 2-64 characters: capital letters, digits and underscores, starting with a letter',
    );
  }
  if (isManagedKey(key)) throw new KeyInputError('Names starting with MCP_ or OAUTH_ are reserved for sign-ins');
  return key;
}

export function checkValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new KeyInputError('A value is required');
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new KeyInputError('The value is too long');
  if (/[\r\n\0]/.test(value)) throw new KeyInputError("The value can't contain line breaks");
  return value;
}

export function checkDestination(raw: unknown, key: string): DestinationDto {
  const d = raw as { match?: unknown; injection?: Partial<InjectionDto> } | null;
  const match = typeof d?.match === 'string' ? d.match.trim() : '';
  if (!MATCH_RE.test(match)) {
    throw new KeyInputError('Enter a host, optionally with a port and path, e.g. api.example.com/v1/*');
  }
  const i = d?.injection;
  if (!i || typeof i.type !== 'string' || !INJECTION_TYPES.has(i.type)) {
    throw new KeyInputError('Choose how the key is sent');
  }
  const injection: InjectionDto = { type: i.type };
  if (typeof i.name === 'string' && i.name.trim()) injection.name = i.name.trim();
  if (typeof i.prefix === 'string' && i.prefix) injection.prefix = i.prefix;
  if (typeof i.template === 'string' && i.template) injection.template = i.template;
  if (injection.type === 'api-key' && !HEADER_NAME_RE.test(injection.name ?? '')) {
    throw new KeyInputError('Enter a valid header name');
  }
  if (injection.type === 'custom') {
    if (injection.name && !HEADER_NAME_RE.test(injection.name)) throw new KeyInputError('Enter a valid header name');
    if (!injection.template?.match(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`))) {
      throw new KeyInputError(`The header must contain {{ ${key} }}`);
    }
  }
  if (injection.type === 'query' && !injection.name) injection.name = queryPlaceholder(key);
  return { match, injection };
}
