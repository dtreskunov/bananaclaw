import { describe, expect, it } from 'vitest';

import { buildHistoryUrl } from './history-url';

describe('historyUrl', () => {
  it('includes the owning messaging group for a web thread', () => {
    expect(buildHistoryUrl('group-1', 'thread-1', 'web', 'mg-web-other-user')).toBe(
      'api/groups/group-1/chat/thread-1/history?channel=web&mg=mg-web-other-user',
    );
  });
});
