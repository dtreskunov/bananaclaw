import { log } from '../../../log.js';
import { getProviderContainerConfig } from '../../../providers/provider-container-registry.js';
import { providerRuntimeEnv } from '../../../providers/runtime-env.js';
import type { AccessRequirements } from '../../shared/access-authentication.js';
import { isNativeCompatible, modelEndpoint, resolveUpstreamForWireId } from './models-dev-catalog.js';

export async function getModelConnection(
  provider: string,
  wireId: string,
  upstreamProvider?: string | null,
): Promise<AccessRequirements | null> {
  if (provider !== 'native' && provider !== 'opencode' && provider !== 'claude') return null;
  let resolved = provider === 'opencode' ? await resolveUpstreamForWireId(wireId) : null;
  const env = providerRuntimeEnv(provider, process.env, {
    upstreamProvider: resolved?.upstream ?? upstreamProvider ?? undefined,
  });
  const nativeOverride = env.NATIVE_BASE_URL;
  if (provider === 'native' && !nativeOverride) {
    resolved = await resolveUpstreamForWireId(wireId);
    if (!resolved) return null;
  }
  const upstream = provider === 'claude' ? 'anthropic' : (resolved?.upstream ?? env.OPENCODE_PROVIDER ?? 'anthropic');
  const modelId = resolved?.modelId ?? (wireId.startsWith(`${upstream}/`) ? wireId.slice(upstream.length + 1) : wireId);
  const endpoint =
    provider === 'claude'
      ? { api: 'https://api.anthropic.com/v1', npm: '@ai-sdk/anthropic' }
      : nativeOverride
        ? null
        : await modelEndpoint(upstream, modelId);
  let baseURL = nativeOverride ?? env.OPENCODE_BASE_URL ?? endpoint?.api;
  let npm = endpoint?.npm ?? '@ai-sdk/openai-compatible';
  if (nativeOverride) {
    const protocol = env.NATIVE_PROTOCOL;
    if (protocol && protocol !== 'openai-chat' && protocol !== 'anthropic-messages')
      throw new Error(`Unsupported NATIVE_PROTOCOL: ${protocol}`);
    npm = protocol === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
  }
  const claudeOverride =
    provider === 'claude' && getProviderContainerConfig('claude') ? env.ANTHROPIC_BASE_URL : undefined;
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
