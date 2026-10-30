import fs from 'node:fs';
import path from 'node:path';
import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { ContainerConfig, McpServerConfig } from '../../container-config.js';
import {
  McpAuthenticationError,
  parseMcpAuthentication,
  type McpAccessStatus,
} from '../../ui/shared/mcp-authentication.js';
import { serviceMatchesResource } from '../../ui/shared/credential-matching.js';
import { AgentVaultError, gatewayJson, usesAgentVault } from './agent-vault-client.js';

interface RuntimeService {
  connection_id?: string;
  connection_kind?: string;
  binding_handle?: string;
  name: string;
  host: string;
}
const hasReference = (server: McpServerConfig): boolean =>
  'url' in server && server.authentication !== undefined && server.authentication !== null;

export async function resolveMcpAuthentication(groupId: string, configured: Record<string, McpServerConfig>) {
  const statuses: McpAccessStatus[] = [];
  const servers: Record<string, McpServerConfig> = {};
  const hasReferences = Object.values(configured).some(hasReference);
  let services: RuntimeService[] = [];
  let unavailable: string | undefined;
  if (hasReferences) {
    if (!usesAgentVault(groupId)) unavailable = 'This connection requires AgentVault.';
    else {
      try {
        const discovery = await gatewayJson<{ services: RuntimeService[] }>(
          'GET',
          '/discover',
          'MCP connection discovery',
          { vault: groupId },
        );
        if (!Array.isArray(discovery.services))
          throw new AgentVaultError('Invalid scoped MCP connection discovery.', 502);
        services = discovery.services;
      } catch (error) {
        if (!(error instanceof AgentVaultError)) throw error;
        log.warn('MCP connection discovery unavailable', { groupId, status: error.status });
        unavailable = 'Credential gateway discovery is unavailable. Retry after it recovers.';
      }
    }
  }
  for (const [name, server] of Object.entries(configured)) {
    if (!('url' in server) || server.authentication === undefined || server.authentication === null) {
      servers[name] = server;
      continue;
    }
    let reference;
    try {
      reference = parseMcpAuthentication(server.authentication, server.url)!;
    } catch (error) {
      if (!(error instanceof McpAuthenticationError)) throw error;
      statuses.push({
        server: name,
        resource_url: server.url,
        account_alias: name,
        status: 'blocked',
        reason: error.message,
      });
      log.warn('Invalid MCP connection reference', { groupId, server: name });
      continue;
    }
    const matching = services.filter(
      (service) =>
        service.connection_id === reference.connection_id &&
        serviceMatchesResource({ host: service.host, https_only: true }, server.url),
    );
    const handles = new Set(matching.map((service) => service.binding_handle));
    const handle = handles.size === 1 ? matching[0]?.binding_handle : undefined;
    const blocked =
      unavailable ??
      (!handle || !/^BIND_[A-Z0-9]+$/.test(handle)
        ? 'Selected connection is unavailable, revoked, or does not authorize this endpoint. Use request_access for this named server.'
        : undefined);
    statuses.push({
      server: name,
      resource_url: server.url,
      account_alias: reference.account_alias,
      status: blocked ? 'blocked' : 'ready',
      ...(blocked ? { reason: blocked } : {}),
    });
    if (blocked) {
      log.warn('MCP connection blocked', { groupId, server: name, reason: blocked });
      continue;
    }
    const headers = Object.fromEntries(
      Object.entries(server.headers ?? {}).filter(
        ([key]) => !['authorization', 'x-agentvault-binding'].includes(key.toLowerCase()),
      ),
    );
    // The persistent reference remains in the DB; SDKs receive only the current group selector.
    const { authentication: _reference, ...transport } = server;
    servers[name] = {
      ...transport,
      headers: { ...headers, 'X-AgentVault-Binding': handle! },
      instructions: [
        server.instructions,
        `Account alias: ${JSON.stringify(reference.account_alias)}. Use only this named MCP server for this account; the host manages authentication.`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  return { servers, statuses };
}

export async function materializeMcpAuthentication(groupId: string, config: ContainerConfig): Promise<void> {
  if (!Object.values(config.mcpServers).some(hasReference)) return;
  const group = getAgentGroup(groupId);
  if (!group) throw new Error('MCP agent group no longer exists.');
  const resolved = await resolveMcpAuthentication(groupId, config.mcpServers);
  config.mcpServers = resolved.servers;
  config.mcpAccess = resolved.statuses;
  const filename = path.join(GROUPS_DIR, group.folder, 'container.json');
  fs.writeFileSync(filename + '.next', JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(filename + '.next', filename);
}
