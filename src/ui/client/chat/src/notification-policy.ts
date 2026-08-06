export type NotificationPermissionState = NotificationPermission | 'unsupported';

export function shouldAutoSubscribe(muted: boolean, permission: NotificationPermissionState): boolean {
  return !muted && permission === 'granted';
}

export function notificationStatus(muted: boolean, permission: NotificationPermissionState): string {
  if (permission === 'unsupported') return 'Browser notifications are not supported on this device.';
  if (permission === 'denied') return 'Blocked by the browser. Allow notifications in site settings to enable them.';
  if (muted) return 'Off. Enabling will ask the browser for permission.';
  return 'Enabled for new messages.';
}
