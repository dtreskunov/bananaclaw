import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ file: {} as Record<string, string> }));
vi.mock('../../env.js', () => ({ readEnvFile: () => config.file }));
vi.mock('./server.js', () => {
  throw new Error('UI configuration must not load HTTP startup');
});
import { isUiEnabled, readUiConfig, uiBaseUrl } from './config.js';

afterEach(() => {
  config.file = {};
  vi.unstubAllEnvs();
});

describe('UI configuration without HTTP startup', () => {
  it('keeps strict boolean flags and process-over-file precedence', () => {
    config.file = { UI_ENABLED: 'true', UI_SECURE: 'true' };
    vi.stubEnv('UI_ENABLED', '');
    vi.stubEnv('UI_SECURE', '');
    expect(readUiConfig()).toEqual({ enabled: true, secure: true });
    vi.stubEnv('UI_ENABLED', 'false');
    vi.stubEnv('UI_SECURE', '1');
    expect(isUiEnabled()).toBe(false);
    expect(readUiConfig().secure).toBe(false);
  });

  it('keeps explicit URL precedence and removes exactly one trailing slash', () => {
    config.file = { UI_BASE_URL: 'https://file.example/ui/' };
    vi.stubEnv('UI_BASE_URL', '');
    expect(uiBaseUrl()).toBe('https://file.example/ui');
    vi.stubEnv('UI_BASE_URL', 'https://process.example/custom//');
    expect(uiBaseUrl()).toBe('https://process.example/custom/');
  });

  it('keeps process, file and default port fallbacks', () => {
    config.file = { WEBHOOK_PORT: '4100' };
    vi.stubEnv('UI_BASE_URL', '');
    vi.stubEnv('WEBHOOK_PORT', '');
    expect(uiBaseUrl()).toBe('http://localhost:4100/ui');
    vi.stubEnv('WEBHOOK_PORT', '4200');
    expect(uiBaseUrl()).toBe('http://localhost:4200/ui');
    config.file = {};
    vi.stubEnv('WEBHOOK_PORT', '');
    expect(uiBaseUrl()).toBe('http://localhost:3000/ui');
  });
});
