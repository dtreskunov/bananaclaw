import type { GlobalSnapshot, GlobalSyncState } from './sync.js';

export function testGlobalSnapshot(data: GlobalSyncState, streamId = 'test-global', revision = 0): GlobalSnapshot {
  return { kind: 'snapshot', streamId, revision, data };
}
