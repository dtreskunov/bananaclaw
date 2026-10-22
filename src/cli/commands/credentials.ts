/**
 * `ncl credentials …` — static keys and MCP sign-ins in a group's credential
 * gateway vault. Host only: agent containers can never call these, whatever
 * their cli_scope (enforced in dispatch.ts).
 *
 *   ncl credentials list --group <id>
 *   ncl credentials set --group <id> --key <KEY> --value-stdin
 *       [--match <host[/path]> --type bearer|basic|api-key|query|custom
 *        --header <name> --prefix <text> --template '<Basic {{ KEY }}>' --label <name>]
 *   ncl credentials delete --group <id> --key <KEY>
 *   ncl credentials disconnect --group <id> --key <MCP_…>
 *
 * Values only arrive through --value-stdin (read by the client), so they never
 * appear in argv, shell history or process listings.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { AgentVaultError, gatewayMessage, usesAgentVault } from '../../modules/credentials/agent-vault-client.js';
import {
  disconnectMcp,
  forgetProbes,
  listCredentials,
  listMcpAccounts,
  listServices,
  servicesToKeys,
} from '../../modules/credentials/gateway-credentials.js';
import { addKey, deleteKey, KeyInputError, updateKey } from '../../modules/credentials/keys.js';
import { register } from '../registry.js';

export const CREDENTIALS_RESOURCE = 'credentials';

type Args = Record<string, unknown>;

function str(args: Args, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function groupArg(args: Args): string {
  const gid = str(args, 'group') ?? str(args, 'id');
  if (!gid) throw new Error('--group <agent-group-id> is required');
  if (!getAgentGroup(gid)) throw new Error(`no agent group ${gid}`);
  if (!usesAgentVault(gid)) throw new Error(`${gid} doesn't use the credential gateway (NANOCLAW_AGENT_VAULT_GROUPS)`);
  return gid;
}

function destinationArg(args: Args): unknown {
  const match = str(args, 'match');
  if (!match) return undefined;
  return {
    match,
    injection: {
      type: str(args, 'type') ?? 'bearer',
      name: str(args, 'header') ?? str(args, 'placeholder'),
      prefix: str(args, 'prefix'),
      template: str(args, 'template'),
    },
  };
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof KeyInputError) throw new Error(err.message, { cause: err });
    if (err instanceof AgentVaultError) {
      throw new Error(err.unreachable ? "The credential gateway isn't responding" : gatewayMessage(err), {
        cause: err,
      });
    }
    throw err;
  }
}

register({
  name: 'credentials-list',
  description: "List a group's gateway keys and MCP sign-ins (never values). Use --group <id>.",
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const gid = groupArg(args as Args);
      const [services, credentials, accounts] = await Promise.all([
        listServices(gid),
        listCredentials(gid),
        listMcpAccounts(gid),
      ]);
      const keys = servicesToKeys(services, credentials).map((k) => ({
        kind: 'key',
        key: k.key,
        name: k.label,
        status: k.status,
        sent_to: k.destination.match,
        how: k.destination.injection.type,
      }));
      const signIns = accounts.map((a) => ({
        kind: 'mcp',
        key: a.key,
        name: a.resource_url,
        status: a.status,
        sent_to: a.resource_url.replace(/^https?:\/\//, ''),
        how: `oauth (${a.client})`,
      }));
      return [...keys, ...signIns];
    }),
});

register({
  name: 'credentials-set',
  description:
    'Add a key, or replace its value/destination. Use --group <id> --key <KEY> --value-stdin [--match <host[/path]> --type bearer|basic|api-key|query|custom --header <name> --prefix <text> --template <tpl> --label <name>].',
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = groupArg(a);
      const key = str(a, 'key');
      if (!key) throw new Error('--key <KEY> is required');
      if (a.value !== undefined && a['value-stdin'] === undefined) {
        throw new Error('Pass the value with --value-stdin, not on the command line');
      }
      const value = typeof a.value === 'string' ? a.value : undefined;
      const destination = destinationArg(a);
      const label = str(a, 'label');
      const exists =
        (await listCredentials(gid)).some((c) => c.key === key) ||
        servicesToKeys(await listServices(gid), []).some((k) => k.key === key);
      if (exists) {
        const changed = await updateKey(gid, key, { value, destination, label });
        return `Updated ${key} in ${gid}: ${changed.join(', ')}`;
      }
      if (!destination) throw new Error(`${key} is new; say where it's sent with --match <host[/path]>`);
      await addKey(gid, { key, value, destination, label });
      return `Added ${key} to ${gid}`;
    }),
});

register({
  name: 'credentials-delete',
  description: 'Delete a key and the service that sends it. Use --group <id> --key <KEY>.',
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = groupArg(a);
      const key = str(a, 'key');
      if (!key) throw new Error('--key <KEY> is required');
      await deleteKey(gid, key);
      return `Deleted ${key} from ${gid}`;
    }),
});

register({
  name: 'credentials-disconnect',
  description: 'Disconnect an MCP sign-in (revokes its tokens). Use --group <id> --key <MCP_…>.',
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = groupArg(a);
      const key = str(a, 'key');
      if (!key?.startsWith('MCP_'))
        throw new Error('--key must be an MCP sign-in key (MCP_…); see `ncl credentials list`');
      await disconnectMcp(gid, key);
      forgetProbes(gid);
      return `Disconnected ${key} in ${gid}`;
    }),
});
