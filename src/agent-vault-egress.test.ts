import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentVaultEnvKeys,
  applyAgentVaultEgress,
  egressDirName,
  reconcileAgentVaultEgress,
  releaseAgentVaultEgress,
  usesAgentVault,
} from './agent-vault-egress.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { setCredentialBackend } from './db/container-configs.js';
import { getDb } from './db/connection.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const ENV_KEYS = [
  'NANOCLAW_AGENT_VAULT_GROUPS',
  'NANOCLAW_AGENT_VAULT_URL',
  'AGENT_VAULT_SOCKET_ROOT',
  'AGENT_VAULT_BOOTSTRAP_TOKEN_FILE',
];

interface FakeSession {
  id: string;
  vault: string;
  label: string;
  socket_path: string;
}

let tmp: string;
let server: http.Server;
let sessions: FakeSession[];
let requests: { method: string; url: string; auth?: string; body?: unknown }[];
let postStatus: number;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  runMigrations(initTestDb());
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'av-egress-')));
  fs.writeFileSync(path.join(tmp, 'host-token'), 'host-token-value\n');
  sessions = [];
  requests = [];
  postStatus = 201;
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      if (req.url === '/v1/mitm/ca.pem') return res.end(CA);
      if (req.url === '/v1/socket-sessions' && req.method === 'POST') {
        if (postStatus !== 201) {
          res.writeHead(postStatus);
          return res.end('{"error":"Unknown vault"}');
        }
        const session = {
          id: `s${sessions.length + 1}`,
          vault: body.vault,
          label: body.label,
          socket_path: path.join(body.dir, 'egress.sock'),
        };
        sessions.push(session);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: session.id, vault: session.vault, socket_path: session.socket_path }));
      }
      if (req.url === '/v1/socket-sessions' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items: sessions }));
      }
      const del = /^\/v1\/socket-sessions\/(.+)$/.exec(req.url!);
      if (del && req.method === 'DELETE') {
        const before = sessions.length;
        sessions = sessions.filter((s) => s.id !== del[1]);
        res.writeHead(sessions.length < before ? 204 : 404);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.NANOCLAW_AGENT_VAULT_GROUPS = 'ag-one, ag-two';
  process.env.NANOCLAW_AGENT_VAULT_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.AGENT_VAULT_SOCKET_ROOT = path.join(tmp, 'sessions');
  process.env.AGENT_VAULT_BOOTSTRAP_TOKEN_FILE = path.join(tmp, 'host-token');
});

afterEach(async () => {
  closeDb();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function envOf(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  args.forEach((arg, i) => {
    if (args[i - 1] !== '-e') return;
    const eq = arg.indexOf('=');
    out[arg.slice(0, eq)] = arg.slice(eq + 1);
  });
  return out;
}

describe('agent vault egress', () => {
  it('does not retain the spike-era environment override', () => {
    expect(usesAgentVault('ag-two')).toBe(false);
    expect(usesAgentVault('ag-three')).toBe(false);
  });

  it('switches groups whose credential_backend is agent-vault', () => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES ('ag-db', 'db', 'db', NULL, ?)`,
      )
      .run(now);
    getDb().prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES ('ag-db', ?)`).run(now);
    expect(usesAgentVault('ag-db')).toBe(false);
    setCredentialBackend('ag-db', 'agent-vault');
    expect(usesAgentVault('ag-db')).toBe(true);
    setCredentialBackend('ag-db', 'onecli');
    expect(usesAgentVault('ag-db')).toBe(false);
  });

  it('opens a socket session and mounts the socket directory and CA bundle', async () => {
    const args: string[] = [];
    await applyAgentVaultEgress(args, {
      containerName: 'nanoclaw-v2-one-1',
      agentGroupId: 'ag-one',
      label: 'agent:sess-1',
    });

    const dir = path.join(tmp, 'sessions', egressDirName('nanoclaw-v2-one-1'));
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.auth).toBe('Bearer host-token-value');
    expect(post.body).toEqual({ vault: 'ag-one', label: 'agent:sess-1', dir });
    expect(fs.statSync(dir).isDirectory()).toBe(true);

    const bundle = path.join(tmp, 'ca-bundle.pem');
    expect(fs.readFileSync(bundle, 'utf8')).toContain(CA);
    expect(args).toContain(`${dir}:/run/nanoclaw/egress:ro`);
    expect(args).toContain(`${bundle}:/run/nanoclaw/agent-vault-ca.pem:ro`);

    const env = envOf(args);
    expect(env.NANOCLAW_EGRESS_SOCKET).toBe('/run/nanoclaw/egress/egress.sock');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/run/nanoclaw/agent-vault-ca.pem');
    expect(Object.keys(env).sort()).toEqual([...agentVaultEnvKeys()].sort());
    expect(Object.values(env).join(' ')).not.toContain('host-token-value');
  });

  it('refuses to spawn and cleans up when the gateway rejects the session', async () => {
    postStatus = 404;
    await expect(
      applyAgentVaultEgress([], { containerName: 'nanoclaw-v2-one-2', agentGroupId: 'ag-missing', label: 'x' }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fs.readdirSync(path.join(tmp, 'sessions'))).toEqual([]);
  });

  it('refuses to spawn when the gateway is unreachable', async () => {
    process.env.NANOCLAW_AGENT_VAULT_URL = 'http://127.0.0.1:1';
    await expect(
      applyAgentVaultEgress([], { containerName: 'nanoclaw-v2-one-3', agentGroupId: 'ag-one', label: 'x' }),
    ).rejects.toThrow(/unreachable/);
  });

  it('releases only its own container session', async () => {
    await applyAgentVaultEgress([], { containerName: 'c-a', agentGroupId: 'ag-one', label: 'a' });
    await applyAgentVaultEgress([], { containerName: 'c-b', agentGroupId: 'ag-two', label: 'b' });
    await releaseAgentVaultEgress('c-a');
    expect(sessions.map((s) => s.label)).toEqual(['b']);
    expect(fs.readdirSync(path.join(tmp, 'sessions'))).toEqual([egressDirName('c-b')]);
  });

  it('keeps socket paths short for long container names, and refuses ones that would not fit', async () => {
    const long = `nanoclaw-mcp-probe-${'g'.repeat(48)}-1792565655463`;
    const args: string[] = [];
    await applyAgentVaultEgress(args, { containerName: long, agentGroupId: 'ag-one', label: 'probe' });
    const post = requests.find((r) => r.method === 'POST')!;
    expect(Buffer.byteLength(path.join((post.body as { dir: string }).dir, 'egress.sock'))).toBeLessThan(108);

    process.env.AGENT_VAULT_SOCKET_ROOT = path.join(tmp, 'x'.repeat(90));
    await expect(
      applyAgentVaultEgress([], { containerName: 'c-too-long', agentGroupId: 'ag-one', label: 'x' }),
    ).rejects.toThrow(/too long/);
    expect(fs.readdirSync(process.env.AGENT_VAULT_SOCKET_ROOT)).toEqual([]);
  });

  it('release is a no-op for OneCLI containers and survives a gateway outage', async () => {
    await releaseAgentVaultEgress('never-applied');
    expect(requests).toEqual([]);
    await applyAgentVaultEgress([], { containerName: 'c-down', agentGroupId: 'ag-one', label: 'd' });
    process.env.NANOCLAW_AGENT_VAULT_URL = 'http://127.0.0.1:1';
    await expect(releaseAgentVaultEgress('c-down')).resolves.toBeUndefined();
    expect(fs.readdirSync(path.join(tmp, 'sessions'))).toEqual([]);
  });

  it('reconciles sessions and directories for containers that are gone', async () => {
    await applyAgentVaultEgress([], { containerName: 'c-live', agentGroupId: 'ag-one', label: 'live' });
    await applyAgentVaultEgress([], { containerName: 'c-dead', agentGroupId: 'ag-one', label: 'dead' });
    sessions.push({
      id: 'foreign',
      vault: 'x',
      label: 'foreign',
      socket_path: `/elsewhere/${egressDirName('c-dead')}/egress.sock`,
    });
    fs.mkdirSync(path.join(tmp, 'sessions', 'c-orphan-dir'));

    await reconcileAgentVaultEgress(new Set(['c-live']));

    expect(sessions.map((s) => s.label).sort()).toEqual(['foreign', 'live']);
    expect(fs.readdirSync(path.join(tmp, 'sessions'))).toEqual([egressDirName('c-live')]);
  });
});
