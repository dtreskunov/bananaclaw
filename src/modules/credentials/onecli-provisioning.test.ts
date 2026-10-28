import type { Agent, AgentGrants, EffectiveCredentials } from '@onecli-sh/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceKeys, type GatewayService, type KeySetInfo } from './gateway-credentials.js';
import { buildMigrationPlan, type MigrationGroup, type SecretMetadata } from './onecli-migration.js';
import {
  compileProvisioningSets,
  provisionMigrationPlan,
  ProvisioningError,
  type ProvisioningReview,
} from './onecli-provisioning.js';

const target = vi.hoisted(() => ({
  ensure: vi.fn<() => Promise<'created' | 'exists'>>(),
  put: vi.fn<
    (
      gid: string,
      name: string,
      service: GatewayService,
      values: Record<string, string>,
      condition: { createOnly: true } | { revision: string },
    ) => Promise<KeySetInfo>
  >(),
}));
vi.mock('./agent-vault-client.js', async (original) => ({
  ...(await original<typeof import('./agent-vault-client.js')>()),
  ensureVault: target.ensure,
}));
vi.mock('./gateway-credentials.js', async (original) => ({
  ...(await original<typeof import('./gateway-credentials.js')>()),
  putKeySet: target.put,
}));

const group: MigrationGroup = {
  id: 'ag-source',
  name: 'Source',
  backend: 'onecli',
  provider: 'native',
  mcpServerCount: 0,
};
const agent: Agent = {
  id: 'source-agent',
  identifier: group.id,
  name: 'Source',
  isDefault: false,
  createdAt: '2026-01-01',
};
const metadata: SecretMetadata[] = ['a', 'b'].map((suffix) => ({
  id: `secret-${suffix}`,
  name: suffix,
  type: 'generic',
  host: `api-${suffix}.example.com`,
  path: null,
  header: 'Authorization',
  queryParameter: null,
  format: 'Bearer {{value}}',
  authMode: null,
}));
function plan(secrets = metadata) {
  const grants: AgentGrants = {
    agentId: agent.id,
    mode: 'grants',
    secrets: secrets.map((secret) => ({ secretId: secret.id, name: secret.name, type: secret.type, scope: 'project' })),
    connections: [],
  };
  const effective: EffectiveCredentials = {
    agentId: agent.id,
    mode: 'selective',
    secrets: secrets.map((secret) => ({
      kind: 'secret',
      id: secret.id,
      name: secret.name,
      host: secret.host!,
      status: 'usable',
      provenance: [],
    })),
    connections: [],
  };
  return buildMigrationPlan(group, [agent], secrets, grants, effective, {
    exists: false,
    credentialKeys: [],
    services: [],
  });
}
function review(current: ReturnType<typeof plan>): ProvisioningReview {
  return {
    group: group.id,
    confirmation: group.id,
    digest: current.digest,
    sourcePolicyReviewed: true,
    compositeRoutingReviewed: false,
  };
}
function values(current: ReturnType<typeof plan>): Record<string, string> {
  return Object.fromEntries(current.staticKeys.map((entry) => [entry.key, `synthetic-${entry.sourceId}`]));
}
beforeEach(() => {
  vi.resetAllMocks();
  target.ensure.mockResolvedValue('exists');
  target.put.mockImplementation(async (_gid, _name, service) => ({
    service,
    keys: serviceKeys(service),
    revision: `"${'1'.repeat(64)}"`,
  }));
});

describe('create-only inactive-target import', () => {
  it('creates separate sets with write-only values, never activating or retiring the source', async () => {
    const current = plan();
    const receipt = await provisionMigrationPlan(current, review(current), values(current));
    expect(receipt).toMatchObject({
      status: 'complete',
      backendChanged: false,
      oneCliChanged: false,
      readyToCutover: false,
      unprovisioned: [],
    });
    expect(receipt.completed).toHaveLength(2);
    expect(JSON.stringify(receipt)).not.toContain('synthetic-');
    expect(target.ensure).toHaveBeenCalledWith(group.id);
    for (const call of target.put.mock.calls) {
      expect(call[4]).toEqual({ createOnly: true });
      expect(Object.keys(call[3])).toEqual(serviceKeys(call[2]));
    }
  });

  it('rejects stale reviews, missing values and extra keys before any writes', async () => {
    const current = plan();
    for (const invalid of [
      { ...review(current), digest: 'stale' },
      { ...review(current), confirmation: 'other' },
      { ...review(current), sourcePolicyReviewed: false },
    ]) {
      await expect(provisionMigrationPlan(current, invalid, values(current))).rejects.toThrow();
    }
    await expect(provisionMigrationPlan(current, review(current), {})).rejects.toThrow('exactly');
    await expect(
      provisionMigrationPlan(current, review(current), { ...values(current), EXTRA_KEY: 'synthetic-extra' }),
    ).rejects.toThrow('exactly');
    expect(target.ensure).not.toHaveBeenCalled();
    expect(target.put).not.toHaveBeenCalled();
  });

  it('requires explicit complementary-header review and keeps distinct values', async () => {
    const current = plan(
      metadata.map((secret, i) => ({
        ...secret,
        host: 'api.example.com',
        header: i ? 'x-api-key' : 'Authorization',
        format: i ? '{{value}}' : 'Bearer {{value}}',
      })),
    );
    expect(current.routingReviews[0]?.kind).toBe('complementary-headers');
    expect(() => compileProvisioningSets(current, review(current))).toThrow('explicit review');
    const receipt = await provisionMigrationPlan(
      current,
      { ...review(current), compositeRoutingReviewed: true },
      values(current),
    );
    expect(receipt.completed).toHaveLength(1);
    const call = target.put.mock.calls[0]!;
    expect(call[2].auth.type).toBe('custom');
    expect(new Set(Object.values(call[3])).size).toBe(2);
    expect(call[4]).toEqual({ createOnly: true });
  });

  it('does not promote restricted/existing entries or infer value equality on retry', () => {
    const current = plan();
    for (const state of ['source-restricted', 'target-exists'] as const) {
      const blocked = { ...current, staticKeys: current.staticKeys.map((entry) => ({ ...entry, state })) };
      expect(() => compileProvisioningSets(blocked, review(blocked))).toThrow('No eligible');
    }
    const name = current.staticKeys[0]!.service!.name;
    expect(compileProvisioningSets(current, { ...review(current), serviceNames: [name] })).toHaveLength(1);
    expect(() => compileProvisioningSets(current, { ...review(current), serviceNames: ['unknown'] })).toThrow();
  });

  it('stops at the first failure and reports a safe partial receipt with no upsert fallback', async () => {
    const current = plan();
    target.put
      .mockImplementationOnce(async (_gid, _name, service) => ({
        service,
        keys: serviceKeys(service),
        revision: `"${'2'.repeat(64)}"`,
      }))
      .mockRejectedValueOnce(new Error('synthetic-private-exception'));
    let failure: ProvisioningError | undefined;
    try {
      await provisionMigrationPlan(current, review(current), values(current));
    } catch (error) {
      if (!(error instanceof ProvisioningError)) throw error;
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(failure!.receipt).toMatchObject({
      status: 'partial',
      requiresReinventory: true,
      backendChanged: false,
      oneCliChanged: false,
      readyToCutover: false,
    });
    expect(failure!.receipt.completed).toHaveLength(1);
    expect(failure!.receipt.unprovisioned).toHaveLength(1);
    expect(failure!.receipt.failedService).toBeTruthy();
    expect(failure!.message + JSON.stringify(failure!.receipt)).not.toContain('synthetic-');
    expect(target.put.mock.calls.every((call) => 'createOnly' in call[4])).toBe(true);
  });

  it('treats a malformed success response as an ambiguous failure requiring re-inventory', async () => {
    const current = plan();
    target.put.mockResolvedValueOnce({ service: current.staticKeys[0]!.service!, keys: [], revision: 'invalid' });
    await expect(provisionMigrationPlan(current, review(current), values(current))).rejects.toMatchObject({
      receipt: { status: 'failed', requiresReinventory: true, completed: [] },
    });
    expect(target.put).toHaveBeenCalledTimes(1);
  });
});
