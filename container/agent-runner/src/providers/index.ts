// Provider self-registration barrel.
// Each entry is loaded dynamically so a missing optional runtime dep (e.g.
// the provider's SDK isn't installed in this image) logs a warning and
// skips that provider instead of crashing agent-runner at startup. Skills
// add a new provider by appending to OPTIONAL_PROVIDER_MODULES below.
//
// `claude` and `mock` are always required — failures there are fatal.
//
// Loading is on demand: provider SDKs are the largest single contributor to the
// runner's resident set (all of them together cost ~86MB over the Bun floor,
// versus ~10-70MB for any one), and a session only ever uses the provider named
// in its container config. `loadAllProviders()` stays available for tests and
// for the "registered providers" list in error messages.

import { recordSkippedProvider } from './provider-registry.js';

const REQUIRED_PROVIDER_MODULES = ['./claude.js', './mock.js'] as const;
const OPTIONAL_PROVIDER_MODULES = ['./opencode.js', './fx.js', './native.js'] as const;

/** './opencode.js' -> 'opencode' — module basenames are the provider names. */
function moduleName(mod: string): string {
  return mod.replace(/^\.\//, '').replace(/\.js$/, '');
}

const loaded = new Set<string>();

async function loadModule(mod: string, required: boolean): Promise<void> {
  if (loaded.has(mod)) return;
  loaded.add(mod);
  if (required) {
    await import(mod);
    return;
  }
  try {
    await import(mod);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSkippedProvider(moduleName(mod), msg);
    console.error(`[providers] Skipping ${mod}: ${msg}`);
  }
}

/**
 * Register just the named provider. Falls back to loading everything when the
 * name matches no module, so `createProvider` still fails with a complete list
 * of what is registered.
 */
export async function loadProvider(name: string): Promise<void> {
  const all: readonly string[] = [...REQUIRED_PROVIDER_MODULES, ...OPTIONAL_PROVIDER_MODULES];
  const mod = all.find((m) => moduleName(m) === name);
  if (!mod) {
    await loadAllProviders();
    return;
  }
  await loadModule(mod, (REQUIRED_PROVIDER_MODULES as readonly string[]).includes(mod));
}

export async function loadAllProviders(): Promise<void> {
  for (const mod of REQUIRED_PROVIDER_MODULES) await loadModule(mod, true);
  for (const mod of OPTIONAL_PROVIDER_MODULES) await loadModule(mod, false);
}
