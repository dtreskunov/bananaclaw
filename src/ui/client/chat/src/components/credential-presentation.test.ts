import { describe, expect, it } from 'vitest';
import { accessGroups, connectionName, displayDestination, serviceDestination } from './credential-presentation';
import type { Connection } from './CredentialsApi';

const connection: Connection = {
  id: 'key',
  label: 'ag-1779840987143-r0nb8p/onecli-6826e53ef9c6a79285bf',
  kind: 'static',
  status: 'ready',
  revision: '"one"',
  owner: { id: 'owner' },
  services: [
    { name: 'onecli-6826e53ef9c6a79285bf', host: 'ai-gateway.vercel.sh/*', auth: { type: 'bearer', token: 'KEY' } },
  ],
  credentials: ['KEY'],
  grants: [],
};

describe('credential display names', () => {
  it('hides only the default HTTPS port without changing destinations or non-default ports', () => {
    const service = { ...connection.services[0], host: 'api.example.com:443/api/*' };
    expect(serviceDestination(service)).toBe('https://api.example.com/api/*');
    expect(service.host).toBe('api.example.com:443/api/*');
    expect(displayDestination('api.example.com:8443/path:443')).toBe('api.example.com:8443/path:443');
    expect(displayDestination('[::1]:443/api')).toBe('[::1]/api');
    expect(displayDestination('https://accounts.example.com:443/oauth')).toBe('https://accounts.example.com/oauth');
  });
  it('uses the service instead of migration IDs without changing stored names', () => {
    expect(connectionName(connection)).toBe('Vercel AI Gateway');
    expect(connection.label).toContain('onecli-');
    expect(serviceDestination(connection.services[0])).toBe('https://ai-gateway.vercel.sh/*');
  });
  it('preserves useful user-assigned labels', () => {
    expect(connectionName({ ...connection, label: 'Work account' })).toBe('Work account');
  });
  it('uses configured OAuth app labels and exact host fallbacks', () => {
    expect(connectionName({ ...connection, app_id: 'google' })).toBe('Google');
    expect(connectionName({ ...connection, resource_url: 'https://private.example.com/mcp' })).toBe(
      'private.example.com',
    );
  });
  it('includes existing grants without exposing unavailable agent IDs as names', () => {
    expect(
      accessGroups(
        [{ ...connection, grants: [{ vault: 'hidden-id', services: ['api'], status: 'active' }] }],
        [
          { id: 'admin', name: 'My Agent', canAdmin: true },
          { id: 'other', name: 'Other', canAdmin: false },
        ],
      ),
    ).toEqual([
      { id: 'admin', name: 'My Agent', canAdmin: true },
      { id: 'hidden-id', name: 'Unavailable agent', canAdmin: false },
    ]);
  });
});
