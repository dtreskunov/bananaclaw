import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, setCredentialBackend } from '../../db/container-configs.js';
import { log } from '../../log.js';
import {
  AgentVaultError,
  ensureVault,
  gatewayMessage,
  usesAgentVault,
} from '../../modules/credentials/agent-vault-client.js';
import {
  changeConnectionApp,
  ConnectionInputError,
  createConnection,
  deleteConnection,
  getConnection,
  grantConnection,
  groupConnectionAccess,
  listConnections,
  objectBody,
  revokeConnectionGrant,
  startConnectionSignIn,
  updateConnection,
} from '../../modules/credentials/shared-connections.js';
import { getUser } from '../../modules/permissions/db/users.js';
import { register } from '../registry.js';

export const CREDENTIALS_RESOURCE = 'credentials';
type Args = Record<string, unknown>;

function text(args: Args, field: string): string | undefined {
  const value = args[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(args: Args, field: string): string {
  const value = text(args, field);
  if (!value) throw new ConnectionInputError(`--${field} is required`);
  return value;
}

function owner(args: Args): string {
  const userId = required(args, 'user');
  if (!getUser(userId)) throw new ConnectionInputError('Unknown credential owner');
  return userId;
}

function parsed(value: unknown): unknown {
  try {
    if (typeof value !== 'string') throw new ConnectionInputError('Supply JSON input');
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConnectionInputError('Invalid JSON input');
  }
}

function values(args: Args): Record<string, unknown> | undefined {
  if (args.value !== undefined && args['values-stdin'] !== true)
    throw new ConnectionInputError('Credential values must use --values-stdin, never arguments');
  return args['values-stdin'] === true ? objectBody(parsed(args.value)) : undefined;
}

function mutation(args: Args): Record<string, unknown> {
  return {
    ...(text(args, 'label') ? { label: text(args, 'label') } : {}),
    ...(text(args, 'services') ? { services: parsed(args.services) } : {}),
    ...(values(args) ? { values: values(args) } : {}),
  };
}

async function operation<T>(action: string, userId: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    log.info('credential_operator_action', { actor: 'host-cli', effectiveUser: userId, action });
    return result;
  } catch (error) {
    if (error instanceof AgentVaultError)
      throw new Error(error.unreachable ? 'The credential gateway is unavailable' : gatewayMessage(error), {
        cause: error,
      });
    throw error;
  }
}

function command(name: string, description: string, run: (args: Args, userId: string) => Promise<unknown>): void {
  register({
    name: `credentials-${name}`,
    description,
    access: 'open',
    resource: CREDENTIALS_RESOURCE,
    parseArgs: (raw) => raw,
    handler: async (raw) => {
      const args = raw as Args,
        userId = owner(args);
      return operation(name, userId, () => run(args, userId));
    },
  });
}

command('list', 'List user-owned connections without values. Requires --user <user-id>.', async (_args, userId) =>
  listConnections(userId),
);
command('get', 'Get a user-owned connection. Requires --user <user-id> --id <connection-id>.', (args, userId) =>
  getConnection(userId, required(args, 'id')),
);
command(
  'create',
  'Create a user-owned connection. --user --label --kind static|mcp_oauth|oauth_app; static: --services <safe-json-array> --values-stdin; OAuth: --resource-url or --app.',
  (args, userId) =>
    createConnection(userId, {
      ...mutation(args),
      label: required(args, 'label'),
      kind: required(args, 'kind'),
      ...(text(args, 'resource-url') ? { resource_url: text(args, 'resource-url') } : {}),
      ...(text(args, 'app') ? { app_id: text(args, 'app') } : {}),
      ...(text(args, 'scopes') ? { scopes: parsed(args.scopes) } : {}),
    }),
);
command(
  'update',
  'Update a connection using its exact revision. --user --id --revision [--label] [--services <safe-json-array>] [--enabled true|false] [--values-stdin].',
  (args, userId) => {
    const enabled = text(args, 'enabled');
    if (enabled !== undefined && !['true', 'false'].includes(enabled))
      throw new ConnectionInputError('--enabled must be true or false');
    return updateConnection(userId, required(args, 'id'), {
      ...mutation(args),
      revision: required(args, 'revision'),
      ...(enabled === undefined ? {} : { enabled: enabled === 'true' }),
    });
  },
);
command(
  'delete',
  'Delete/disconnect a connection everywhere. Requires --user --id --revision; first review affected groups.',
  async (args, userId) => {
    await deleteConnection(userId, required(args, 'id'), required(args, 'revision'));
    return { deleted: true };
  },
);
command(
  'start',
  'Start user-bound OAuth consent. --user --id [--resource-url] [--app] [--scopes <JSON-array>]. Complete the URL while signed in as that NanoClaw user.',
  (args, userId) =>
    startConnectionSignIn(userId, required(args, 'id'), {
      ...(text(args, 'resource-url') ? { resource_url: text(args, 'resource-url') } : {}),
      ...(text(args, 'app') ? { app_id: text(args, 'app') } : {}),
      ...(text(args, 'scopes') ? { scopes: parsed(args.scopes) } : {}),
    }),
);
command(
  'grant',
  'Grant selected connection services to a group you administer. --user --id --group --services <JSON-name-array> [--revision for reapproval].',
  (args, userId) =>
    grantConnection(userId, required(args, 'id'), required(args, 'group'), {
      services: parsed(required(args, 'services')),
      ...(text(args, 'revision') ? { revision: text(args, 'revision') } : {}),
    }),
);
command('revoke', 'Remove only one group grant. Requires --user --id --group.', async (args, userId) => {
  await revokeConnectionGrant(userId, required(args, 'id'), required(args, 'group'));
  return { detached: true };
});
command('access', 'List a group’s granted connection services. Requires --user --group.', (args, userId) =>
  groupConnectionAccess(userId, required(args, 'group')),
);
command(
  'oauth-app-set',
  'Configure a user or install OAuth app. --user --app --config <safe-JSON> [--install] [--secret-stdin].',
  (args, userId) => {
    if (args.secret !== undefined && args['secret-stdin'] !== true)
      throw new ConnectionInputError('Use --secret-stdin, never secret arguments');
    return changeConnectionApp(userId, required(args, 'app'), 'PUT', args.install === true ? 'install' : 'user', {
      config: parsed(required(args, 'config')),
      ...(args['secret-stdin'] === true ? { clientSecret: args.secret } : {}),
    });
  },
);
command('oauth-app-remove', 'Remove a user/install OAuth app. --user --app [--install].', (args, userId) =>
  changeConnectionApp(userId, required(args, 'app'), 'DELETE', args.install === true ? 'install' : 'user'),
);

function existingGroup(args: Args): string {
  const group = required(args, 'group');
  if (!getAgentGroup(group) || !getContainerConfig(group)) throw new ConnectionInputError('Agent group not found');
  return group;
}

for (const verb of ['get', 'set'] as const) {
  register({
    name: `credentials-backend-${verb}`,
    description:
      verb === 'get'
        ? 'Show the active credential backend. Requires --group.'
        : 'Explicitly cut over a group after workload acceptance. --group --backend onecli|agent-vault; restart group containers separately.',
    access: 'open',
    resource: CREDENTIALS_RESOURCE,
    parseArgs: (raw) => raw,
    handler: async (raw) => {
      const args = raw as Args,
        group = existingGroup(args);
      if (verb === 'get') return usesAgentVault(group) ? 'agent-vault' : 'onecli';
      const backend = required(args, 'backend');
      if (backend !== 'onecli' && backend !== 'agent-vault') throw new ConnectionInputError('Unsupported backend');
      if (backend === 'agent-vault') await ensureVault(group);
      setCredentialBackend(group, backend);
      return { group, backend, restartRequired: true };
    },
  });
}
