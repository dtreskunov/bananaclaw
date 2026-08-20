/**
 * Host-side container config for the `fx` provider.
 *
 * fx keeps auth/settings/session state under $HOME/.fx. It has no knob to
 * relocate that — the released binary contains no FX_STATE_DIR string at all —
 * so we mount a per-session host directory directly over ~/.fx. Mounting it
 * anywhere else silently loses state when the container exits, which shows up
 * as "Session not found" on the next turn after a restart.
 *
 * Credentials: the fx binary honours no proxy or custom-CA env vars, so
 * OneCLI's transparent HTTPS proxy cannot intercept it. Instead fx is pointed
 * at a loopback shim via the two gateway knobs it reads:
 *   - FX_GATEWAY_BASE_URL — model catalog + credits (/coding-agent/v1/*)
 *   - FX_GATEWAY_CHAT_URL — inference
 * Both must be set: redirecting only the base URL still sends inference to the
 * real gateway. NO_PROXY must cover loopback — OneCLI sets HTTP_PROXY and
 * NODE_USE_ENV_PROXY, and Bun otherwise routes even 127.0.0.1 requests at the
 * proxy, which resets them. OneCLI itself sets no NO_PROXY, so this value
 * survives its later --env flags.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { cloneFxSessionState } from './fx-fork-snapshot.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const FX_ENV_KEYS = [
  'FX_MODEL',
  'FX_GATEWAY_BASE_URL',
  'FX_GATEWAY_CHAT_URL',
  'FX_MAX_AGENT_STEPS',
  'AI_GATEWAY_API_KEY',
] as const;

/** fx hardcodes its state location to $HOME/.fx; the container runs as `node`. */
export const FX_HOME_STATE_PATH = '/home/node/.fx';

function mergeNoProxy(current: string | undefined, additions: string): string {
  const parts = new Set(
    (current ?? '')
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
  'fx',
  (ctx) => {
    const stateDir = path.join(ctx.sessionDir, 'fx-state');
    fs.mkdirSync(stateDir, { recursive: true });

    const noProxyAdditions = '127.0.0.1,localhost';
    const env: Record<string, string> = {
      // fx self-updates by default; in a pinned image that would swap the binary
      // out from under the build and break reproducibility.
      FX_AUTO_UPGRADE: '0',
      NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, noProxyAdditions),
      no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, noProxyAdditions),
    };

    for (const key of FX_ENV_KEYS) {
      const value = ctx.hostEnv[key];
      if (value) env[key] = value;
    }

    // The service unit doesn't load .env, so process.env may be missing these
    // even when they're configured.
    const fromFile = readEnvFile([...FX_ENV_KEYS]);
    for (const [key, value] of Object.entries(fromFile)) {
      if (value && env[key] === undefined) env[key] = value;
    }

    // Per-group model override from container config wins over the fleet default.
    if (ctx.containerConfig.model) {
      env.FX_MODEL = ctx.containerConfig.model;
    }

    return {
      mounts: [{ hostPath: stateDir, containerPath: FX_HOME_STATE_PATH, readonly: false }],
      env,
    };
  },
  { forkSessionState: cloneFxSessionState },
);
