/**
 * Read-only inventory and private review bundles.
 * Never exports values/tokens or changes credentials or the active backend.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OneCLI } from '@onecli-sh/sdk';
import Database from 'better-sqlite3';

import { DATA_DIR, ONECLI_API_KEY, ONECLI_URL } from '../src/config.js';
import { gatewayJson } from '../src/modules/credentials/agent-vault-client.js';
import { listCredentials, listServices } from '../src/modules/credentials/gateway-credentials.js';
import {
  collectMigrationInventory,
  parseSecretMetadata,
  prepareMigrationBundle,
  summarizeMcpClients,
  type MigrationGroup,
  type MigrationSource,
  type MigrationTarget,
} from '../src/modules/credentials/onecli-migration.js';

const HELP = `Usage:
  pnpm exec tsx scripts/migrate-from-onecli.ts [--group <id>]
  pnpm exec tsx scripts/migrate-from-onecli.ts --prepare --group <id> \\
    --confirm-group <same-id> --expect-digest <reviewed-plan-digest> \\
    --out <new-absolute-directory>

Default: JSON metadata inventory on stdout; no writes.
Includes client-rewiring hints and agent-specific project app-tool policy.
Those are not verified OAuth grants or proof of complete policy parity.
Prepare: re-read current metadata, require the reviewed group's digest, then
write a mode-0600 bundle.json in a NEW mode-0700 directory. Its parent must exist.
Prepare stages a review bundle ONLY. Vault-local provisioning was removed;
create user-owned connections once and grant selected agents access instead.
Neither mode connects accounts, changes backends/grants/client configs,
or restarts/retires OneCLI. Values never appear in output.
`;

export interface MigrationArgs {
  prepare: boolean;
  group?: string;
  confirmation?: string;
  digest?: string;
  out?: string;
}

export function parseArgs(argv: string[]): MigrationArgs {
  const args: MigrationArgs = { prepare: false };
  const flags = new Map<string, 'group' | 'confirmation' | 'digest' | 'out'>([
    ['--group', 'group'],
    ['--confirm-group', 'confirmation'],
    ['--expect-digest', 'digest'],
    ['--out', 'out'],
  ]);
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--prepare') {
      args.prepare = true;
      continue;
    }
    const field = flags.get(flag);
    if (!field) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    args[field] = value;
  }
  if (args.prepare) {
    if (!args.group || args.confirmation !== args.group || !args.digest || !args.out) {
      throw new Error(
        'Write modes require --group, matching --confirm-group, --expect-digest, and --out for preparation',
      );
    }
    if (!/^[a-f0-9]{64}$/.test(args.digest)) throw new Error('--expect-digest must be a reviewed SHA-256 plan digest');
    if (args.prepare && !path.isAbsolute(args.out!)) throw new Error('--out must be an absolute path');
  } else if (args.confirmation || args.digest || args.out) {
    throw new Error('Confirmation/output options require --prepare');
  }
  return args;
}

export function readGroups(dbPath: string, selected?: string): MigrationGroup[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT g.id, g.name, c.credential_backend AS backend,
      c.provider, c.mcp_servers FROM agent_groups g
      LEFT JOIN container_configs c ON c.agent_group_id = g.id ORDER BY g.id`,
      )
      .all() as {
      id: string;
      name: string;
      backend: string | null;
      provider: string | null;
      mcp_servers: string | null;
    }[];
    if (selected && !rows.some((g) => g.id === selected)) throw new Error('Selected group does not exist');
    return rows
      .filter((g) => !selected || g.id === selected)
      .map((g) => {
        if (g.backend !== null && g.backend !== 'onecli' && g.backend !== 'agent-vault')
          throw new Error('Unknown credential backend in group configuration');
        const servers: unknown = JSON.parse(g.mcp_servers ?? '{}');
        if (!servers || typeof servers !== 'object' || Array.isArray(servers))
          throw new Error('Invalid group MCP configuration');
        return {
          id: g.id,
          name: g.name,
          backend: g.backend === 'agent-vault' ? 'agent-vault' : 'onecli',
          provider: g.provider,
          mcpServerCount: Object.keys(servers).length,
          mcpClients: summarizeMcpClients(servers),
        };
      });
  } finally {
    db.close();
  }
}

export function readVaultNames(response: unknown): Set<string> {
  const vaults = response && typeof response === 'object' && 'vaults' in response ? response.vaults : null;
  if (
    !Array.isArray(vaults) ||
    !vaults.every(
      (v): v is { name: string } => Boolean(v) && typeof v === 'object' && 'name' in v && typeof v.name === 'string',
    )
  ) {
    throw new Error('Invalid gateway vault inventory');
  }
  return new Set(vaults.map((v) => v.name));
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(HELP);
    return;
  }
  const args = parseArgs(argv);
  if (!ONECLI_URL || !ONECLI_API_KEY) throw new Error('OneCLI configuration is required for migration inventory');
  const client = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
  const source: MigrationSource = {
    listAgents: () => client.listAgents(),
    getAgentGrants: (id) => client.getAgentGrants(id),
    getEffectiveCredentials: (id) => client.getEffectiveCredentials(id),
    getEffectiveAppPermissions: (input) => client.getEffectiveAppPermissions(input),
    listSecrets: async () => {
      const response = await fetch(`${ONECLI_URL.replace(/\/$/, '')}/v1/secrets`, {
        headers: { Authorization: `Bearer ${ONECLI_API_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`OneCLI secret metadata read failed: HTTP ${response.status}`);
      return parseSecretMetadata(await response.json());
    },
  };
  const groups = readGroups(path.join(DATA_DIR, 'v2.db'), args.group);
  const response: unknown = await gatewayJson('GET', '/v1/vaults', 'migration vault inventory');
  const names = readVaultNames(response);
  const readTarget = async (id: string): Promise<MigrationTarget> => {
    if (!names.has(id)) return { exists: false, credentialKeys: [], services: [] };
    const [credentials, services] = await Promise.all([listCredentials(id), listServices(id)]);
    return { exists: true, credentialKeys: credentials.map((c) => c.key).sort(), services };
  };
  const inventory = await collectMigrationInventory(groups, source, readTarget, ONECLI_URL);
  if (!args.prepare) console.log(JSON.stringify(inventory, null, 2));
  else {
    const manifest = prepareMigrationBundle(inventory, args.group!, args.confirmation!, args.digest!, args.out!);
    console.log(JSON.stringify({ manifest, liveChanges: false, readyToCutover: false }, null, 2));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Migration preparation failed');
    process.exitCode = 1;
  });
}
