import type { McpServerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { cascadeDeleteAgentGroup } from '../../db/cascade-delete-agent-group.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { archiveAgentGroup } from '../../modules/archive/archive-group.js';
import { restoreAgentGroup } from '../../modules/archive/restore-group.js';
import { createGroup, GroupCreateError } from '../../modules/groups/create.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import type { ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    upstream_provider: row.upstream_provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    packages_pip: JSON.parse(row.packages_pip),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    model_params: JSON.parse(row.model_params),
    updated_at: row.updated_at,
  };
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. ' +
        'Optional on create — if omitted, derived from --name and deduped with -2, -3, ... suffixes. Cannot be changed after creation.',
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `delete` is intentionally not in `operations` — the generic single-table
  // DELETE violates FK constraints (see #2525). `create` is also custom so
  // we can scaffold the on-disk group folder (`initGroupFilesystem`) in the
  // same step; the generic INSERT would leave the FS in an inconsistent
  // state until the first container spawn.
  operations: { list: 'open', get: 'open', update: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create a new agent group. Inserts the DB row, scaffolds groups/<folder>/ (CLAUDE.local.md, .claude-shared/, container_configs), ' +
        'and returns the new record. Use --name <display-name> [--folder <slug>] [--instructions <body>]. ' +
        'If --folder is omitted it is derived from --name and deduped with -2, -3, ... suffixes.',
      handler: async (args) => {
        const name = args.name as string | undefined;
        const folder = args.folder as string | undefined;
        const instructions = args.instructions as string | undefined;
        if (!name) throw new Error('--name is required');
        try {
          const group = createGroup({ name, folder, instructions });
          return group;
        } catch (err) {
          if (err instanceof GroupCreateError) throw new Error(err.message);
          throw err;
        }
      },
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const removed = cascadeDeleteAgentGroup(id);
        return { deleted: id, removed };
      },
    },
    archive: {
      access: 'approval',
      description:
        'Archive an agent group: snapshot every dependent row into groups/<folder>/archive.json, ' +
        'write ARCHIVE_RESTORE.md, kill any running containers, run the FK cascade, then rename ' +
        'groups/<folder> -> groups/<folder>~ and data/v2-sessions/<id> -> data/v2-sessions/<id>~. ' +
        'Restorable via `ncl groups restore --folder <name>`. Use --id <group-id>. ' +
        'From inside a container, --id is auto-filled to the calling group.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        const actor = ctx.caller === 'agent' ? { user_id: `agent:${ctx.agentGroupId}` } : { user_id: 'host:ncl' };
        const result = archiveAgentGroup(id, actor);
        return result;
      },
    },
    restore: {
      access: 'approval',
      description:
        'Restore a previously-archived group from groups/<folder>~/archive.json. CLI/host-only. ' +
        'Use --folder <name> (accepts either the original "my-group" or the suffixed "my-group~"). ' +
        'Optional --with-sessions also replays sessions and pending_* rows; default omits them so ' +
        'restored agents come back with a clean session history.',
      handler: async (args, ctx) => {
        if (ctx.caller === 'agent') {
          throw new Error('restore is host-only — run from the host shell, not from inside a container');
        }
        const folder = args.folder as string;
        if (!folder) throw new Error('--folder is required');
        const withSessions = Boolean(args['with-sessions'] ?? args.with_sessions ?? args.withSessions);
        return restoreAgentGroup(folder, { withSessions });
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message) {
            writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? () => {
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and any of: --provider, --upstream-provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            | 'provider'
            | 'upstream_provider'
            | 'model'
            | 'effort'
            | 'image_tag'
            | 'assistant_name'
            | 'max_messages_per_prompt'
            | 'cli_scope'
          >
        > = {};
        if (args.provider !== undefined) {
          // Keep in sync with REQUIRED_PROVIDER_MODULES + OPTIONAL_PROVIDER_MODULES
          // in container/agent-runner/src/providers/index.ts. Bad provider names
          // cause silent container-exit-code-1 loops (see follow-up to denis@bot incident).
          const validProviders = ['claude', 'mock', 'opencode'];
          const p = args.provider as string;
          if (!validProviders.includes(p)) {
            throw new Error(
              `--provider must be one of: ${validProviders.join(', ')} (got: ${p}). For OpenRouter/etc., use provider=opencode with model=<route>/<model>.`,
            );
          }
          updates.provider = p;
        }
        if (args.model !== undefined) updates.model = args.model as string;
        if (args['upstream-provider'] !== undefined || args.upstream_provider !== undefined) {
          // Upstream gateway for provider=opencode (e.g. `openrouter`,
          // `minimax`, `deepseek`). Must match a provider id in OpenCode's
          // models.dev catalog; empty string clears back to OPENCODE_PROVIDER.
          // Not validated against a fixed list — the catalog is remote and
          // grows independently of this codebase.
          const upstream = ((args['upstream-provider'] ?? args.upstream_provider) as string).trim();
          updates.upstream_provider = upstream === '' ? null : upstream;
        }
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --upstream-provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope',
          );
        }

        updateContainerConfigScalars(id, updates);

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        servers[name] = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { added: name, servers };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { removed: name };
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg>, --npm <pkg>, or --pip <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        const pip = args.pip as string | undefined;
        if (!apt && !npm && !pip) throw new Error('Provide --apt <pkg>, --npm <pkg>, or --pip <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }
        if (pip) {
          const existing = JSON.parse(row.packages_pip) as string[];
          if (!existing.includes(pip)) {
            existing.push(pip);
            updateContainerConfigJson(id, 'packages_pip', existing);
          }
        }

        return {
          added: { apt: apt || null, npm: npm || null, pip: pip || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg>, --npm <pkg>, or --pip <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        const pip = args.pip as string | undefined;
        if (!apt && !npm && !pip) throw new Error('Provide --apt <pkg>, --npm <pkg>, or --pip <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          updateContainerConfigJson(id, 'packages_npm', filtered);
        }
        if (pip) {
          const existing = JSON.parse(row.packages_pip) as string[];
          const filtered = existing.filter((p) => p !== pip);
          updateContainerConfigJson(id, 'packages_pip', filtered);
        }

        return {
          removed: { apt: apt || null, npm: npm || null, pip: pip || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
    'config set-param': {
      access: 'approval',
      description:
        'Set a model parameter (provider knob) for a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --key <name> --value <value>. ' +
        'Value is parsed as JSON first (so `8192`, `true`, `0.7`, `["a","b"]` come through typed); ' +
        'if JSON parsing fails it is stored as a string. ' +
        'Common keys: max_tokens, temperature, top_p, thinking_budget_tokens (Claude), reasoning_effort. ' +
        'Unknown keys are accepted — the active provider warns and ignores them at startup.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const key = args.key as string;
        if (!key) throw new Error('--key is required');
        if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key)) {
          throw new Error(`--key must be a dotted identifier (letters, digits, _, .), got: ${key}`);
        }
        if (args.value === undefined) throw new Error('--value is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const raw = String(args.value);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }

        const params = JSON.parse(row.model_params) as Record<string, unknown>;
        params[key] = value;
        updateContainerConfigJson(id, 'model_params', params);

        return { set: { [key]: value }, model_params: params };
      },
    },
    'config unset-param': {
      access: 'approval',
      description:
        'Remove a model parameter from a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --key <name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const key = args.key as string;
        if (!key) throw new Error('--key is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const params = JSON.parse(row.model_params) as Record<string, unknown>;
        if (!(key in params)) {
          return { removed: null, note: `Key "${key}" was not set`, model_params: params };
        }
        delete params[key];
        updateContainerConfigJson(id, 'model_params', params);

        return { removed: key, model_params: params };
      },
    },
  },
});
