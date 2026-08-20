import fs from 'fs';
import path from 'path';
import { log } from './log.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/** Resolve one var from the process environment first, then `.env`. */
function envValue(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  return readEnvFile([name])[name];
}

/** Fleet-wide default agent provider. */
export function defaultProvider(): string {
  return envValue('DEFAULT_PROVIDER') || 'claude';
}

/** Env var carrying the fleet default model for `provider`. */
export function defaultModelEnvKey(provider: string): string {
  return `DEFAULT_MODEL_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Fleet default model for `provider`, or undefined when none applies.
 *
 * Model ids are provider-specific — `minimax/MiniMax-M3` is meaningless to
 * claude — so `DEFAULT_MODEL_<PROVIDER>` wins, and the unsuffixed
 * `DEFAULT_MODEL` is treated as the default for `DEFAULT_PROVIDER` only.
 * Letting it apply fleet-wide just moves the failure to container start.
 */
export function resolveDefaultModel(provider: string | null | undefined): string | undefined {
  const name = provider || defaultProvider();
  const scoped = envValue(defaultModelEnvKey(name));
  if (scoped) return scoped;
  return name === defaultProvider() ? envValue('DEFAULT_MODEL') || undefined : undefined;
}
