import { AgentVaultError, ensureVault } from './agent-vault-client.js';
import { putKeySet, serviceKeys, type GatewayService } from './gateway-credentials.js';
import { checkSetRevision, checkSetService, checkSetValues } from './key-sets.js';
import type { MigrationPlan } from './onecli-migration.js';

export interface ProvisioningReview {
  group: string;
  confirmation: string;
  digest: string;
  sourcePolicyReviewed: boolean;
  compositeRoutingReviewed: boolean;
  serviceNames?: string[];
}

export interface StaticKeySet {
  service: GatewayService;
  keys: string[];
  sourceIds: string[];
  composite: boolean;
}

export function compileProvisioningSets(plan: MigrationPlan, review: ProvisioningReview): StaticKeySet[] {
  if (review.group !== plan.group.id || review.confirmation !== review.group)
    throw new Error('Confirm the exact selected group');
  if (review.digest !== plan.digest) throw new Error('Plan digest changed; review a fresh inventory');
  if (plan.group.backend !== 'onecli' || !plan.sourceAgentId || plan.blockers.includes('ambiguous-source-agent'))
    throw new Error('Provisioning requires an unambiguous OneCLI source group');
  if (!review.sourcePolicyReviewed)
    throw new Error('Explicit source-policy review is required; metadata is not proof of complete policy parity');
  const sets: StaticKeySet[] = plan.staticKeys
    .filter((entry) => entry.state === 'needs-value' && entry.service)
    .map((entry) => ({
      service: checkSetService(entry.service),
      keys: [entry.key],
      sourceIds: [entry.sourceId],
      composite: false,
    }));
  for (const routing of plan.routingReviews) {
    if (routing.kind !== 'complementary-headers' || !routing.serviceProposal) continue;
    const entries = routing.sourceIds.map((id) => plan.staticKeys.find((entry) => entry.sourceId === id));
    if (
      entries.some(
        (entry) => !entry || entry.sourceStatus !== 'usable' || !['needs-value', 'manual-review'].includes(entry.state),
      )
    )
      continue;
    sets.push({
      service: checkSetService(routing.serviceProposal),
      keys: entries.map((entry) => entry!.key).sort(),
      sourceIds: [...routing.sourceIds],
      composite: true,
    });
  }
  const selected = review.serviceNames;
  if (
    selected &&
    (selected.length === 0 ||
      new Set(selected).size !== selected.length ||
      selected.some((name) => !sets.some((set) => set.service.name === name)))
  )
    throw new Error('Selected services must be distinct eligible names from the current plan');
  const result = sets
    .filter((set) => !selected || selected.includes(set.service.name))
    .sort((a, b) => a.service.name.localeCompare(b.service.name));
  if (!result.length)
    throw new Error(
      'No eligible new key sets; resolve existing targets or manual/restricted entries without assuming matching values',
    );
  if (result.some((set) => set.composite) && !review.compositeRoutingReviewed)
    throw new Error('Complementary-header routing requires explicit review; distinct values are never assumed equal');
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const set of result) {
    if (
      names.has(set.service.name) ||
      JSON.stringify(serviceKeys(set.service).sort()) !== JSON.stringify([...set.keys].sort())
    )
      throw new Error('Ambiguous service name or credential membership');
    names.add(set.service.name);
    for (const key of set.keys) {
      if (keys.has(key)) throw new Error('A key cannot belong to multiple import sets');
      keys.add(key);
    }
  }
  return result;
}

export interface ProvisioningReceipt {
  group: string;
  reviewedDigest: string;
  status: 'complete' | 'partial' | 'failed';
  vaultState?: 'created' | 'exists';
  completed: { service: string; keys: string[]; revision: string }[];
  failedService: string | null;
  unprovisioned: { sourceId: string; state: string }[];
  backendChanged: false;
  oneCliChanged: false;
  readyToCutover: false;
  requiresReinventory: boolean;
  failure?: { status: number | null; code: string | null; unreachable: boolean };
}

export class ProvisioningError extends Error {
  constructor(
    public readonly receipt: ProvisioningReceipt,
    cause: unknown,
  ) {
    super(
      'Target provisioning stopped. Review the partial receipt and re-inventory; never retry by upserting existing objects.',
      { cause },
    );
  }
}

export async function provisionMigrationPlan(
  plan: MigrationPlan,
  review: ProvisioningReview,
  rawValues: unknown,
): Promise<ProvisioningReceipt> {
  const sets = compileProvisioningSets(plan, review);
  const values = checkSetValues(rawValues);
  const required = sets.flatMap((set) => set.keys).sort();
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(required))
    throw new Error('Supply exactly the selected target keys through write-only stdin; no values were written');
  const receipt: ProvisioningReceipt = {
    group: plan.group.id,
    reviewedDigest: plan.digest,
    status: 'failed',
    completed: [],
    failedService: null,
    unprovisioned: plan.staticKeys.map((entry) => ({ sourceId: entry.sourceId, state: entry.state })),
    backendChanged: false,
    oneCliChanged: false,
    readyToCutover: false,
    requiresReinventory: false,
  };
  const completedSources = new Set<string>();
  try {
    receipt.vaultState = await ensureVault(plan.group.id);
    for (const set of sets) {
      receipt.failedService = set.service.name;
      const info = await putKeySet(
        plan.group.id,
        set.service.name,
        set.service,
        Object.fromEntries(set.keys.map((key) => [key, values[key]!])),
        { createOnly: true },
      );
      if (!Array.isArray(info.keys) || JSON.stringify([...info.keys].sort()) !== JSON.stringify([...set.keys].sort()))
        throw new Error('Gateway returned unexpected key-set membership');
      receipt.completed.push({
        service: set.service.name,
        keys: [...set.keys],
        revision: checkSetRevision(info.revision),
      });
      for (const id of set.sourceIds) completedSources.add(id);
    }
    receipt.failedService = null;
    receipt.status = 'complete';
    return receipt;
  } catch (error) {
    receipt.status = receipt.completed.length || receipt.vaultState === 'created' ? 'partial' : 'failed';
    receipt.requiresReinventory = true;
    if (error instanceof AgentVaultError)
      receipt.failure = { status: error.status ?? null, code: error.code ?? null, unreachable: error.unreachable };
    throw new ProvisioningError(receipt, error);
  } finally {
    receipt.unprovisioned = receipt.unprovisioned.filter((entry) => !completedSources.has(entry.sourceId));
  }
}
