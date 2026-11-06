/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by Agent Vault.
 */
import fs from 'fs';
import path from 'path';

import { providerRuntimeEnv } from './runtime-env.js';
import { cloneOpencodeSessionState } from './opencode-fork-snapshot.js';
import { repairOpencodeIdRollover } from './opencode-id-rollover.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig(
  'opencode',
  (ctx) => {
    const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
    fs.mkdirSync(opencodeDir, { recursive: true });

    // Safe here: the session's OpenCode server is not running yet.
    repairOpencodeIdRollover(opencodeDir);

    // models.dev hosts the public provider/model catalog OpenCode fetches at
    // boot. Route it around the Agent Vault proxy (which has no secret rule for it
    // and returns empty → "no providers found").
    const noProxyAdditions = '127.0.0.1,localhost,models.dev,.models.dev';
    const env: Record<string, string> = {
      XDG_DATA_HOME: '/opencode-xdg',
      NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, noProxyAdditions),
      no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, noProxyAdditions),
      ...providerRuntimeEnv('opencode', ctx.hostEnv, ctx.containerConfig),
    };

    return {
      mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
      env,
    };
  },
  { forkSessionState: cloneOpencodeSessionState },
);
