import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { providerRuntimeEnv } from './runtime-env.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

const config = vi.hoisted(() => ({ file: {} as Record<string, string> }));
vi.mock('../env.js', () => ({ readEnvFile: () => config.file }));
beforeEach(() => {
  config.file = {};
});

describe('shared provider runtime environment', () => {
  it('preserves native process precedence and only forwards public settings', () => {
    config.file = {
      NATIVE_BASE_URL: 'https://file.test/v1',
      NATIVE_MODEL: 'file/model',
      NATIVE_PROTOCOL: 'openai-chat',
    };
    expect(
      providerRuntimeEnv('native', {
        NATIVE_BASE_URL: 'https://process.test/v1',
        NATIVE_MODEL: '',
        NATIVE_PROTOCOL: 'anthropic-messages',
        NVIDIA_API_KEY: 'PRIVATE_KEY',
        ANTHROPIC_AUTH_TOKEN: 'PRIVATE_TOKEN',
      }),
    ).toEqual({
      NATIVE_BASE_URL: 'https://process.test/v1',
      NATIVE_PROTOCOL: 'anthropic-messages',
    });
  });

  it('fills missing native settings from the file', () => {
    config.file = { NATIVE_BASE_URL: 'https://file.test/v1', NATIVE_MODEL: 'file/model' };
    expect(providerRuntimeEnv('native', {})).toEqual(config.file);
  });

  it('preserves OpenCode file fallback for empty process settings', () => {
    config.file = {
      OPENCODE_PROVIDER: 'nvidia',
      OPENCODE_BASE_URL: 'https://file.test/v1',
      OPENCODE_MODEL: 'nvidia/main',
      OPENCODE_SMALL_MODEL: 'nvidia/small',
      OPENCODE_IDLE_TIMEOUT_MS: '1000',
    };
    expect(
      providerRuntimeEnv('opencode', {
        OPENCODE_BASE_URL: '',
        OPENCODE_MODEL: 'nvidia/process',
        OPENCODE_API_KEY: 'PRIVATE_KEY',
      }),
    ).toEqual({ ...config.file, OPENCODE_MODEL: 'nvidia/process' });
  });

  it('drops another gateway endpoint and inherited small model when a group selects an upstream', () => {
    config.file = {
      OPENCODE_PROVIDER: 'old',
      OPENCODE_BASE_URL: 'https://old.test/v1',
      OPENCODE_MODEL: 'old/main',
      OPENCODE_SMALL_MODEL: 'old/small',
    };
    expect(providerRuntimeEnv('opencode', {}, { upstreamProvider: 'nvidia', model: 'nvidia/main' })).toEqual({
      OPENCODE_PROVIDER: 'nvidia',
      OPENCODE_MODEL: 'nvidia/main',
    });
    expect(
      providerRuntimeEnv(
        'opencode',
        {},
        {
          upstreamProvider: 'nvidia',
          model: 'nvidia/main',
          smallModel: 'nvidia/small',
        },
      ),
    ).toEqual({ OPENCODE_PROVIDER: 'nvidia', OPENCODE_MODEL: 'nvidia/main', OPENCODE_SMALL_MODEL: 'nvidia/small' });
  });

  it('preserves Claude file-only endpoint configuration and never forwards a real token', () => {
    const host = { ANTHROPIC_BASE_URL: 'https://process.test', ANTHROPIC_AUTH_TOKEN: 'PRIVATE_TOKEN' };
    expect(providerRuntimeEnv('claude', host)).toEqual({});
    config.file = { ANTHROPIC_BASE_URL: 'https://file.test/anthropic' };
    expect(providerRuntimeEnv('claude', host)).toEqual({
      ANTHROPIC_BASE_URL: 'https://file.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
  });

  it.each(['native', 'opencode'] as const)(
    'wires shared rules through the registered %s container setup',
    async (provider) => {
      await import('./index.js');
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-provider-env-'));
      try {
        config.file = { NATIVE_BASE_URL: 'https://native.test/v1', OPENCODE_BASE_URL: 'https://old.test/v1' };
        const setup = getProviderContainerConfig(provider);
        if (!setup) throw new Error(`Missing ${provider} container setup`);
        const env = setup({
          sessionDir: directory,
          agentGroupId: 'test',
          groupDir: directory,
          selectedSkills: [],
          hostEnv: { NVIDIA_API_KEY: 'PRIVATE_KEY' },
          containerConfig: { model: 'nvidia/main', upstreamProvider: 'nvidia' },
        }).env;
        if (provider === 'native') expect(env).toMatchObject({ NATIVE_BASE_URL: 'https://native.test/v1' });
        else {
          expect(env).toMatchObject({ OPENCODE_PROVIDER: 'nvidia', OPENCODE_MODEL: 'nvidia/main' });
          expect(env).not.toHaveProperty('OPENCODE_BASE_URL');
        }
        expect(env).not.toHaveProperty('NVIDIA_API_KEY');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('wires shared rules through the optional Claude container setup', async () => {
    await import('./claude.js');
    config.file = { ANTHROPIC_BASE_URL: 'https://custom.test' };
    const setup = getProviderContainerConfig('claude');
    if (!setup) throw new Error('Missing Claude container setup');
    expect(
      setup({
        sessionDir: '',
        agentGroupId: 'test',
        groupDir: '',
        selectedSkills: [],
        hostEnv: {},
        containerConfig: {},
      }),
    ).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://custom.test', ANTHROPIC_AUTH_TOKEN: 'placeholder' } });
  });
});
