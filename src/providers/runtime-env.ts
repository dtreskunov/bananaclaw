import { readEnvFile } from '../env.js';
import type { ProviderContainerContext } from './provider-container-registry.js';

export function providerRuntimeEnv(
  provider: 'native' | 'opencode' | 'claude',
  hostEnv: NodeJS.ProcessEnv,
  config: ProviderContainerContext['containerConfig'] = {},
): Record<string, string> {
  const keys =
    provider === 'native'
      ? ['NATIVE_BASE_URL', 'NATIVE_MODEL', 'NATIVE_PROTOCOL']
      : provider === 'opencode'
        ? [
            'OPENCODE_PROVIDER',
            'OPENCODE_BASE_URL',
            'OPENCODE_MODEL',
            'OPENCODE_SMALL_MODEL',
            'OPENCODE_IDLE_TIMEOUT_MS',
          ]
        : ['ANTHROPIC_BASE_URL'];
  const file = readEnvFile(keys);
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value =
      provider === 'claude'
        ? file[key]
        : provider === 'native'
          ? (hostEnv[key] ?? file[key])
          : hostEnv[key] || file[key];
    if (value) env[key] = value;
  }
  if (provider === 'claude' && env.ANTHROPIC_BASE_URL) env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  if (provider === 'opencode') {
    if (config.model) env.OPENCODE_MODEL = config.model;
    if (config.smallModel) env.OPENCODE_SMALL_MODEL = config.smallModel;
    // A group upstream must not inherit another gateway's base URL or small model.
    if (config.upstreamProvider) {
      env.OPENCODE_PROVIDER = config.upstreamProvider;
      delete env.OPENCODE_BASE_URL;
      if (!config.smallModel) delete env.OPENCODE_SMALL_MODEL;
    }
  }
  return env;
}
