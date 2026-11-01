import { afterEach, describe, expect, it, vi } from 'vitest';

const egress = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock('./agent-vault-egress.js', () => ({
  agentVaultEnvKeys: () => new Set(['HTTPS_PROXY', 'NO_PROXY']),
  applyAgentVaultEgress: egress.apply,
  releaseAgentVaultEgress: vi.fn(),
}));
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  isRootlessPodman: () => false,
}));
afterEach(() => {
  vi.resetAllMocks();
});

import { buildContainerArgs } from './container-runner.js';

const group = { id: 'g', name: 'Group', folder: 'group', agent_provider: null, created_at: 'created' };
const config = {
  mcpServers: {},
  packages: { apt: [], npm: [], pip: [] },
  additionalMounts: [],
  skills: [],
  disabledSkills: [],
};
describe('Agent Vault-only runtime', () => {
  it.each(['agent', 'mcp-probe'] as const)('isolates %s containers and reserves all gateway env', async (mode) => {
    egress.apply.mockImplementation(async (args: string[]) => {
      args.push('-e', 'HTTPS_PROXY=http://127.0.0.1:3128');
    });
    const args = await buildContainerArgs(
      [],
      'container',
      group,
      config,
      'native',
      { env: { HTTPS_PROXY: 'must-not-leak', NO_PROXY: '*', OTHER: 'keep' } },
      'session',
      mode,
    );
    expect(args).toContain('--network=none');
    expect(args).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    expect(args).not.toContain('must-not-leak');
    expect(args).not.toContain('NO_PROXY=*');
    expect(args).toContain('OTHER=keep');
    expect(egress.apply).toHaveBeenCalledWith(args, {
      containerName: 'container',
      agentGroupId: 'g',
      label: `${mode}:session`,
    });
  });
  it('fails closed when the gateway is unavailable', async () => {
    egress.apply.mockRejectedValue(new Error('gateway unavailable'));
    await expect(buildContainerArgs([], 'container', group, config, 'native', {}, 'session')).rejects.toThrow(
      'gateway unavailable',
    );
  });
  it('recovers durable journals without provisioning gateway access', async () => {
    const args = await buildContainerArgs([], 'container', group, config, 'native', {}, 'session', 'recovery');
    expect(args).toContain('--network=none');
    expect(args.at(-1)).toBe('exec bun run /app/src/recover-main.ts');
    expect(egress.apply).not.toHaveBeenCalled();
  });
});
