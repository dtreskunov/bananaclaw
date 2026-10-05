import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFile } = vi.hoisted(() => ({
  readEnvFile: vi.fn<(keys: string[]) => Record<string, string>>(),
}));

vi.mock('./env.js', () => ({ readEnvFile }));

describe('container resource limit config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('CONTAINER_MEMORY_LIMIT', undefined);
    vi.stubEnv('CONTAINER_CPU_LIMIT', undefined);
    readEnvFile.mockReset();
    readEnvFile.mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 1536m memory and 2 CPUs', async () => {
    const config = await import('./config.js');
    expect(config.CONTAINER_MEMORY_LIMIT).toBe('1536m');
    expect(config.CONTAINER_CPU_LIMIT).toBe('2');
  });

  it('reads both resource caps from .env and trims them', async () => {
    readEnvFile.mockImplementation((keys) => {
      const values: Record<string, string> = {
        CONTAINER_MEMORY_LIMIT: ' 2g ',
        CONTAINER_CPU_LIMIT: ' 1.5 ',
      };
      return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]]));
    });
    const config = await import('./config.js');
    expect(config.CONTAINER_MEMORY_LIMIT).toBe('2g');
    expect(config.CONTAINER_CPU_LIMIT).toBe('1.5');
  });

  it('prefers process.env over .env and trims values', async () => {
    readEnvFile.mockReturnValue({
      CONTAINER_MEMORY_LIMIT: '2g',
      CONTAINER_CPU_LIMIT: '1.5',
    });
    vi.stubEnv('CONTAINER_MEMORY_LIMIT', ' 512m ');
    vi.stubEnv('CONTAINER_CPU_LIMIT', ' 0.5 ');
    const config = await import('./config.js');
    expect(config.CONTAINER_MEMORY_LIMIT).toBe('512m');
    expect(config.CONTAINER_CPU_LIMIT).toBe('0.5');
  });

  it.each(['file', 'process'])('preserves "0" opt-outs from the %s environment', async (source) => {
    if (source === 'file') {
      readEnvFile.mockReturnValue({
        CONTAINER_MEMORY_LIMIT: '0',
        CONTAINER_CPU_LIMIT: '0',
      });
    } else {
      vi.stubEnv('CONTAINER_MEMORY_LIMIT', '0');
      vi.stubEnv('CONTAINER_CPU_LIMIT', '0');
    }
    const config = await import('./config.js');
    expect(config.CONTAINER_MEMORY_LIMIT).toBe('0');
    expect(config.CONTAINER_CPU_LIMIT).toBe('0');
  });
});
