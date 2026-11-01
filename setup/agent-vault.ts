import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gatewayJson, gatewaySettings } from '../src/modules/credentials/agent-vault-client.js';
import { gatewayRelease } from './agent-vault-release.js';
import { emitStatus } from './status.js';

/** Read-only prerequisite check; installation/password provisioning uses /init-agent-vault. */
export async function verifyAgentVault(): Promise<void> {
  const binary = path.join(os.homedir(), '.local', 'bin', 'agent-vault');
  const reviewed = gatewayRelease();
  const digest = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (digest !== reviewed.sha256)
    throw new Error(
      'Installed Agent Vault differs from the reviewed pin; use /init-agent-vault without downgrading a newer canary',
    );
  const token = gatewaySettings().tokenFile;
  if ((fs.statSync(token).mode & 0o777) !== 0o600)
    throw new Error('Protect the existing gateway host token with mode 0600; do not rotate it');
  await gatewayJson('GET', '/v1/vaults', 'setup gateway verification');
  await gatewayJson('GET', '/v1/socket-sessions', 'setup socket-session contract verification');
}

export async function run(args: string[]): Promise<void> {
  if (args.length)
    throw new Error('Agent Vault setup verification accepts no arguments; use /init-agent-vault for installation');
  await verifyAgentVault();
  emitStatus('AGENT_VAULT', { STATUS: 'success', GATEWAY_VERSION: gatewayRelease().version, LOG: 'logs/setup.log' });
}
