import fs from 'node:fs';
import path from 'node:path';

import { providerRuntimeEnv } from './runtime-env.js';
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
    const env: Record<string, string> = {
      NO_PROXY: mergeNoProxy(context.hostEnv.NO_PROXY, '127.0.0.1,localhost,models.dev,.models.dev'),
      no_proxy: mergeNoProxy(context.hostEnv.no_proxy, '127.0.0.1,localhost,models.dev,.models.dev'),
      ...providerRuntimeEnv('native', context.hostEnv),
    };
    const stateDir = path.join(context.sessionDir, 'native-state');
    fs.mkdirSync(stateDir, { recursive: true });
    return {
      env,
      mounts: [{ hostPath: stateDir, containerPath: '/workspace/native-state', readonly: false }],
    };
  },
  { forkSessionState: cloneNativeSessionState },
);
