import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { defaultModelEnvKey, resolveDefaultModel } from './env.js';

// These read process.env first and the .env file second. Every var the
// resolver consults is set explicitly (empty string = "configured as unset")
// so the assertions describe the precedence rules, not the developer's .env.
const VARS = [
  'DEFAULT_PROVIDER',
  'DEFAULT_MODEL',
  'DEFAULT_MODEL_OPENCODE',
  'DEFAULT_MODEL_CLAUDE',
  'DEFAULT_MODEL_FX',
];

describe('resolveDefaultModel', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    for (const k of VARS) process.env[k] = '';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('prefers the provider-scoped default over the unsuffixed one', () => {
    process.env.DEFAULT_PROVIDER = 'opencode';
    process.env.DEFAULT_MODEL = 'minimax/MiniMax-M3';
    process.env.DEFAULT_MODEL_OPENCODE = 'openrouter/some-model';
    expect(resolveDefaultModel('opencode')).toBe('openrouter/some-model');
  });

  it('applies the unsuffixed default to the default provider', () => {
    process.env.DEFAULT_PROVIDER = 'opencode';
    process.env.DEFAULT_MODEL = 'minimax/MiniMax-M3';
    expect(resolveDefaultModel('opencode')).toBe('minimax/MiniMax-M3');
  });

  // The point of the change: an opencode model id handed to claude is not a
  // default, it is a container that fails to start.
  it('does not leak the unsuffixed default to other providers', () => {
    process.env.DEFAULT_PROVIDER = 'opencode';
    process.env.DEFAULT_MODEL = 'minimax/MiniMax-M3';
    expect(resolveDefaultModel('claude')).toBeUndefined();
    expect(resolveDefaultModel('fx')).toBeUndefined();
  });

  it('gives each provider its own scoped default', () => {
    process.env.DEFAULT_PROVIDER = 'opencode';
    process.env.DEFAULT_MODEL_OPENCODE = 'minimax/MiniMax-M3';
    process.env.DEFAULT_MODEL_CLAUDE = 'claude-sonnet-4-5';
    expect(resolveDefaultModel('opencode')).toBe('minimax/MiniMax-M3');
    expect(resolveDefaultModel('claude')).toBe('claude-sonnet-4-5');
  });

  it('falls back to the default provider when none is supplied', () => {
    process.env.DEFAULT_PROVIDER = 'claude';
    process.env.DEFAULT_MODEL = 'claude-sonnet-4-5';
    expect(resolveDefaultModel(null)).toBe('claude-sonnet-4-5');
    expect(resolveDefaultModel(undefined)).toBe('claude-sonnet-4-5');
  });

  it('returns undefined when nothing is configured', () => {
    process.env.DEFAULT_PROVIDER = 'opencode';
    expect(resolveDefaultModel('opencode')).toBeUndefined();
  });
});

describe('defaultModelEnvKey', () => {
  it('upper-cases and sanitizes the provider name', () => {
    expect(defaultModelEnvKey('opencode')).toBe('DEFAULT_MODEL_OPENCODE');
    expect(defaultModelEnvKey('open-code.v2')).toBe('DEFAULT_MODEL_OPEN_CODE_V2');
  });
});
