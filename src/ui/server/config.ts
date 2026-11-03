import { readEnvFile } from '../../env.js';

/** Path prefix every UI app lives under. Shared cookie path. */
export const UI_MOUNT_PREFIX = '/ui';

export function readUiConfig(): { enabled: boolean; secure: boolean } {
  const env = readEnvFile(['UI_ENABLED', 'UI_SECURE']);
  const enabled = (process.env.UI_ENABLED || env.UI_ENABLED) === 'true';
  const secure = (process.env.UI_SECURE || env.UI_SECURE) === 'true';
  return { enabled, secure };
}

export function isUiEnabled(): boolean {
  return readUiConfig().enabled;
}

/** Compute the external base URL used for magic-link URLs (ends in /ui, no trailing slash). */
export function uiBaseUrl(): string {
  const env = readEnvFile(['UI_BASE_URL', 'WEBHOOK_PORT']);
  const explicit = process.env.UI_BASE_URL || env.UI_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const port = process.env.WEBHOOK_PORT || env.WEBHOOK_PORT || '3000';
  return `http://localhost:${port}${UI_MOUNT_PREFIX}`;
}
