import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Agent, AgentGrants, EffectiveAppPermissions, EffectiveCredentials } from '@onecli-sh/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMigrationPlan,
  collectMigrationInventory,
  parseSecretMetadata,
  prepareMigrationBundle,
  summarizeMcpClients,
  type MigrationGroup,
  type MigrationInventory,
  type MigrationTarget,
  type SecretMetadata,
} from './onecli-migration.js';

const group: MigrationGroup = {
  id: 'ag-example',
  name: 'Example',
  backend: 'onecli',
  provider: 'native',
  mcpServerCount: 2,
};
const agent: Agent = {
  id: 'onecli-uuid',
  identifier: group.id,
  name: 'Old name',
  isDefault: false,
  createdAt: '2026-01-01',
};
const target: MigrationTarget = { exists: false, credentialKeys: [], services: [] };
const secret: SecretMetadata = {
  id: 'source-secret',
  name: 'Example key',
  type: 'generic',
  host: 'api.example.com',
  path: '/v1/*',
  header: 'Authorization',
  queryParameter: null,
  format: 'Bearer {value}',
  authMode: null,
};
const grants: AgentGrants = {
  agentId: agent.id,
  mode: 'grants',
  connections: [],
  secrets: [{ secretId: secret.id, name: secret.name, type: 'generic', scope: 'project' }],
};
const effective: EffectiveCredentials = {
  agentId: agent.id,
  mode: 'selective',
  connections: [],
  secrets: [{ kind: 'secret', id: secret.id, name: secret.name, host: secret.host!, status: 'usable', provenance: [] }],
};
const plan = (
  metadata: SecretMetadata[] = [secret],
  g: AgentGrants = grants,
  e: EffectiveCredentials = effective,
  t: MigrationTarget = target,
) => buildMigrationPlan(group, [agent], metadata, g, e, t);

let temporary: string | undefined;
afterEach(() => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

describe('metadata-only input', () => {
  it('projects only needed metadata and does not retain value/opRef/arbitrary fields', () => {
    const raw = [
      {
        id: secret.id,
        name: secret.name,
        type: 'generic',
        hostPattern: secret.host,
        pathPattern: secret.path,
        injectionConfig: { headerName: 'Authorization', valueFormat: secret.format, value: 'DO_NOT_EXPORT' },
        value: 'DO_NOT_EXPORT',
        opRef: 'DO_NOT_EXPORT',
        metadata: { authMode: 'api-key', password: 'DO_NOT_EXPORT' },
      },
    ];
    const metadata = parseSecretMetadata(raw);
    expect(metadata[0]).toMatchObject({ id: secret.id, format: secret.format, authMode: 'api-key' });
    expect(JSON.stringify(metadata)).not.toContain('DO_NOT_EXPORT');
    expect(parseSecretMetadata({ data: raw })).toEqual(metadata);
  });

  it.each([null, {}, { data: {} }, [null], [{ id: 'x' }]])('rejects malformed source metadata', (input) => {
    expect(() => parseSecretMetadata(input)).toThrow();
  });

  it('rejects duplicate IDs instead of choosing one entry', () => {
    const value = { id: 'id', name: 'name', type: 'generic' };
    expect(() => parseSecretMetadata([value, value])).toThrow('Duplicate');
  });
});

describe('safe migration planning', () => {
  it('uses exact identifiers, not display names, and generates a stable missing-value template', () => {
    const result = plan();
    expect(result.sourceAgentId).toBe(agent.id);
    expect(result.staticKeys[0]).toMatchObject({
      state: 'needs-value',
      destination: { match: 'api.example.com/v1/*', injection: { type: 'bearer' } },
    });
    expect(result.staticKeys[0]!.key).toMatch(/^ONECLI_[A-F0-9]{20}$/);
    expect(result.staticKeys[0]!.service?.auth.token).toBe(result.staticKeys[0]!.key);
    expect(result.readyToCutover).toBe(false);
    expect(result.policyReviewRequired).toBe(true);
    expect(plan().digest).toBe(result.digest);
  });

  it('does not clone unrelated secrets, including when source mode is all', () => {
    const result = plan(
      [secret, { ...secret, id: 'unrelated', name: 'Unrelated secret' }],
      { ...grants, mode: 'all', secrets: [] },
      { ...effective, mode: 'all' },
    );
    expect(result.staticKeys.map((s) => s.sourceId)).toEqual([secret.id]);
  });

  it('keeps blocked, limited and missing effective credentials non-migratable', () => {
    for (const status of ['blocked', 'limited', 'unknown'] as const) {
      const current: EffectiveCredentials = {
        ...effective,
        secrets: [{ kind: 'secret', id: secret.id, name: secret.name, host: secret.host!, status, provenance: [] }],
      };
      const result = plan([secret], grants, current).staticKeys[0]!;
      expect(result.state).toBe('source-restricted');
      expect(result.service).toBeUndefined();
    }
    expect(plan([secret], grants, { ...effective, secrets: [] }).staticKeys[0]!.state).toBe('source-restricted');
  });

  it('does not invent destinations when metadata or supported formats are missing', () => {
    expect(plan([]).staticKeys[0]!.state).toBe('manual-review');
    const result = plan([{ ...secret, format: 'DO_NOT_EXPORT_LITERAL' }]);
    expect(result.staticKeys[0]!.service).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT_LITERAL');
    expect(plan([{ ...secret, host: 'other.example.com' }]).staticKeys[0]!.service).toBeUndefined();
    expect(plan([{ ...secret, host: '*.example.com' }]).staticKeys[0]!.service).toBeUndefined();
  });

  it('preserves pre-encoded Basic values rather than encoding them again', () => {
    expect(plan([{ ...secret, format: 'Basic {value}' }]).staticKeys[0]!.destination?.injection).toEqual({
      type: 'api-key',
      name: 'Authorization',
      prefix: 'Basic ',
    });
  });

  it('preserves named-header injection', () => {
    expect(
      plan([{ ...secret, header: 'X-App-Token', format: '{value}' }]).staticKeys[0]!.destination?.injection,
    ).toEqual({
      type: 'api-key',
      name: 'X-App-Token',
    });
  });

  it('marks query-parameter client rewiring explicitly', () => {
    const result = plan([{ ...secret, header: null, queryParameter: 'apiKey', format: '{value}' }]).staticKeys[0]!;
    expect(result.queryParameter).toBe('apiKey');
    expect(result.destination?.injection).toEqual({ type: 'query', name: `__${result.key}__` });
    expect(result.actions.some((a) => a.includes('query parameter'))).toBe(true);
  });

  it('only infers the documented Anthropic API-key mode, not OAuth token headers', () => {
    expect(
      plan([{ ...secret, type: 'anthropic', format: null, authMode: 'api-key' }]).staticKeys[0]!.destination?.injection,
    ).toEqual({
      type: 'api-key',
      name: 'x-api-key',
    });
    expect(plan([{ ...secret, type: 'anthropic', authMode: 'oauth' }]).staticKeys[0]!.service).toBeUndefined();
  });

  it('requires review for invalid destinations without echoing their contents', () => {
    const result = plan([{ ...secret, path: '/api?token=DO_NOT_EXPORT' }]);
    expect(result.staticKeys[0]!.state).toBe('manual-review');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT');
  });

  it('preserves existing target state and flags collisions', () => {
    const current = plan();
    const key = current.staticKeys[0]!.key;
    expect(
      plan([secret], grants, effective, { ...target, exists: true, credentialKeys: [key] }).staticKeys[0]!.state,
    ).toBe('target-exists');
    const t: MigrationTarget = {
      ...target,
      services: [{ name: 'existing', host: 'api.example.com', auth: { type: 'bearer', token: 'EXISTING_KEY' } }],
    };
    const before = JSON.stringify(t);
    expect(plan([secret], grants, effective, t).staticKeys[0]!.state).toBe('target-exists');
    expect(JSON.stringify(t)).toBe(before);
  });

  it('requires manual resolution of overlapping source credentials', () => {
    const second: SecretMetadata = { ...secret, id: 'second', name: 'Other key', path: '/different/*' };
    const e: EffectiveCredentials = {
      ...effective,
      secrets: [
        ...effective.secrets,
        { kind: 'secret', id: second.id, name: second.name, host: second.host!, status: 'usable', provenance: [] },
      ],
    };
    expect(plan([secret, second], grants, e).staticKeys.every((s) => s.state === 'manual-review')).toBe(true);
  });

  it('does not use a default or ambiguous source agent', () => {
    expect(buildMigrationPlan(group, [{ ...agent, isDefault: true }], [], null, null, target).blockers).toContain(
      'no-source-agent',
    );
    expect(buildMigrationPlan(group, [agent, { ...agent, id: 'another' }], [], null, null, target).blockers).toContain(
      'ambiguous-source-agent',
    );
  });

  it('rejects mismatched agent metadata', () => {
    expect(() => plan([secret], { ...grants, agentId: 'other' })).toThrow('mismatched');
  });

  it('reports OAuth reconnect and custom approval requirements without copying tokens', () => {
    const g: AgentGrants = {
      ...grants,
      connections: [
        {
          connectionId: 'connection',
          provider: 'gmail',
          label: 'Personal',
          scope: 'project',
          access: 'custom',
          allow: ['read'],
          ask: ['send'],
        },
      ],
    };
    const e: EffectiveCredentials = {
      ...effective,
      connections: [
        {
          kind: 'connection',
          id: 'connection',
          label: 'Personal',
          provider: 'gmail',
          status: 'limited',
          provenance: [],
        },
      ],
    };
    expect(plan([secret], g, e).accounts[0]).toMatchObject({
      action: 'review-source-access',
      restricted: true,
      approvalToolCount: 1,
      allowedTools: ['read'],
      approvalTools: ['send'],
    });
  });

  it('invalidates the digest when policy details or same-count target metadata change', () => {
    const first = plan();
    expect(plan([secret], { ...grants, mode: 'all' }).digest).not.toBe(first.digest);
    const t = { ...target, services: [{ name: 'x', host: 'unrelated.example', auth: { type: 'passthrough' } }] };
    const changed = { ...target, services: [{ name: 'y', host: 'different.example', auth: { type: 'passthrough' } }] };
    expect(plan([secret], grants, effective, t).digest).not.toBe(plan([secret], grants, effective, changed).digest);
  });
});

describe('readonly workload readiness', () => {
  const connectionGrants: AgentGrants = {
    ...grants,
    connections: [
      {
        connectionId: 'connection',
        provider: 'mail',
        label: 'Personal',
        scope: 'project',
        access: 'full',
        allow: [],
        ask: [],
      },
    ],
  };
  const connectionEffective: EffectiveCredentials = {
    ...effective,
    connections: [
      { kind: 'connection', id: 'connection', provider: 'mail', label: 'Personal', status: 'usable', provenance: [] },
    ],
  };
  const appPolicy: EffectiveAppPermissions = {
    provider: 'mail',
    basis: { agentId: agent.id, scope: 'project', credentialAttached: true },
    variesByIdentity: 0,
    groups: [
      {
        category: 'read',
        verdict: 'allow',
        tools: [{ toolId: 'mail-read', verdict: 'allow', rateLimit: null, rateLimitWindow: null, decidedBy: null }],
      },
    ],
  };

  it('records agent-specific effective tool policy without declaring complete policy parity', () => {
    const result = buildMigrationPlan(group, [agent], [secret], connectionGrants, connectionEffective, target, [
      appPolicy,
    ]);
    expect(result.appPolicies).toMatchObject([
      {
        provider: 'mail',
        credentialAttached: true,
        sourceScope: 'project',
        tools: [{ id: 'mail-read', verdict: 'allow' }],
      },
    ]);
    expect(result.accounts[0]!.restricted).toBe(false);
    expect(result.policyReviewRequired).toBe(true);
    expect(result.readyToCutover).toBe(false);
  });

  it('does not lose effective approvals or rate limits when grants say full', () => {
    const approval: EffectiveAppPermissions = {
      ...appPolicy,
      groups: [
        { category: 'read', verdict: 'approval', tools: [{ ...appPolicy.groups[0]!.tools[0]!, verdict: 'approval' }] },
      ],
    };
    const result = buildMigrationPlan(group, [agent], [secret], connectionGrants, connectionEffective, target, [
      approval,
    ]);
    expect(result.accounts[0]).toMatchObject({
      access: 'full',
      restricted: true,
      approvalToolCount: 1,
      approvalTools: ['mail-read'],
      action: 'review-source-access',
    });
    expect(result.blockers).toContain('source-tool-policy-required:mail');
    const limited: EffectiveAppPermissions = {
      ...appPolicy,
      groups: [{ category: 'read', verdict: 'allow', tools: [{ ...appPolicy.groups[0]!.tools[0]!, rateLimit: 5 }] }],
    };
    expect(
      buildMigrationPlan(group, [agent], [secret], connectionGrants, connectionEffective, target, [limited])
        .accounts[0]!.restricted,
    ).toBe(true);
  });

  it('rejects another agent policy and treats absent tool coverage as unresolved', () => {
    expect(() =>
      buildMigrationPlan(group, [agent], [secret], connectionGrants, connectionEffective, target, [
        { ...appPolicy, basis: { ...appPolicy.basis, agentId: 'other-agent' } },
      ]),
    ).toThrow('Mismatched');
    expect(
      buildMigrationPlan(group, [agent], [secret], connectionGrants, connectionEffective, target, [
        { ...appPolicy, groups: [] },
      ]).accounts[0]!.restricted,
    ).toBe(true);
  });

  it('exports client names and hosts but no credentials, URL paths, arguments or query values', () => {
    const clients = summarizeMcpClients({
      remote: {
        type: 'http',
        url: 'https://user:DO_NOT_EXPORT@api.example.com/DO_NOT_EXPORT?token=DO_NOT_EXPORT&resource=x',
        headers: { Authorization: 'DO_NOT_EXPORT' },
      },
      local: {
        command: '/usr/bin/node',
        args: ['--key', 'DO_NOT_EXPORT'],
        env: {
          API_KEY: 'DO_NOT_EXPORT',
          HTTPS_PROXY: 'http://user:DO_NOT_EXPORT@proxy.invalid',
          NODE_EXTRA_CA_CERTS: '/DO_NOT_EXPORT',
          SAFE: 'also-private',
        },
      },
    });
    expect(JSON.stringify(clients)).not.toContain('DO_NOT_EXPORT');
    expect(JSON.stringify(clients)).not.toContain('also-private');
    expect(clients.find((c) => c.name === 'remote')).toMatchObject({
      host: 'api.example.com',
      headerNames: ['Authorization'],
      queryParameters: ['resource', 'token'],
    });
    expect(clients.find((c) => c.name === 'remote')!.review.some((r) => r.startsWith('inline-url-credentials'))).toBe(
      true,
    );
    expect(clients.find((c) => c.name === 'local')).toMatchObject({
      command: 'node',
      credentialEnvNames: ['API_KEY'],
      gatewayEnvNames: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'],
      transport: 'stdio',
    });
  });

  it('flags plaintext/network review and unsupported or invalid clients without echoing their URL', () => {
    const clients = summarizeMcpClients({
      lan: { type: 'http', url: 'http://10.0.1.105:8087/private' },
      unknown: { type: 'other', url: 'DO_NOT_EXPORT' },
      invalid: { type: 'http', url: 'DO_NOT_EXPORT' },
      command: { command: 'node --key=DO_NOT_EXPORT' },
    });
    expect(JSON.stringify(clients)).not.toContain('DO_NOT_EXPORT');
    expect(clients.find((c) => c.name === 'lan')!.review.some((r) => r.startsWith('plaintext-endpoint'))).toBe(true);
    expect(clients.find((c) => c.name === 'unknown')!.transport).toBe('unsupported');
    expect(clients.find((c) => c.name === 'invalid')!.review.some((r) => r.startsWith('invalid-endpoint'))).toBe(true);
    expect(clients.find((c) => c.name === 'command')!.command).toBeNull();
  });

  it('identifies complementary headers without assuming values are equal or enabling import', () => {
    const second = { ...secret, id: 'anthropic-key', type: 'anthropic', authMode: 'api-key' };
    const e: EffectiveCredentials = {
      ...effective,
      secrets: [
        ...effective.secrets,
        { kind: 'secret', id: second.id, name: second.name, host: secret.host!, status: 'usable', provenance: [] },
      ],
    };
    const result = plan([secret, second], grants, e);
    expect(result.routingReviews).toHaveLength(1);
    const review = result.routingReviews[0]!;
    expect(review.kind).toBe('complementary-headers');
    expect(review.applySupported).toBe(true);
    expect(Object.keys(review.serviceProposal!.auth.headers!).sort()).toEqual(['Authorization', 'x-api-key']);
    const templates = JSON.stringify(review.serviceProposal);
    expect(result.staticKeys.every((key) => templates.includes(key.key))).toBe(true);
    expect(result.staticKeys.every((key) => key.state === 'manual-review')).toBe(true);
    expect(result.readyToCutover).toBe(false);
  });

  it('identifies query parameters that must be added, not only existing placeholders to replace', () => {
    for (const queryParameters of [[], ['apiKey']]) {
      const clients = summarizeMcpClients({
        Remote: {
          type: 'http',
          url: `https://api.example.com/mcp${queryParameters.length ? '?apiKey=DO_NOT_EXPORT' : ''}`,
        },
      });
      const meta = { ...secret, header: null, queryParameter: 'apiKey', format: '{value}' };
      const result = buildMigrationPlan({ ...group, mcpClients: clients }, [agent], [meta], grants, effective, target);
      expect(result.queryClientRewires).toEqual([
        {
          client: 'Remote',
          sourceId: meta.id,
          parameter: 'apiKey',
          placeholder: `__${result.staticKeys[0]!.key}__`,
          action: queryParameters.length ? 'replace-parameter' : 'add-parameter',
          exactResourceMatchVerified: false,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT');
    }
  });

  it('does not combine conflicting header selectors or widen different paths', () => {
    for (const second of [
      { ...secret, id: 'other', header: 'authorization', format: 'Token {value}' },
      { ...secret, id: 'other', header: 'X-Api-Key', path: '/different/*', format: '{value}' },
    ]) {
      const e: EffectiveCredentials = {
        ...effective,
        secrets: [
          ...effective.secrets,
          { kind: 'secret', id: second.id, name: second.name, host: secret.host!, status: 'usable', provenance: [] },
        ],
      };
      const review = plan([secret, second], grants, e).routingReviews[0]!;
      expect(review.kind).toBe('overlapping-recipients');
      expect(review.serviceProposal).toBeUndefined();
    }
  });

  it('groups matching OAuth labels as unverified review hints, never a deduplication or scope union', () => {
    const g: AgentGrants = {
      ...grants,
      connections: [
        {
          connectionId: 'one',
          provider: 'service-one',
          label: 'same@example.com',
          scope: 'project',
          access: 'full',
          allow: [],
          ask: [],
        },
        {
          connectionId: 'two',
          provider: 'service-two',
          label: 'same@example.com',
          scope: 'project',
          access: 'full',
          allow: [],
          ask: [],
        },
      ],
    };
    const e: EffectiveCredentials = {
      ...effective,
      connections: g.connections.map((c) => ({
        kind: 'connection',
        id: c.connectionId,
        provider: c.provider,
        label: c.label,
        status: 'usable',
        provenance: [],
      })),
    };
    const result = plan([secret], g, e);
    expect(result.accounts).toHaveLength(2);
    expect(result.accountReviewGroups).toMatchObject([
      {
        label: 'same@example.com',
        sourceIds: ['one', 'two'],
        providers: ['service-one', 'service-two'],
        identityVerified: false,
        scopeUnionKnown: false,
      },
    ]);
  });
});

describe('collection and confirmed private staging', () => {
  const inventory = (p = plan()): MigrationInventory => ({
    schemaVersion: 1,
    generatedAt: 'now',
    source: 'https://onecli.example',
    metadataOnly: true,
    liveChanges: false,
    warnings: [],
    groups: [p],
  });

  it('uses only read clients and skips grant reads for already-migrated groups', async () => {
    const source = {
      listAgents: vi.fn().mockResolvedValue([agent]),
      listSecrets: vi.fn().mockResolvedValue([secret]),
      getAgentGrants: vi.fn().mockResolvedValue(grants),
      getEffectiveCredentials: vi.fn().mockResolvedValue(effective),
      getEffectiveAppPermissions: vi.fn(),
    };
    const migrated = { ...group, id: 'ag-migrated', backend: 'agent-vault' as const };
    const result = await collectMigrationInventory(
      [group, migrated],
      source,
      async () => target,
      'https://user:DO_NOT_EXPORT@onecli.example/path?key=DO_NOT_EXPORT',
    );
    expect(source.getAgentGrants).toHaveBeenCalledTimes(1);
    expect(source.getEffectiveCredentials).toHaveBeenCalledTimes(1);
    expect(source.getEffectiveAppPermissions).not.toHaveBeenCalled();
    expect(result.liveChanges).toBe(false);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPORT');
  });

  it('does not convert an unavailable source into an empty success report', async () => {
    const source = {
      listAgents: vi.fn().mockRejectedValue(new Error('source unavailable')),
      listSecrets: vi.fn().mockResolvedValue([]),
      getAgentGrants: vi.fn(),
      getEffectiveCredentials: vi.fn(),
      getEffectiveAppPermissions: vi.fn(),
    };
    await expect(
      collectMigrationInventory([group], source, async () => target, 'https://source.example'),
    ).rejects.toThrow('source unavailable');
  });

  it('reads project effective policies with the exact source agent identity and fails explicitly if unavailable', async () => {
    const policy: EffectiveAppPermissions = {
      provider: 'mail',
      basis: { agentId: agent.id, scope: 'project', credentialAttached: true },
      variesByIdentity: 0,
      groups: [],
    };
    const source = {
      listAgents: vi.fn().mockResolvedValue([agent]),
      listSecrets: vi.fn().mockResolvedValue([secret]),
      getAgentGrants: vi.fn().mockResolvedValue({
        ...grants,
        connections: [
          {
            connectionId: 'connection',
            provider: 'mail',
            label: 'Personal',
            scope: 'project',
            access: 'full',
            allow: [],
            ask: [],
          },
        ],
      }),
      getEffectiveCredentials: vi.fn().mockResolvedValue({
        ...effective,
        connections: [
          {
            kind: 'connection',
            id: 'connection',
            provider: 'mail',
            label: 'Personal',
            status: 'usable',
            provenance: [],
          },
        ],
      }),
      getEffectiveAppPermissions: vi.fn().mockResolvedValue(policy),
    };
    const result = await collectMigrationInventory([group], source, async () => target, 'https://source.example');
    expect(source.getEffectiveAppPermissions).toHaveBeenCalledWith({ provider: 'mail', agentId: agent.id });
    expect(result.groups[0]!.appPolicies).toHaveLength(1);
    source.getEffectiveAppPermissions.mockRejectedValue(new Error('policy read unavailable'));
    await expect(
      collectMigrationInventory([group], source, async () => target, 'https://source.example'),
    ).rejects.toThrow('policy read unavailable');
  });

  it('requires exact group and digest confirmation before writing anything', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migration-'));
    const out = path.join(temporary, 'bundle');
    const current = inventory();
    expect(() => prepareMigrationBundle(current, group.id, 'other', current.groups[0]!.digest, out)).toThrow(
      'confirm-group',
    );
    expect(() => prepareMigrationBundle(current, group.id, group.id, 'stale', out)).toThrow('digest');
    expect(fs.existsSync(out)).toBe(false);
    expect(() => prepareMigrationBundle(current, group.id, group.id, current.groups[0]!.digest, 'relative')).toThrow(
      'absolute',
    );
  });

  it('refuses preparation for already-migrated or missing-source groups', () => {
    const migrated = buildMigrationPlan({ ...group, backend: 'agent-vault' }, [], [], null, null, target);
    expect(() => prepareMigrationBundle(inventory(migrated), group.id, group.id, migrated.digest, '/unused')).toThrow(
      'already',
    );
    const missing = buildMigrationPlan(group, [], [], null, null, target);
    expect(() => prepareMigrationBundle(inventory(missing), group.id, group.id, missing.digest, '/unused')).toThrow(
      'source agent',
    );
  });

  it('creates a private metadata review bundle and never overwrites an existing directory', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migration-'));
    const out = path.join(temporary, 'bundle');
    const current = inventory();
    const file = prepareMigrationBundle(current, group.id, group.id, current.groups[0]!.digest, out);
    const contents = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(contents)).toMatchObject({
      purpose: 'metadata-review-only',
      liveChanges: false,
      readyToCutover: false,
    });
    expect(fs.statSync(out).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => prepareMigrationBundle(current, group.id, group.id, current.groups[0]!.digest, out)).toThrow('EEXIST');
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
  });
});
