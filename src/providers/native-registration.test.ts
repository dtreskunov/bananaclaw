import { expect, test } from 'vitest';

import { listProviderContainerConfigNames } from './provider-container-registry.js';

test('native registers a host-side container config through the barrel', async () => {
  await import('./index.js');
  expect(listProviderContainerConfigNames()).toContain('native');
});
