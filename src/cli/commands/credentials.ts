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
 *   ncl credentials disconnect --group <id> --key <MCP_…|OAUTH_…>
 *   ncl credentials oauth-app set --group <id> --provider google|github --client-id <id>
 *       [--secret-stdin] [--install]
 *   ncl credentials oauth-app remove --group <id> --provider <id> [--install]
 *   ncl credentials backend get|set --group <id> [--backend onecli|agent-vault]
 *
 * Values and client secrets only arrive through --value-stdin / --secret-stdin
 * (read by the client), so they never appear in argv, shell history or process
 * listings. Connecting a provider account needs a browser: use group settings.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, setCredentialBackend } from '../../db/container-configs.js';
import {
  AgentVaultError,
  ensureVault,
  gatewayMessage,
  usesAgentVault,
} from '../../modules/credentials/agent-vault-client.js';
import {
  disconnectMcp,
  disconnectProvider,
  forgetAllProbes,
  forgetProbes,
  getApp,
  listCredentials,
  listMcpAccounts,
  listServices,
  servicesToKeys,
} from '../../modules/credentials/gateway-credentials.js';
import { addKey, deleteKey, KeyInputError, updateKey } from '../../modules/credentials/keys.js';
import {
  AppInputError,
  providerAccountsOrEmpty,
  providersOrEmpty,
  removeApp,
  saveApp,
} from '../../modules/credentials/oauth-apps.js';
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
  if (!usesAgentVault(gid)) {
    throw new Error(
      `${gid} doesn't use the credential gateway; run \`ncl credentials backend set --backend agent-vault\``,
    );
  }
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
    if (err instanceof KeyInputError || err instanceof AppInputError) throw new Error(err.message, { cause: err });
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
      const [services, credentials, accounts, providerAccounts, providers] = await Promise.all([
        listServices(gid),
        listCredentials(gid),
        listMcpAccounts(gid),
        providerAccountsOrEmpty(gid),
        providersOrEmpty(),
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
      const provider = providerAccounts.map((a) => ({
        kind: 'account',
        key: a.key,
        name: providers.find((p) => p.id === a.provider)?.label ?? a.provider ?? '',
        status: a.status,
        sent_to: (a.scope_sets ?? []).join(' '),
        how: 'oauth (app)',
      }));
      const apps = (
        await Promise.all(
          providers.map(async (p) => {
            const [install, group] = await Promise.all([getApp(null, p.id), getApp(gid, p.id)]);
            const rows = [];
            if (group)
              rows.push({ kind: 'app', key: p.id, name: group.client_id, status: 'this group', sent_to: '', how: '' });
            if (install) {
              rows.push({
                kind: 'app',
                key: p.id,
                name: install.client_id,
                status: group ? 'install (overridden)' : 'install',
                sent_to: '',
                how: '',
              });
            }
            return rows;
          }),
        )
      ).flat();
      return [...keys, ...signIns, ...provider, ...apps];
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
  description:
    'Disconnect an MCP sign-in or provider account (revokes its tokens). Use --group <id> --key <MCP_…|OAUTH_…>.',
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = groupArg(a);
      const key = str(a, 'key');
      if (key?.startsWith('OAUTH_')) await disconnectProvider(gid, key);
      else if (key?.startsWith('MCP_')) await disconnectMcp(gid, key);
      else throw new Error('--key must be an account key (MCP_… or OAUTH_…); see `ncl credentials list`');
      forgetProbes(gid);
      return `Disconnected ${key} in ${gid}`;
    }),
});

register({
  name: 'credentials-oauth-app-set',
  description:
    'Set an OAuth app for a provider. Use --group <id> --provider google|github --client-id <id> [--secret-stdin] [--install]. The secret is required for a new client ID; --install sets the install-wide app every group uses unless it has its own.',
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = groupArg(a);
      const provider = str(a, 'provider');
      if (!provider) throw new Error('--provider <id> is required');
      if (a.secret !== undefined && a['secret-stdin'] === undefined) {
        throw new Error('Pass the client secret with --secret-stdin, not on the command line');
      }
      const saved = await saveApp(
        gid,
        provider,
        { scope: a.install === true ? 'install' : 'group', clientId: str(a, 'client-id'), clientSecret: a.secret },
        true,
      );
      if (saved.scope === 'install') forgetAllProbes();
      else forgetProbes(gid);
      return `Saved the ${saved.scope === 'install' ? 'install-wide' : gid} ${provider} app (${saved.clientId})`;
    }),
});

register({
  name: 'credentials-oauth-app-remove',
  description:
    'Remove an OAuth app; accounts issued to it are disconnected. Use --group <id> --provider <id> [--install].',
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = groupArg(a);
      const provider = str(a, 'provider');
      if (!provider) throw new Error('--provider <id> is required');
      const scope = await removeApp(gid, provider, a.install === true ? 'install' : 'group', true);
      if (scope === 'install') forgetAllProbes();
      else forgetProbes(gid);
      return `Removed the ${scope === 'install' ? 'install-wide' : gid} ${provider} app`;
    }),
});

function existingGroup(args: Args): string {
  const gid = str(args, 'group') ?? str(args, 'id');
  if (!gid) throw new Error('--group <agent-group-id> is required');
  if (!getAgentGroup(gid) || !getContainerConfig(gid)) throw new Error(`no agent group ${gid}`);
  return gid;
}

register({
  name: 'credentials-backend-get',
  description: "Show where a group's containers get credentials (onecli or agent-vault). Use --group <id>.",
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) => {
    const gid = existingGroup(args as Args);
    const stored = getContainerConfig(gid)?.credential_backend ?? 'onecli';
    const effective = usesAgentVault(gid) ? 'agent-vault' : 'onecli';
    return stored === effective
      ? effective
      : `${effective} (NANOCLAW_AGENT_VAULT_GROUPS overrides the stored ${stored})`;
  },
});

register({
  name: 'credentials-backend-set',
  description:
    "Move a group between OneCLI and the Agent Vault gateway. Use --group <id> --backend onecli|agent-vault. Creates the group's vault when needed; takes effect when its containers next start (`ncl groups restart --id <id>`). Keys aren't copied between backends.",
  access: 'open',
  resource: CREDENTIALS_RESOURCE,
  parseArgs: (raw) => raw,
  handler: async (args) =>
    run(async () => {
      const a = args as Args;
      const gid = existingGroup(a);
      const backend = str(a, 'backend');
      if (backend !== 'onecli' && backend !== 'agent-vault') throw new Error('--backend must be onecli or agent-vault');
      let vault = '';
      if (backend === 'agent-vault') vault = (await ensureVault(gid)) === 'created' ? ' (vault created)' : '';
      setCredentialBackend(gid, backend);
      const pinned =
        backend === 'onecli' && usesAgentVault(gid)
          ? '; still on agent-vault while NANOCLAW_AGENT_VAULT_GROUPS lists it'
          : '';
      const kept = backend === 'onecli' ? '; its vault is kept, so switching back restores its keys and sign-ins' : '';
      return `${gid} → ${backend}${vault}${kept}${pinned}. Restart its containers to apply: ncl groups restart --id ${gid}`;
    }),
});
