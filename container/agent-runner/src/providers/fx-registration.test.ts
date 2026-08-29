import { expect, test } from 'bun:test';

import { listProviderNames } from './provider-registry.js';

// Loads through the real barrel so this goes red if the `./fx.js` entry in
// OPTIONAL_PROVIDER_MODULES is removed or fails to evaluate.
test('fx registers through the provider barrel', async () => {
  const { loadProvider } = await import('./index.js');
  await loadProvider('fx');
  expect(listProviderNames()).toContain('fx');
});
