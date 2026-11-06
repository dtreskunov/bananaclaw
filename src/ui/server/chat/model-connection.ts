import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import { getProviderContainerConfig } from '../../../providers/provider-container-registry.js';
import type { AccessRequirements } from '../../shared/access-authentication.js';
import { isNativeCompatible, modelEndpoint, resolveUpstreamForWireId } from './models-dev-catalog.js';

export async function getModelConnection(
  provider: string,
  wireId: string,
  upstreamProvider?: string | null,
): Promise<AccessRequirements | null> {
  if (!['native', 'opencode', 'claude'].includes(provider)) return null;
  const file = readEnvFile([
    'NATIVE_BASE_URL',
    'NATIVE_PROTOCOL',
    'OPENCODE_BASE_URL',
    'OPENCODE_PROVIDER',
    'ANTHROPIC_BASE_URL',
  ]);
  const env = (key: string) => process.env[key] ?? file[key];
  const nativeOverride = provider === 'native' ? env('NATIVE_BASE_URL') : undefined;
  const resolved = provider === 'claude' || nativeOverride ? null : await resolveUpstreamForWireId(wireId);
  if (provider === 'native' && !nativeOverride && !resolved) return null;
  const upstream =
    provider === 'claude'
      ? 'anthropic'
      : (resolved?.upstream ?? upstreamProvider ?? env('OPENCODE_PROVIDER') ?? 'anthropic');
  const modelId = resolved?.modelId ?? (wireId.startsWith(`${upstream}/`) ? wireId.slice(upstream.length + 1) : wireId);
  const endpoint =
    provider === 'claude'
      ? { api: 'https://api.anthropic.com/v1', npm: '@ai-sdk/anthropic' }
      : nativeOverride
        ? null
        : await modelEndpoint(upstream, modelId);
  let baseURL = nativeOverride ?? endpoint?.api;
  let npm = endpoint?.npm ?? '@ai-sdk/openai-compatible';
  if (nativeOverride) {
    const protocol = env('NATIVE_PROTOCOL');
    if (protocol && protocol !== 'openai-chat' && protocol !== 'anthropic-messages')
      throw new Error(`Unsupported NATIVE_PROTOCOL: ${protocol}`);
    npm = protocol === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
  }
  // Saving a catalog selection sets the group upstream, which drops OpenCode's fleet base URL.
  if (provider === 'opencode' && !resolved && !upstreamProvider) baseURL = env('OPENCODE_BASE_URL') || baseURL;
  const claudeOverride =
    provider === 'claude' && getProviderContainerConfig('claude') ? file.ANTHROPIC_BASE_URL : undefined;
  if (claudeOverride) baseURL = `${claudeOverride.replace(/\/+$/, '')}/v1`;
  if (!baseURL) return null;
  const url = URL.parse(baseURL);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    baseURL.includes('${')
  ) {
    log.warn('Model credential shortcut requires a concrete HTTPS endpoint', { provider });
    return null;
  }
  const anthropic = npm === '@ai-sdk/anthropic';
  if (!isNativeCompatible({ api: baseURL, npm }, {})) return null;
  return {
    resource_url: `${url.href.replace(/\/+$/, '')}/*`,
    authentication: anthropic && !claudeOverride ? { type: 'api-key', header: 'x-api-key' } : { type: 'bearer' },
  };
}
