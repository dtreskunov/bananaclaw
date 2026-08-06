import { describe, expect, it } from 'vitest';

import { notificationStatus, shouldAutoSubscribe } from './notification-policy';

describe('notification policy', () => {
  it('auto-subscribes only when permission was already granted', () => {
    expect(shouldAutoSubscribe(false, 'granted')).toBe(true);
    expect(shouldAutoSubscribe(false, 'default')).toBe(false);
    expect(shouldAutoSubscribe(false, 'denied')).toBe(false);
    expect(shouldAutoSubscribe(true, 'granted')).toBe(false);
  });

  it('distinguishes disabled, blocked, and unsupported states', () => {
    expect(notificationStatus(true, 'default')).toContain('Enabling');
    expect(notificationStatus(true, 'denied')).toContain('Blocked');
    expect(notificationStatus(true, 'unsupported')).toContain('not supported');
    expect(notificationStatus(false, 'granted')).toContain('Enabled');
  });
});
