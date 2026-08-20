// Provider self-registration barrel.
// Each entry is loaded dynamically so a missing optional runtime dep (e.g.
// the provider's SDK isn't installed in this image) logs a warning and
// skips that provider instead of crashing agent-runner at startup. Skills
// add a new provider by appending to OPTIONAL_PROVIDER_MODULES below.
//
// `claude` and `mock` are always required — failures there are fatal.

import { recordSkippedProvider } from './provider-registry.js';

const REQUIRED_PROVIDER_MODULES = ['./claude.js', './mock.js'] as const;
const OPTIONAL_PROVIDER_MODULES = ['./opencode.js', './fx.js'] as const;

for (const mod of REQUIRED_PROVIDER_MODULES) {
  await import(mod);
}

for (const mod of OPTIONAL_PROVIDER_MODULES) {
  try {
    await import(mod);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract provider name from module path (e.g. './opencode.js' -> 'opencode')
    const name = mod.replace(/^\.\//, '').replace(/\.js$/, '');
    recordSkippedProvider(name, msg);
    console.error(`[providers] Skipping ${mod}: ${msg}`);
  }
}
