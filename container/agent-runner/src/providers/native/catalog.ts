const MODELS_DEV_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 20_000;

const CHAT_PACKAGES = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
  '@ai-sdk/cerebras',
  '@ai-sdk/deepinfra',
  '@ai-sdk/groq',
  '@ai-sdk/mistral',
  '@ai-sdk/togetherai',
  '@ai-sdk/xai',
  '@openrouter/ai-sdk-provider',
  'ai-gateway-provider',
]);
const ANTHROPIC_PACKAGES = new Set(['@ai-sdk/anthropic']);

export type NativeProtocol = 'openai-chat' | 'anthropic-messages';

export function nativeProtocolForPackage(packageName: string): NativeProtocol | null {
  if (CHAT_PACKAGES.has(packageName)) return 'openai-chat';
  if (ANTHROPIC_PACKAGES.has(packageName)) return 'anthropic-messages';
  return null;
}

interface CatalogModel {
  id?: string;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  provider?: { npm?: string; api?: string };
}

interface CatalogProvider {
  id?: string;
  api?: string;
  npm?: string;
  models?: Record<string, CatalogModel>;
}

type Catalog = Record<string, CatalogProvider>;

export interface NativeModel {
  wireId: string;
  providerId: string;
  modelId: string;
  baseURL: string;
  protocol: NativeProtocol;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  inputModalities?: string[];
}

let cachedCatalog: Catalog | null = null;

function splitWireId(wireId: string): { providerId: string; modelId: string } {
  const slash = wireId.indexOf('/');
  if (slash <= 0 || slash === wireId.length - 1) {
    throw new Error(`Native model must be a canonical <provider>/<model-id> value (got: ${wireId})`);
  }
  return { providerId: wireId.slice(0, slash), modelId: wireId.slice(slash + 1) };
}

async function catalog(): Promise<Catalog> {
  if (cachedCatalog) return cachedCatalog;
  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  cachedCatalog = (await response.json()) as Catalog;
  return cachedCatalog;
}

export async function resolveNativeModel(wireId: string): Promise<NativeModel> {
  const { providerId, modelId } = splitWireId(wireId);
  const explicitBaseURL = process.env.NATIVE_BASE_URL?.replace(/\/+$/, '');
  if (explicitBaseURL) {
    const explicitProtocol = process.env.NATIVE_PROTOCOL;
    if (explicitProtocol && explicitProtocol !== 'openai-chat' && explicitProtocol !== 'anthropic-messages') {
      throw new Error(`Unsupported NATIVE_PROTOCOL: ${explicitProtocol}`);
    }
    const protocol: NativeProtocol = explicitProtocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
    return {
      wireId,
      providerId,
      modelId,
      baseURL: explicitBaseURL,
      protocol,
    };
  }

  const provider = (await catalog())[providerId];
  const model = provider?.models?.[modelId];
  if (!provider || !model) throw new Error(`Model ${wireId} was not found in models.dev`);
  if (model.tool_call === false || !model.modalities?.output?.includes('text')) {
    throw new Error(`Model ${wireId} does not support the text/tool surface required by native`);
  }

  const packageName = model.provider?.npm ?? provider.npm ?? '@ai-sdk/openai-compatible';
  const protocol = nativeProtocolForPackage(packageName);
  if (!protocol) {
    throw new Error(`Model ${wireId} uses unsupported protocol package ${packageName}`);
  }

  const baseURL = (model.provider?.api ?? provider.api)?.replace(/\/+$/, '');
  if (!baseURL || baseURL.includes('${')) {
    throw new Error(`Model ${wireId} has no directly callable Chat Completions endpoint`);
  }

  return {
    wireId,
    providerId,
    modelId: model.id ?? modelId,
    baseURL,
    protocol,
    contextWindow: model.limit?.context,
    maxOutputTokens: model.limit?.output,
    inputCostPerMTok: model.cost?.input,
    outputCostPerMTok: model.cost?.output,
    inputModalities: model.modalities?.input,
  };
}

export function clearNativeCatalogForTest(): void {
  cachedCatalog = null;
}
