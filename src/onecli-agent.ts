import type { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_NEW_AGENT_SECRET_IDS, ONECLI_URL } from './config.js';
import { log } from './log.js';

type AgentProvisioningClient = Pick<OneCLI, 'ensureAgent' | 'listAgents' | 'attachSecret'>;
const provisioning = new Map<string, Promise<void>>();
let legacyClient: Promise<OneCLI> | null = null;

export function isOneCliConfigured(): boolean {
  if (!ONECLI_URL && !ONECLI_API_KEY) return false;
  if (!ONECLI_URL || !ONECLI_API_KEY)
    throw new Error('Legacy OneCLI requires both ONECLI_URL and ONECLI_API_KEY; no cloud fallback is allowed');
  return true;
}

export function getOneCliClient(): Promise<OneCLI> {
  if (!isOneCliConfigured())
    throw new Error('OneCLI is not configured for this legacy agent; migrate it to AgentVault before starting it');
  legacyClient ??= import('@onecli-sh/sdk').then(
    ({ OneCLI }) => new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY }),
  );
  return legacyClient;
}

export function ensureOneCliAgent(
  client: AgentProvisioningClient,
  name: string,
  identifier: string,
  secretIds: string[] = ONECLI_NEW_AGENT_SECRET_IDS,
): Promise<void> {
  const pending = provisioning.get(identifier);
  if (pending) return pending;

  const next = provisionOneCliAgent(client, name, identifier, secretIds).finally(() => {
    if (provisioning.get(identifier) === next) provisioning.delete(identifier);
  });
  provisioning.set(identifier, next);
  return next;
}

async function provisionOneCliAgent(
  client: AgentProvisioningClient,
  name: string,
  identifier: string,
  secretIds: string[],
): Promise<void> {
  const result = await client.ensureAgent({ name, identifier });
  if (!result.created || secretIds.length === 0) return;

  const agent = (await client.listAgents()).find((candidate) => candidate.identifier === identifier);
  if (!agent) {
    throw new Error(`OneCLI created agent ${identifier} but did not return it from listAgents`);
  }

  for (const secretId of secretIds) {
    await client.attachSecret(agent.id, secretId);
  }
  log.info('OneCLI secrets granted to new agent', { identifier, count: secretIds.length });
}
