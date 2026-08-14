/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
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

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Safe here: the session's OpenCode server is not running yet.
  repairOpencodeIdRollover(opencodeDir);

  // models.dev hosts the public provider/model catalog OpenCode fetches at
  // boot. Route it around the OneCLI proxy (which has no secret rule for it
  // and returns empty → "no providers found").
  const noProxyAdditions = '127.0.0.1,localhost,models.dev,.models.dev';
  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, noProxyAdditions),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, noProxyAdditions),
  };
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_BASE_URL',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_IDLE_TIMEOUT_MS',
  ] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  // The systemd unit doesn't load .env, so process.env may be missing the
  // OPENCODE_* vars even though they're configured. Fill in from .env.
  const fromFile = readEnvFile([
    'OPENCODE_PROVIDER',
    'OPENCODE_BASE_URL',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_IDLE_TIMEOUT_MS',
  ]);
  for (const [key, value] of Object.entries(fromFile)) {
    if (value && env[key] === undefined) env[key] = value;
  }

  // Per-group model override from container config (highest priority).
  if (ctx.containerConfig.model) {
    env.OPENCODE_MODEL = ctx.containerConfig.model;
  }
  if (ctx.containerConfig.smallModel) {
    env.OPENCODE_SMALL_MODEL = ctx.containerConfig.smallModel;
  }

  // Per-group upstream override. The container reads OPENCODE_PROVIDER from
  // the environment, so overriding it here transparently reaches every call
  // site in the agent-runner with no container-side plumbing.
  //
  // Everything else in the fleet-wide OpenCode config describes the *default*
  // upstream, so it must not leak into a group that points elsewhere:
  //   - OPENCODE_BASE_URL names a different gateway's endpoint. Dropping it
  //     lets OpenCode's models.dev catalog supply the new provider's own API
  //     base.
  //   - OPENCODE_SMALL_MODEL carries the default upstream's wire prefix (e.g.
  //     `openrouter/deepseek/...`). The container sets
  //     `enabled_providers: [provider]`, so a small model belonging to a
  //     now-disabled provider would break compaction and summaries. Drop it
  //     unless the group named its own; OpenCode then falls back to the main
  //     model for those background tasks.
  if (ctx.containerConfig.upstreamProvider) {
    env.OPENCODE_PROVIDER = ctx.containerConfig.upstreamProvider;
    delete env.OPENCODE_BASE_URL;
    if (!ctx.containerConfig.smallModel) delete env.OPENCODE_SMALL_MODEL;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
