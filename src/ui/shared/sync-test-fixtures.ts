import type { GlobalSnapshot, GlobalSyncState } from './sync.js';

export function testGlobalSnapshot(
  data: Omit<GlobalSyncState, 'agentActivity'> & Partial<Pick<GlobalSyncState, 'agentActivity'>>,
  streamId = 'test-global',
  revision = 0,
): GlobalSnapshot {
  return { kind: 'snapshot', streamId, revision, data: { agentActivity: [], ...data } };
}
