import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { cloneNativeSessionState } from './native-fork-snapshot.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  const values = new Set(
    (current ?? '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) values.add(addition);
  return [...values].join(',');
}

registerProviderContainerConfig(
  'native',
  (context) => {
    const fileEnv = readEnvFile(['NATIVE_BASE_URL', 'NATIVE_MODEL', 'NATIVE_PROTOCOL']);
    const env: Record<string, string> = {
      NO_PROXY: mergeNoProxy(context.hostEnv.NO_PROXY, '127.0.0.1,localhost,models.dev,.models.dev'),
      no_proxy: mergeNoProxy(context.hostEnv.no_proxy, '127.0.0.1,localhost,models.dev,.models.dev'),
    };
    for (const name of ['NATIVE_BASE_URL', 'NATIVE_MODEL', 'NATIVE_PROTOCOL'] as const) {
      const value = context.hostEnv[name] ?? fileEnv[name];
      if (value) env[name] = value;
    }
    return { env };
  },
  { forkSessionState: cloneNativeSessionState },
);
