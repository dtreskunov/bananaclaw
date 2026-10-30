import { afterEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ loads: 0, agentVault: true }));
vi.mock('@onecli-sh/sdk', () => {
  sdk.loads++;
  throw new Error('OneCLI SDK is unavailable in this AgentVault-only installation');
});
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  ONECLI_URL: undefined,
  ONECLI_API_KEY: undefined,
  ONECLI_NEW_AGENT_SECRET_IDS: [],
}));
vi.mock('./db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/sessions.js')>()),
  getPendingApprovalsByAction: vi.fn().mockReturnValue([]),
}));
vi.mock('./agent-vault-egress.js', () => ({
  usesAgentVault: () => sdk.agentVault,
  agentVaultEnvKeys: () => new Set(['HTTPS_PROXY']),
  applyAgentVaultEgress: vi.fn(async (args: string[]) => {
    args.push('-e', 'NANOCLAW_EGRESS_SOCKET=/run/egress.sock');
  }),
  releaseAgentVaultEgress: vi.fn(),
}));
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  isRootlessPodman: () => false,
  hostGatewayArgs: () => [],
}));
vi.mock('./egress-lockdown.js', () => ({ ensureEgressNetwork: () => false }));
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
afterEach(() => {
  sdk.agentVault = true;
  vi.unstubAllGlobals();
});

describe('AgentVault runtime independence', () => {
  it('loads the runner and starts approvals without an installed OneCLI SDK or config', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected network request'));
    vi.stubGlobal('fetch', fetch);
    const { buildContainerArgs } = await import('./container-runner.js');
    const approvals = await import('./modules/approvals/onecli-approvals.js');
    await approvals.startOneCLIApprovalHandler({ deliver: vi.fn() });
    const args = await buildContainerArgs(
      [],
      'test-agent',
      {
        id: 'group',
        name: 'Group',
        folder: 'group',
        agent_provider: null,
        created_at: new Date().toISOString(),
      },
      { mcpServers: {}, packages: { apt: [], npm: [], pip: [] }, additionalMounts: [], skills: [], disabledSkills: [] },
      'native',
      { env: { HTTPS_PROXY: 'legacy-proxy-must-not-leak' } },
      'group',
      'session',
      'mcp-probe',
    );
    expect(args).toContain('--network=none');
    expect(args).toContain('NANOCLAW_EGRESS_SOCKET=/run/egress.sock');
    expect(args).not.toContain('legacy-proxy-must-not-leak');
    expect(sdk.loads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    approvals.stopOneCLIApprovalHandler();
  });
  it('fails closed for a legacy container without loading an unconfigured cloud client', async () => {
    sdk.agentVault = false;
    const { buildContainerArgs } = await import('./container-runner.js');
    await expect(
      buildContainerArgs(
        [],
        'legacy',
        {
          id: 'legacy',
          name: 'Legacy',
          folder: 'legacy',
          agent_provider: null,
          created_at: new Date().toISOString(),
        },
        {
          mcpServers: {},
          packages: { apt: [], npm: [], pip: [] },
          additionalMounts: [],
          skills: [],
          disabledSkills: [],
        },
        'native',
        {},
        'legacy',
        'session',
        'mcp-probe',
      ),
    ).rejects.toThrow('migrate it to AgentVault');
    expect(sdk.loads).toBe(0);
  });
  it('can recover a legacy journal without either credential backend', async () => {
    sdk.agentVault = false;
    const { buildContainerArgs } = await import('./container-runner.js');
    const args = await buildContainerArgs(
      [],
      'recovery',
      {
        id: 'legacy',
        name: 'Legacy',
        folder: 'legacy',
        agent_provider: null,
        created_at: new Date().toISOString(),
      },
      { mcpServers: {}, packages: { apt: [], npm: [], pip: [] }, additionalMounts: [], skills: [], disabledSkills: [] },
      'native',
      {},
      'legacy',
      'session',
      'recovery',
    );
    expect(args).toContain('--network=none');
    expect(sdk.loads).toBe(0);
  });
});
