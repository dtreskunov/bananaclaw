import { expect, test } from 'vitest';

import { listProviderContainerConfigNames } from './provider-container-registry.js';

// Imports the real host barrel so this goes red if the `import './fx.js';` line
// in src/providers/index.ts is removed or that barrel stops evaluating.
test('fx registers a host-side container config through the barrel', async () => {
  await import('./index.js');
  expect(listProviderContainerConfigNames()).toContain('fx');
});
