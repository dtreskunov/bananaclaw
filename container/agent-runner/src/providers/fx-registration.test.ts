import { expect, test } from 'bun:test';

import { listProviderNames } from './provider-registry.js';

// Imports the real barrel so this goes red if the `./fx.js` entry in
// OPTIONAL_PROVIDER_MODULES is removed or fails to evaluate.
test('fx registers through the provider barrel', async () => {
  await import('./index.js');
  expect(listProviderNames()).toContain('fx');
});
