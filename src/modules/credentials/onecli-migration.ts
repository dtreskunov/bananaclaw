import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  Agent,
  AgentGrants,
  EffectiveAppPermissions,
  EffectiveCredentials,
  EffectiveToolVerdict,
} from '@onecli-sh/sdk';

import { checkDestination, checkKeyName, KeyInputError } from './keys.js';
import { serviceFromDestination, type DestinationDto, type GatewayService } from './gateway-credentials.js';

export interface MigrationGroup {
  id: string;
  name: string;
  backend: 'onecli' | 'agent-vault';
  provider: string | null;
  mcpServerCount: number;
  mcpClients?: MigrationMcpClient[];
}

export interface MigrationMcpClient {
  name: string;
  transport: 'http' | 'sse' | 'stdio' | 'unsupported';
  host: string | null;
  queryParameters: string[];
  headerNames: string[];
  credentialEnvNames: string[];
  gatewayEnvNames: string[];
  command: string | null;
  review: string[];
}

export interface MigrationRoutingReview {
  sourceIds: string[];
  kind: 'complementary-headers' | 'overlapping-recipients';
  applySupported: boolean;
  serviceProposal?: GatewayService;
  actions: string[];
}

export interface SecretMetadata {
  id: string;
  name: string;
  type: string;
  host: string | null;
  path: string | null;
  header: string | null;
  queryParameter: string | null;
  format: string | null;
  authMode: string | null;
}

export interface MigrationSource {
  listAgents(): Promise<Agent[]>;
  listSecrets(): Promise<SecretMetadata[]>;
  getAgentGrants(id: string): Promise<AgentGrants>;
  getEffectiveCredentials(id: string): Promise<EffectiveCredentials>;
  getEffectiveAppPermissions(input: { provider: string; agentId: string }): Promise<EffectiveAppPermissions>;
}

export interface MigrationTarget {
  exists: boolean;
  credentialKeys: string[];
  services: GatewayService[];
}

export interface StaticPreparation {
  sourceId: string;
  name: string;
  sourceType: string;
  sourceStatus: string;
  state: 'needs-value' | 'manual-review' | 'source-restricted' | 'target-exists';
  key: string;
  destination?: DestinationDto;
  service?: GatewayService;
  queryParameter?: string;
  actions: string[];
}

export interface MigrationPlan {
  group: MigrationGroup;
  sourceAgentId: string | null;
  sourceMode: string | null;
  effectiveMode: string | null;
  sourcePolicyDigest: string | null;
  targetDigest: string;
  policyReviewRequired: true;
  appPolicies: {
    provider: string;
    credentialAttached: boolean;
    sourceScope: string;
    variesByIdentity: number;
    tools: { id: string; verdict: EffectiveToolVerdict; rateLimit: number | null; rateLimitWindow: string | null }[];
  }[];
  readyToCutover: false;
  blockers: string[];
  staticKeys: StaticPreparation[];
  routingReviews: MigrationRoutingReview[];
  queryClientRewires: {
    client: string;
    sourceId: string;
    parameter: string;
    placeholder: string;
    action: 'add-parameter' | 'replace-parameter';
    exactResourceMatchVerified: false;
  }[];
  accounts: {
    sourceId: string;
    provider: string;
    label: string | null;
    sourceStatus: string;
    access: string | null;
    approvalToolCount: number;
    allowedTools: string[];
    approvalTools: string[];
    restricted: boolean;
    action: 'needs-reconnect' | 'review-source-access';
  }[];
  accountReviewGroups: {
    label: string;
    sourceIds: string[];
    providers: string[];
    identityVerified: false;
    scopeUnionKnown: false;
    action: string;
  }[];
  target: { exists: boolean; credentialCount: number; serviceCount: number };
  digest: string;
}

export interface MigrationInventory {
  schemaVersion: 1;
  generatedAt: string;
  source: string;
  metadataOnly: true;
  liveChanges: false;
  warnings: string[];
  groups: MigrationPlan[];
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${what} must be a nonempty string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Only names/hosts and review flags leave the client configuration boundary. */
export function summarizeMcpClients(raw: unknown): MigrationMcpClient[] {
  const servers = object(raw, 'MCP configuration');
  return Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      const config = object(value, 'MCP server');
      const type = config.type ?? 'stdio';
      const transport = type === 'http' || type === 'sse' || type === 'stdio' ? type : 'unsupported';
      const headers = config.headers == null ? {} : object(config.headers, 'MCP headers');
      const env = config.env == null ? {} : object(config.env, 'MCP environment');
      const gatewayEnv = new Set([
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'SSL_CERT_FILE',
        'NODE_EXTRA_CA_CERTS',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
        'GIT_SSL_CAINFO',
        'DENO_CERT',
        'NANOCLAW_EGRESS_SOCKET',
        'NODE_USE_ENV_PROXY',
      ]);
      const result: MigrationMcpClient = {
        name,
        transport,
        host: null,
        queryParameters: [],
        headerNames: Object.keys(headers).sort(),
        credentialEnvNames: Object.keys(env)
          .filter((key) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)/i.test(key))
          .sort(),
        gatewayEnvNames: Object.keys(env)
          .filter((key) => gatewayEnv.has(key.toUpperCase()))
          .sort(),
        command: null,
        review: [],
      };
      if (transport === 'stdio' && typeof config.command === 'string') {
        const command = path.basename(config.command);
        if (/^[A-Za-z0-9._+-]+$/.test(command)) result.command = command;
        else result.review.push('unusual-command: inspect the original command privately');
      }
      if (transport === 'http' || transport === 'sse') {
        if (typeof config.url !== 'string' || !URL.canParse(config.url))
          result.review.push('invalid-endpoint: inspect the original configuration privately');
        else {
          const url = new URL(config.url);
          if (url.protocol !== 'https:' && url.protocol !== 'http:') result.review.push('unsupported-endpoint-scheme');
          else {
            result.host = url.host;
            result.queryParameters = [...new Set(url.searchParams.keys())].sort();
            result.review.push(
              'verify-target-network-access: source connectivity does not establish gateway allowlist/DNS access',
            );
            if (url.protocol === 'http:')
              result.review.push('plaintext-endpoint: review intended proxy and credential behavior explicitly');
            if (url.username || url.password)
              result.review.push(
                'inline-url-credentials: replace through a reviewed write-only path; do not copy them into reports',
              );
            if (result.queryParameters.length)
              result.review.push(
                'query-client-rewiring: inspect parameter handling and target placeholders before cutover',
              );
          }
        }
      } else if (transport === 'stdio') {
        result.review.push(
          'verify-executable-dependencies-and-proxy-ca: no executable or package was run by this inventory',
        );
        if (!result.command) result.review.push('missing-command');
      } else result.review.push('unsupported-transport');
      if (result.headerNames.length)
        result.review.push('header-client-rewiring: inspect placeholders privately; no header values were exported');
      if (result.credentialEnvNames.length)
        result.review.push(
          'credential-env-review: verify target placeholders and token-file schemas; no values were exported',
        );
      if (result.gatewayEnvNames.length)
        result.review.push(
          'gateway-env-override: review proxy/CA overrides before migration; no proxy credentials or certificate paths were exported',
        );
      return result;
    });
}

/** Project only documented metadata fields; never retain values, opRef or arbitrary metadata. */
export function parseSecretMetadata(raw: unknown): SecretMetadata[] {
  const entries = Array.isArray(raw) ? raw : object(raw, 'Secret metadata response').data;
  if (!Array.isArray(entries)) throw new Error('Secret metadata response must contain an array');
  const ids = new Set<string>();
  return entries
    .map((entry) => {
      const item = object(entry, 'Secret metadata');
      const id = string(item.id, 'Secret id');
      if (ids.has(id)) throw new Error('Duplicate OneCLI secret metadata ID');
      ids.add(id);
      const injection = item.injectionConfig == null ? {} : object(item.injectionConfig, 'Injection metadata');
      const metadata = item.metadata == null ? {} : object(item.metadata, 'Secret metadata attributes');
      return {
        id,
        name: string(item.name, 'Secret name'),
        type: string(item.type, 'Secret type'),
        host: optionalString(item.hostPattern),
        path: optionalString(item.pathPattern),
        header: optionalString(injection.headerName),
        queryParameter: optionalString(injection.paramName),
        format: optionalString(injection.valueFormat ?? injection.paramFormat),
        authMode: optionalString(metadata.authMode),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function planDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function targetKey(id: string): string {
  return `ONECLI_${createHash('sha256').update(id).digest('hex').slice(0, 20).toUpperCase()}`;
}

function inferDestination(
  meta: SecretMetadata,
  key: string,
): { destination: DestinationDto; queryParameter?: string } | null {
  if (
    !meta.host ||
    /[?#@\\\s]/.test(meta.host) ||
    (meta.path && (/[?#\\\s]/.test(meta.path) || !meta.path.startsWith('/')))
  )
    return null;
  const match = `${meta.host}${meta.path === '/*' ? '' : (meta.path ?? '')}`;
  let destination: DestinationDto;
  if (meta.type === 'anthropic') {
    if (meta.authMode !== 'api-key') return null;
    destination = { match, injection: { type: 'api-key', name: 'x-api-key' } };
  } else if (meta.type === 'generic') {
    const format = /^(Bearer |Basic |Token )?(\{\{\s*value\s*\}\}|\{value\}|%s)$/.exec(meta.format ?? '');
    if (!format) return null;
    const prefix = format[1] ?? '';
    if (meta.queryParameter) {
      if (prefix || meta.header || !/^[A-Za-z0-9_-]+$/.test(meta.queryParameter)) return null;
      destination = { match, injection: { type: 'query', name: `__${key}__` } };
    } else {
      if (!meta.header) return null;
      destination =
        meta.header.toLowerCase() === 'authorization' && prefix === 'Bearer '
          ? { match, injection: { type: 'bearer' } }
          : { match, injection: { type: 'api-key', name: meta.header, prefix } };
    }
  } else return null;
  try {
    return {
      destination: checkDestination(destination, key),
      ...(meta.queryParameter ? { queryParameter: meta.queryParameter } : {}),
    };
  } catch (error) {
    // Unsupported metadata needs review, never a guessed injection.
    if (error instanceof KeyInputError) return null;
    throw error;
  }
}

function recipient(pattern: string): string {
  return pattern.split('/')[0]!.toLowerCase().replace(/:443$/, '');
}

function recipientsMayOverlap(a: string, b: string): boolean {
  const left = recipient(a);
  const right = recipient(b);
  return (
    left === right ||
    (left.startsWith('*.') && right.endsWith(left.slice(1))) ||
    (right.startsWith('*.') && left.endsWith(right.slice(1)))
  );
}

function headerTemplate(entry: StaticPreparation): { name: string; value: string } | null {
  const injection = entry.destination?.injection;
  const reference = `{{ ${entry.key} }}`;
  if (injection?.type === 'bearer') return { name: 'Authorization', value: `Bearer ${reference}` };
  if (injection?.type === 'api-key' && injection.name)
    return { name: injection.name, value: `${injection.prefix ?? ''}${reference}` };
  return null;
}

function routingReviews(entries: StaticPreparation[]): MigrationRoutingReview[] {
  const pending = new Set(entries.filter((entry) => entry.destination));
  const reviews: MigrationRoutingReview[] = [];
  for (const first of pending) {
    pending.delete(first);
    const cluster = [first];
    for (let i = 0; i < cluster.length; i++) {
      for (const other of pending) {
        if (recipientsMayOverlap(cluster[i]!.destination!.match, other.destination!.match)) {
          pending.delete(other);
          cluster.push(other);
        }
      }
    }
    if (cluster.length < 2) continue;
    cluster.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const sourceIds = cluster.map((entry) => entry.sourceId);
    const headers = cluster.map(headerTemplate);
    const sameDestination = cluster.every((entry) => entry.destination!.match === first.destination!.match);
    const distinctHeaders =
      headers.every((header) => header !== null) &&
      new Set(headers.map((header) => header!.name.toLowerCase())).size === headers.length;
    if (sameDestination && distinctHeaders) {
      const proposal: GatewayService = {
        name: `onecli-composite-${planDigest(sourceIds).slice(0, 16)}`,
        host: first.destination!.match,
        auth: { type: 'custom', headers: Object.fromEntries(headers.map((header) => [header!.name, header!.value])) },
      };
      reviews.push({
        sourceIds,
        kind: 'complementary-headers',
        applySupported: true,
        serviceProposal: proposal,
        actions: [
          'Metadata identifies distinct headers on the same destination; this proposal keeps distinct credential references and does not assume equal values.',
          'Use the conditional key-set lifecycle and explicit composite-routing review; never send this proposal to a single-key or upsert API.',
          'Source policy/precedence still requires review. This is not a live import or proof that sending all headers matches every source request.',
        ],
      });
    } else
      reviews.push({
        sourceIds,
        kind: 'overlapping-recipients',
        applySupported: false,
        actions: [
          'Different path patterns, query substitutions or conflicting header selectors require an explicit routing decision; no merge was inferred.',
        ],
      });
  }
  return reviews;
}

function accountReviewGroups(accounts: MigrationPlan['accounts']): MigrationPlan['accountReviewGroups'] {
  const labels = new Map<string, MigrationPlan['accounts']>();
  for (const account of accounts) {
    if (!account.label) continue;
    const sameLabel = labels.get(account.label) ?? [];
    sameLabel.push(account);
    labels.set(account.label, sameLabel);
  }
  return [...labels]
    .filter(([, entries]) => entries.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, entries]) => ({
      label,
      sourceIds: entries.map((entry) => entry.sourceId).sort(),
      providers: [...new Set(entries.map((entry) => entry.provider))].sort(),
      identityVerified: false,
      scopeUnionKnown: false,
      action:
        'These source labels match, not verified subjects. Review actual issuer/identity and intended scopes during sign-in; do not merge tokens or infer a scope union from labels.',
    }));
}

function queryClientRewires(group: MigrationGroup, entries: StaticPreparation[]): MigrationPlan['queryClientRewires'] {
  const rewires: MigrationPlan['queryClientRewires'] = [];
  for (const client of group.mcpClients ?? []) {
    if (!client.host || (client.transport !== 'http' && client.transport !== 'sse')) continue;
    for (const entry of entries) {
      if (
        !entry.destination ||
        entry.destination.injection.type !== 'query' ||
        !entry.queryParameter ||
        !entry.destination.injection.name ||
        !recipientsMayOverlap(client.host, entry.destination.match)
      )
        continue;
      rewires.push({
        client: client.name,
        sourceId: entry.sourceId,
        parameter: entry.queryParameter,
        placeholder: entry.destination.injection.name,
        action: client.queryParameters.includes(entry.queryParameter) ? 'replace-parameter' : 'add-parameter',
        exactResourceMatchVerified: false,
      });
    }
  }
  return rewires;
}

export function buildMigrationPlan(
  group: MigrationGroup,
  agents: Agent[],
  metadata: SecretMetadata[],
  grants: AgentGrants | null,
  effective: EffectiveCredentials | null,
  target: MigrationTarget,
  policies: EffectiveAppPermissions[] = [],
): MigrationPlan {
  const candidates = agents.filter((a) => !a.isDefault && a.identifier === group.id);
  const blockers: string[] = [];
  const staticKeys: StaticPreparation[] = [];
  const accounts: MigrationPlan['accounts'] = [];
  const appPolicies: MigrationPlan['appPolicies'] = [];
  if (group.backend === 'agent-vault') blockers.push('already-on-agent-vault: do not prepare another migration');
  else {
    blockers.push(
      'policy-review-required: effective metadata is not proof of approval/rate-limit/network policy parity',
    );
    if (candidates.length !== 1) blockers.push(candidates.length ? 'ambiguous-source-agent' : 'no-source-agent');
    else {
      if (!grants || !effective || grants.agentId !== candidates[0]!.id || effective.agentId !== candidates[0]!.id) {
        throw new Error(`Missing or mismatched OneCLI grant/effective metadata for ${group.id}`);
      }
      const byId = new Map(metadata.map((m) => [m.id, m]));
      const effectiveSecrets = new Map<string, Extract<EffectiveCredentials['secrets'][number], { kind: 'secret' }>>();
      for (const credential of effective.secrets) {
        if (credential.kind !== 'secret') throw new Error('Unexpected non-secret effective credential');
        if (effectiveSecrets.has(credential.id)) throw new Error('Duplicate effective credential ID');
        effectiveSecrets.set(credential.id, credential);
      }
      const ids = [...new Set([...effectiveSecrets.keys(), ...grants.secrets.map((s) => s.secretId)])].sort();
      for (const id of ids) {
        const available = effectiveSecrets.get(id);
        const meta = byId.get(id);
        const key = targetKey(id);
        checkKeyName(key);
        const entry: StaticPreparation = {
          sourceId: id,
          name: meta?.name ?? available?.name ?? grants.secrets.find((s) => s.secretId === id)!.name,
          sourceType: meta?.type ?? 'unknown',
          sourceStatus: available?.status ?? 'not-effective',
          state: 'manual-review',
          key,
          actions: [],
        };
        if (available?.status !== 'usable') {
          entry.state = 'source-restricted';
          entry.actions.push('Do not migrate access that is blocked, limited, unknown or not effective.');
        } else {
          const inferred =
            meta && meta.host && recipient(meta.host) === recipient(available.host)
              ? inferDestination(meta, key)
              : null;
          if (!inferred)
            entry.actions.push(
              'Review missing/unsupported destination or injection metadata; no template was guessed.',
            );
          else {
            entry.destination = inferred.destination;
            entry.service = serviceFromDestination(`onecli-${key.slice(7).toLowerCase()}`, key, inferred.destination);
            entry.state = 'needs-value';
            entry.actions.push(
              'Operator must enter the value separately in the target vault; values are not exported.',
            );
            if (inferred.queryParameter) {
              entry.queryParameter = inferred.queryParameter;
              entry.actions.push(
                'Update the configured query parameter to the template placeholder before testing; do not copy source URL secrets.',
              );
            }
            if (
              target.credentialKeys.includes(key) ||
              target.services.some(
                (s) => s.name === entry.service!.name || recipientsMayOverlap(s.host, inferred.destination.match),
              )
            ) {
              entry.state = 'target-exists';
              entry.actions.push('Existing target key/service/recipient requires review; never overwrite it.');
            }
          }
        }
        staticKeys.push(entry);
      }
      for (const item of staticKeys) {
        if (
          item.destination &&
          staticKeys.some(
            (other) =>
              other !== item &&
              other.destination &&
              recipientsMayOverlap(item.destination!.match, other.destination.match),
          )
        ) {
          item.actions.push(
            'Source recipients overlap; explicitly resolve credentials and routing without assuming values are identical.',
          );
          if (item.state === 'needs-value') item.state = 'manual-review';
        }
        if (item.state !== 'needs-value') blockers.push(`${item.state}:${item.sourceId}`);
      }
      const effectiveConnections = new Map(
        effective.connections.map((item) => {
          if (item.kind !== 'connection') throw new Error('Unexpected non-connection effective credential');
          return [item.id, item];
        }),
      );
      const connections = [
        ...new Set([...effectiveConnections.keys(), ...grants.connections.map((c) => c.connectionId)]),
      ].sort();
      const providers = new Set([
        ...grants.connections.map((connection) => connection.provider),
        ...[...effectiveConnections.values()].map((connection) => connection.provider),
      ]);
      for (const policy of policies) {
        if (
          policy.basis.agentId !== candidates[0]!.id ||
          !providers.has(policy.provider) ||
          appPolicies.some((p) => p.provider === policy.provider)
        ) {
          throw new Error('Mismatched or duplicate effective app policy metadata');
        }
        const tools = policy.groups
          .flatMap((category) =>
            category.tools.map((tool) => ({
              id: tool.toolId,
              verdict: tool.verdict,
              rateLimit: tool.rateLimit,
              rateLimitWindow: tool.rateLimitWindow,
            })),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        appPolicies.push({
          provider: policy.provider,
          credentialAttached: policy.basis.credentialAttached,
          sourceScope: policy.basis.scope,
          variesByIdentity: policy.variesByIdentity,
          tools,
        });
        if (
          !policy.basis.credentialAttached ||
          !tools.length ||
          tools.some((tool) => tool.verdict !== 'allow' || tool.rateLimit !== null)
        ) {
          blockers.push(`source-tool-policy-required:${policy.provider}`);
        }
      }
      appPolicies.sort((a, b) => a.provider.localeCompare(b.provider));
      for (const id of connections) {
        const grant = grants.connections.find((c) => c.connectionId === id);
        const available = effectiveConnections.get(id);
        const provider = grant?.provider ?? available!.provider;
        const policy = appPolicies.find((item) => item.provider === provider);
        const restricted =
          available?.status !== 'usable' ||
          grant?.access === 'custom' ||
          Boolean(
            policy &&
            (!policy.credentialAttached ||
              !policy.tools.length ||
              policy.tools.some((tool) => tool.verdict !== 'allow' || tool.rateLimit !== null)),
          );
        const approvalTools = [
          ...new Set([
            ...(grant?.ask ?? []),
            ...(policy?.tools.filter((tool) => tool.verdict === 'approval').map((tool) => tool.id) ?? []),
          ]),
        ].sort();
        accounts.push({
          sourceId: id,
          provider,
          label: grant?.label ?? available?.label ?? null,
          sourceStatus: available?.status ?? 'not-effective',
          access: grant?.access ?? null,
          approvalToolCount: approvalTools.length,
          restricted,
          allowedTools: [...(grant?.allow ?? [])].sort(),
          approvalTools,
          action: restricted ? 'review-source-access' : 'needs-reconnect',
        });
        blockers.push(`${restricted ? 'review-source-access' : 'oauth-reconnect-required'}:${id}`);
      }
    }
  }
  const body = {
    group,
    sourceAgentId: candidates.length === 1 ? candidates[0]!.id : null,
    sourceMode: grants?.mode ?? null,
    effectiveMode: effective?.mode ?? null,
    sourcePolicyDigest: grants && effective ? planDigest({ grants, effective, policies }) : null,
    targetDigest: planDigest(target),
    policyReviewRequired: true as const,
    appPolicies,
    readyToCutover: false as const,
    blockers,
    staticKeys,
    routingReviews: routingReviews(staticKeys),
    queryClientRewires: queryClientRewires(group, staticKeys),
    accounts,
    accountReviewGroups: accountReviewGroups(accounts),
    target: {
      exists: target.exists,
      credentialCount: target.credentialKeys.length,
      serviceCount: target.services.length,
    },
  };
  return { ...body, digest: planDigest(body) };
}

export async function collectMigrationInventory(
  groups: MigrationGroup[],
  source: MigrationSource,
  readTarget: (id: string) => Promise<MigrationTarget>,
  sourceUrl: string,
): Promise<MigrationInventory> {
  const [agents, metadata] = await Promise.all([source.listAgents(), source.listSecrets()]);
  const plans: MigrationPlan[] = [];
  for (const group of [...groups].sort((a, b) => a.id.localeCompare(b.id))) {
    const matched = agents.filter((a) => !a.isDefault && a.identifier === group.id);
    const [target, grants, effective] = await Promise.all([
      readTarget(group.id),
      group.backend === 'onecli' && matched.length === 1
        ? source.getAgentGrants(matched[0]!.id)
        : Promise.resolve(null),
      group.backend === 'onecli' && matched.length === 1
        ? source.getEffectiveCredentials(matched[0]!.id)
        : Promise.resolve(null),
    ]);
    const providers = [
      ...new Set([
        ...(grants?.connections.map((connection) => connection.provider) ?? []),
        ...(effective?.connections.flatMap((connection) =>
          connection.kind === 'connection' ? [connection.provider] : [],
        ) ?? []),
      ]),
    ].sort();
    const policies =
      group.backend === 'onecli' && matched.length === 1
        ? await Promise.all(
            providers.map(async (provider) => {
              const policy = await source.getEffectiveAppPermissions({ provider, agentId: matched[0]!.id });
              if (policy.provider !== provider) throw new Error('OneCLI effective policy provider mismatch');
              return policy;
            }),
          )
        : [];
    plans.push(buildMigrationPlan(group, agents, metadata, grants, effective, target, policies));
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: new URL(sourceUrl).origin,
    metadataOnly: true,
    liveChanges: false,
    warnings: [
      'No credential values or OAuth tokens were requested. Injection templates are metadata-only proposals, not imported credentials.',
      'Organization-policy visibility may be unavailable. Review approvals, restrictions and host-side OneCLI callers before any cutover.',
      'Project-scope effective app policies cover the requested agent and known app tools only; they are not OAuth scope evidence or a complete audit of raw HTTP/static-secret rules.',
      'Preparation only writes a private review bundle. It never writes gateway state, switches a backend, restarts services or changes OneCLI grants.',
    ],
    groups: plans,
  };
}

export function prepareMigrationBundle(
  inventory: MigrationInventory,
  groupId: string,
  confirmation: string,
  expectedDigest: string,
  outputDirectory: string,
): string {
  if (!groupId || confirmation !== groupId) throw new Error('--confirm-group must exactly match the selected --group');
  const plan = inventory.groups.find((g) => g.group.id === groupId);
  if (!plan) throw new Error('Selected group is absent from the current inventory');
  if (plan.group.backend !== 'onecli') throw new Error('This group is already on Agent Vault');
  if (!plan.sourceAgentId || plan.blockers.includes('ambiguous-source-agent'))
    throw new Error('Resolve the missing/ambiguous source agent before preparation');
  if (expectedDigest !== plan.digest)
    throw new Error('Plan digest changed or was not confirmed; review a fresh inventory');
  if (!path.isAbsolute(outputDirectory)) throw new Error('--out must be an absolute path to a new private directory');
  const manifest = path.join(outputDirectory, 'bundle.json');
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        schemaVersion: 1,
        preparedAt: new Date().toISOString(),
        purpose: 'metadata-review-only',
        source: inventory.source,
        liveChanges: false,
        readyToCutover: false,
        warnings: inventory.warnings,
        plan,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  return manifest;
}
