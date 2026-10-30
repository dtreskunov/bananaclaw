import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  url: undefined as string | undefined,
  key: undefined as string | undefined,
  constructed: vi.fn(),
}));
vi.mock('./config.js', () => ({
  get ONECLI_URL() {
    return state.url;
  },
  get ONECLI_API_KEY() {
    return state.key;
  },
  ONECLI_NEW_AGENT_SECRET_IDS: [],
}));
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    constructor(options: { url?: string; apiKey?: string }) {
      state.constructed(options);
    }
  },
}));
vi.mock('./log.js', () => ({ log: { info: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  state.url = undefined;
  state.key = undefined;
  state.constructed.mockClear();
});

describe('optional legacy OneCLI client', () => {
  it('does not construct a client when the integration is absent', async () => {
    const module = await import('./onecli-agent.js');
    expect(module.isOneCliConfigured()).toBe(false);
    expect(() => module.getOneCliClient()).toThrow('not configured');
    expect(state.constructed).not.toHaveBeenCalled();
  });
  it.each(['url', 'key'] as const)(
    'rejects partial %s configuration instead of using cloud defaults',
    async (field) => {
      if (field === 'url') state.url = 'http://legacy.test';
      else state.key = 'test-key';
      const module = await import('./onecli-agent.js');
      expect(() => module.isOneCliConfigured()).toThrow('both ONECLI_URL and ONECLI_API_KEY');
      expect(() => module.getOneCliClient()).toThrow('no cloud fallback');
      expect(state.constructed).not.toHaveBeenCalled();
    },
  );
  it('initializes one explicitly configured client for concurrent legacy users', async () => {
    state.url = 'http://legacy.test';
    state.key = 'test-key';
    const module = await import('./onecli-agent.js');
    expect(state.constructed).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([module.getOneCliClient(), module.getOneCliClient()]);
    expect(first).toBe(second);
    expect(state.constructed).toHaveBeenCalledExactlyOnceWith({ url: 'http://legacy.test', apiKey: 'test-key' });
  });
});
