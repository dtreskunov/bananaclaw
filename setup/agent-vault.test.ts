import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ mode: 0o100600, bytes: Buffer.from('reviewed-binary'), gateway: vi.fn() }));
vi.mock('node:fs', () => ({ default: { readFileSync: () => state.bytes, statSync: () => ({ mode: state.mode }) } }));
vi.mock('./agent-vault-release.js', async () => {
  const { createHash } = await import('node:crypto');
  return {
    gatewayRelease: () => ({
      version: 'reviewed',
      sha256: createHash('sha256').update('reviewed-binary').digest('hex'),
    }),
  };
});
vi.mock('../src/modules/credentials/agent-vault-client.js', () => ({
  gatewayJson: state.gateway,
  gatewaySettings: () => ({ tokenFile: '/private/host-token' }),
}));
import { verifyAgentVault } from './agent-vault.js';
beforeEach(() => {
  state.mode = 0o100600;
  state.bytes = Buffer.from('reviewed-binary');
  vi.resetAllMocks();
});
it('checks reviewed bytes, token protection and the socket-session API without provisioning', async () => {
  await verifyAgentVault();
  expect(state.gateway).toHaveBeenCalledWith('GET', '/v1/socket-sessions', expect.any(String));
  expect(state.gateway.mock.calls.every((call) => call[0] === 'GET')).toBe(true);
});
it('refuses unknown binaries before accessing gateway state', async () => {
  state.bytes = Buffer.from('unknown');
  await expect(verifyAgentVault()).rejects.toThrow('reviewed pin');
  expect(state.gateway).not.toHaveBeenCalled();
});
it('rejects exposed tokens and propagates gateway contract errors', async () => {
  state.mode = 0o100644;
  await expect(verifyAgentVault()).rejects.toThrow('mode 0600');
  state.mode = 0o100600;
  state.gateway.mockRejectedValue(new Error('contract mismatch'));
  await expect(verifyAgentVault()).rejects.toThrow('contract mismatch');
});
