import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const address = process.env.NANOCLAW_TEST_GATEWAY_URL;
const tokenFile = process.env.NANOCLAW_TEST_GATEWAY_TOKEN_FILE;
const gateway = address ? URL.parse(address) : null;
if (
  !gateway ||
  !['http:', 'https:'].includes(gateway.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname) ||
  !gateway.port ||
  gateway.port === '14321' ||
  !tokenFile
)
  throw new Error(
    'Provide an ephemeral loopback test gateway and its temporary token file; live defaults are forbidden',
  );
const tokenPath = fs.realpathSync(tokenFile);
const temporaryRoot = fs.realpathSync(os.tmpdir()) + path.sep;
if (!tokenPath.startsWith(temporaryRoot) || (fs.statSync(tokenPath).mode & 0o777) !== 0o600)
  throw new Error('The test token must be a mode-0600 file below the test temporary root');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-real-gateway-'));
const previous = process.cwd();
process.chdir(root);
process.env.NANOCLAW_AGENT_VAULT_URL = gateway.origin;
process.env.AGENT_VAULT_BOOTSTRAP_TOKEN_FILE = tokenPath;

const { closeDb, initTestDb, runMigrations } = await import('../src/db/index.js');
const { grantRole } = await import('../src/modules/permissions/db/user-roles.js');
const { AgentVaultError } = await import('../src/modules/credentials/agent-vault-client.js');
const { flushManagedUsers } = await import('../src/modules/credentials/managed-users.js');
const {
  changeConnectionApp,
  createConnection,
  deleteConnection,
  detachConnection,
  getConnection,
  grantConnection,
  groupConnectionAccess,
  listConnectionApps,
  listConnections,
  updateConnection,
} = await import('../src/modules/credentials/shared-connections.js');

function denied(error: unknown): boolean {
  return error instanceof AgentVaultError && [403, 404].includes(error.status || 0);
}

try {
  const db = initTestDb();
  runMigrations(db);
  const alice = randomUUID(),
    bob = randomUUID(),
    now = new Date().toISOString();
  for (const [id, label] of [
    [alice, 'Alice test'],
    [bob, 'Bob test'],
  ])
    db.prepare('INSERT INTO users(id,kind,display_name,created_at) VALUES(?,?,?,?)').run(id, 'test', label, now);
  for (const id of ['ag-host-one', 'ag-host-two'])
    db.prepare('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)').run(id, id, id, now);
  grantRole({ user_id: alice, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  grantRole({ user_id: bob, role: 'admin', agent_group_id: 'ag-host-two', granted_by: alice, granted_at: now });
  await flushManagedUsers();

  const service = {
    name: 'search',
    host: 'api.example.test/search',
    https_only: true,
    auth: { type: 'bearer', token: 'SEARCH_KEY' },
  };
  const created = await createConnection(alice, {
    label: 'Shared search test',
    kind: 'static',
    services: [service],
    values: { SEARCH_KEY: 'synthetic-key-one' },
  });
  assert.equal(created.kind, 'static');
  assert.equal(created.status, 'ready');
  assert.deepEqual(created.grants, []);
  assert(!JSON.stringify(created).includes('synthetic-key-one'));
  await grantConnection(alice, created.id, 'ag-host-one', { services: ['search'] });
  await grantConnection(alice, created.id, 'ag-host-two', { services: ['search'] });
  const shared = await getConnection(alice, created.id);
  assert.equal(shared.grants.length, 2);
  assert(shared.grants.every((grant) => grant.status === 'active'));

  const recipient = await groupConnectionAccess(bob, 'ag-host-two');
  assert(recipient.some((grant) => grant.connection_id === created.id));
  await assert.rejects(getConnection(bob, created.id), denied);
  await assert.rejects(grantConnection(bob, created.id, 'ag-host-two', { services: ['search'] }), denied);
  const rotated = await updateConnection(alice, created.id, {
    revision: shared.revision,
    values: { SEARCH_KEY: 'synthetic-key-two' },
  });
  assert(rotated.grants.every((grant) => grant.status === 'active'));
  assert(!JSON.stringify(rotated).includes('synthetic-key-two'));
  await assert.rejects(
    updateConnection(alice, created.id, { revision: shared.revision, label: 'Stale update' }),
    (error: unknown) => error instanceof AgentVaultError && [409, 412].includes(error.status || 0),
  );
  await detachConnection(bob, created.id, 'ag-host-two');
  const remaining = await getConnection(alice, created.id);
  assert.deepEqual(
    remaining.grants.map((grant) => grant.vault),
    ['ag-host-one'],
  );

  const privateConnection = await createConnection(bob, {
    label: 'Bob private test',
    kind: 'static',
    services: [service],
    values: { SEARCH_KEY: 'synthetic-private-key' },
  });
  await assert.rejects(getConnection(alice, privateConnection.id), denied);
  assert(!(await listConnections(alice)).some((connection) => connection.id === privateConnection.id));

  const app = {
    issuer: 'https://auth.example.test',
    client_id: 'synthetic-public-client',
    token_endpoint_auth_method: 'none',
    authorization_endpoint: 'https://auth.example.test/authorize',
    token_endpoint: 'https://auth.example.test/token',
    api_hosts: ['api.example.test'],
    default_scopes: ['read'],
  };
  await changeConnectionApp(bob, 'private-test-app', 'PUT', 'user', { config: app });
  assert((await listConnectionApps(bob)).some((item) => item.id === 'private-test-app' && item.source === 'user'));
  assert(!(await listConnectionApps(alice)).some((item) => item.id === 'private-test-app'));
  await changeConnectionApp(alice, 'install-test-app', 'PUT', 'install', { config: app });
  assert((await listConnectionApps(bob)).some((item) => item.id === 'install-test-app' && item.source === 'install'));

  const latest = await getConnection(alice, created.id);
  await deleteConnection(alice, created.id, latest.revision);
  assert(!(await listConnections(alice)).some((connection) => connection.id === created.id));
  assert.equal((await getConnection(bob, privateConnection.id)).status, 'ready');

  db.prepare('DELETE FROM user_roles WHERE user_id=?').run(bob);
  await flushManagedUsers();
  await assert.rejects(groupConnectionAccess(bob, 'ag-host-two'));
  db.prepare('DELETE FROM users WHERE id=?').run(bob);
  await flushManagedUsers();
  console.log(
    'Real host-to-gateway contract passed: native users, owned libraries, shared grants, rotation, stale writes, detach isolation, private/install apps and role/deletion synchronization.',
  );
} finally {
  closeDb();
  process.chdir(previous);
  fs.rmSync(root, { recursive: true, force: true });
}
