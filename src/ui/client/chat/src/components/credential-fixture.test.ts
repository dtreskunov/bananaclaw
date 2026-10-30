import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSignIn, fixtureRoute, resetState, setOptions } from '../../fixtures/credentials-mock';
import {
  accessPath,
  connectionPath,
  credentialsPath,
  type AccessGrant,
  type Connection,
  type CredentialsOverview,
  type SignInProgress,
  type SignInStart,
} from './CredentialsApi';

function request<T>(path: string, method = 'GET', body?: unknown): T {
  return structuredClone(
    fixtureRoute(
      method,
      new URL(path, 'https://nanoclaw.example'),
      body === undefined ? undefined : { body: JSON.stringify(body) },
    ),
  ) as T;
}
beforeEach(() => {
  setOptions({ scenario: 'typical', gatewayDown: false, failNextWrite: false, canAdmin: true, owner: true });
  resetState();
  vi.stubGlobal('location', { pathname: '/fixture' });
});
afterEach(() => vi.unstubAllGlobals());

describe('canonical credentials fixture', () => {
  it('inspects scopes without changing credentials or consuming a pending write failure', () => {
    const before = request<CredentialsOverview>(credentialsPath());
    setOptions({ failNextWrite: true });
    expect(request(credentialsPath('/scopes'), 'POST', { resource_url: 'https://mcp.example.com/mcp' })).toMatchObject({
      scopes: ['read', 'write'],
      source: 'resource',
      oauth: true,
    });
    expect(request<CredentialsOverview>(credentialsPath())).toEqual(before);
    expect(() =>
      request(connectionPath('basic-pair'), 'PUT', {
        revision: before.connections[0].revision,
        label: 'Changed',
      }),
    ).toThrow('simulated');
  });
  it('stores one multi-key connection, rotates once and detaches one recipient only', () => {
    const original = request<Connection>(connectionPath('basic-pair'));
    expect(original.grants).toHaveLength(2);
    const rotated = request<Connection>(connectionPath(original.id), 'PUT', {
      revision: original.revision,
      values: { PASSWORD: 'replacement' },
    });
    expect(rotated.grants).toEqual(original.grants);
    expect(rotated).not.toHaveProperty('values');
    expect(rotated.credentials).toEqual(['USERNAME', 'PASSWORD']);
    request(accessPath('assistant', rotated.id), 'DELETE');
    expect(request<Connection>(connectionPath(rotated.id)).grants).toEqual([
      { vault: 'research', services: ['nextcloud'], status: 'active' },
    ]);
    expect(request<Connection>(connectionPath('mcp-account')).status).toBe('ready');
    expect(() =>
      request(connectionPath(original.id), 'PUT', {
        revision: original.revision,
        values: { PASSWORD: 'stale' },
      }),
    ).toThrow('Reload and review');
  });

  it('keeps other owners metadata out of personal and group access reads', () => {
    const overview = request<CredentialsOverview>(credentialsPath());
    const access = request<{ grants: AccessGrant[] }>(accessPath('assistant'));
    expect(overview.connections.every((connection) => connection.owner.id === 'native-alex')).toBe(true);
    expect(access.grants.find((grant) => grant.connection_id === 'sam-owned')).toBeUndefined();
    expect(() => request(connectionPath('sam-owned'))).toThrow('Unknown personal connection');
    request(accessPath('assistant', 'sam-owned'), 'DELETE');
    expect(
      request<{ grants: AccessGrant[] }>(accessPath('assistant')).grants.some(
        (grant) => grant.connection_id === 'sam-owned',
      ),
    ).toBe(false);
  });

  it('keeps whole-credential grants active after URL changes and enforces destination administration', () => {
    const item = request<Connection>(connectionPath('basic-pair'));
    const edited = request<Connection>(connectionPath(item.id), 'PUT', {
      revision: item.revision,
      services: [
        { ...item.services[0], host: 'new.example.com' },
        { ...item.services[0], name: 'added', host: 'added.example.com' },
      ],
    });
    expect(edited.grants.every((grant) => grant.status === 'active')).toBe(true);
    expect(edited.grants.every((grant) => grant.services.join(',') === 'nextcloud,added')).toBe(true);
    request(connectionPath(item.id, '/grants/assistant'), 'PUT', {
      revision: edited.revision,
    });
    expect(
      request<Connection>(connectionPath(item.id)).grants.find((grant) => grant.vault === 'assistant')?.status,
    ).toBe('active');
    setOptions({ canAdmin: false });
    expect(() =>
      request(connectionPath(item.id, '/grants/research'), 'PUT', {
        revision: edited.revision,
      }),
    ).toThrow('Destination administration');
  });

  it('starts and completes OAuth by connection ID without a group or scope union', () => {
    const draft = request<Connection>(credentialsPath('/connections'), 'POST', {
      label: 'New MCP',
      kind: 'mcp_oauth',
      resource_url: 'https://new.example.com/mcp',
      scopes: ['read'],
    });
    const started = request<SignInStart>(connectionPath(draft.id, '/start'), 'POST', {
      resource_url: 'https://new.example.com/mcp',
      scopes: ['read'],
    });
    const progress = credentialsPath(`/sign-ins/${started.state}`);
    expect(request<SignInProgress>(progress).status).toBe('pending');
    completeSignIn(started.state, true);
    expect(request<SignInProgress>(progress)).toMatchObject({ status: 'connected', connection_id: draft.id });
    const connected = request<Connection>(connectionPath(draft.id));
    expect(connected).toMatchObject({ status: 'ready', granted_scopes: ['read'], grants: [] });
    expect(connected).not.toHaveProperty('access_token');
    expect(connected.services).toHaveLength(1);
  });

  it('has generic personal apps, write-only client secrets and authorized install management', () => {
    const initial = request<CredentialsOverview>(credentialsPath()).apps[0];
    const { id: _id, source: _source, client_secret_set: _secret, ...config } = initial;
    request(credentialsPath('/oauth-apps/private?scope=user'), 'PUT', { config, clientSecret: 'never-returned' });
    const privateApp = request<CredentialsOverview>(credentialsPath()).apps.find((app) => app.id === 'private');
    expect(privateApp).toMatchObject({ source: 'user', client_secret_set: true });
    expect(privateApp).not.toHaveProperty('clientSecret');
    setOptions({ owner: false });
    expect(() => request(credentialsPath('/oauth-apps/example?scope=install'), 'DELETE')).toThrow(
      'Install administrator',
    );
  });
});
