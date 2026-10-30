/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config in the DB, rebuilds the image as needed, and queues
 * verification for a replacement container after the active response settles.
 *
 * install_packages: update DB + rebuild image + deferred restart + on_wake.
 * add_mcp_server: update DB + deferred restart + on_wake.
 */
import { buildAgentGroupImage } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import type { McpServerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { parseMcpAuthentication } from '../../ui/shared/mcp-authentication.js';
import type { ApprovalHandler } from '../approvals/index.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notify('install_packages approved but container config missing.');
    return;
  }

  // Append new packages to existing lists in the DB (deduplicated)
  if (payload.apt) {
    const existing = JSON.parse(configRow.packages_apt) as string[];
    for (const pkg of payload.apt as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_apt', existing);
  }
  if (payload.npm) {
    const existing = JSON.parse(configRow.packages_npm) as string[];
    for (const pkg of payload.npm as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_npm', existing);
  }
  if (payload.pip) {
    const existing = JSON.parse(configRow.packages_pip) as string[];
    for (const pkg of payload.pip as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_pip', existing);
  }

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
    ...((payload.pip as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    notify(
      `Packages approved (${pkgs}) and image rebuilt. Finish the current response; the container will restart afterward.`,
    );
    notify(
      `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
      { afterRestart: true },
    );
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    notify('add_mcp_server approved but container config missing.');
    return;
  }

  // Add the new MCP server to the existing map in the DB
  const servers = JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>;
  if (payload.url) {
    const transport = payload.transport === 'sse' ? 'sse' : 'http';
    const previous = servers[payload.name as string];
    const reference =
      payload.authentication === undefined && previous && 'url' in previous
        ? previous.authentication
        : payload.authentication;
    servers[payload.name as string] = {
      type: transport,
      url: payload.url as string,
      authentication: parseMcpAuthentication(reference, payload.url as string),
      ...(payload.headers && Object.keys(payload.headers as Record<string, string>).length > 0
        ? { headers: payload.headers as Record<string, string> }
        : {}),
    };
  } else {
    servers[payload.name as string] = {
      command: payload.command as string,
      args: (payload.args as string[]) || [],
      env: (payload.env as Record<string, string>) || {},
    };
  }
  updateContainerConfigJson(agentGroup.id, 'mcp_servers', servers);

  notify(
    `MCP server "${payload.name}" approved. Finish the current response; the new server will be available after the automatic restart.`,
  );
  notify(
    `MCP server "${payload.name}" added. Verify it's available (e.g. list your tools) and report the result to the user.`,
    { afterRestart: true },
  );
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id, userId });
};
