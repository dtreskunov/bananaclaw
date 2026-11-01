/**
 * Delivery-action handlers for agent-initiated self-modification requests.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. Each one validates input
 * and queues an approval request. The admin's approval triggers the
 * matching approval handler in ./apply.ts, which also performs the
 * required follow-up (rebuild+restart for install_packages, restart-only
 * for add_mcp_server).
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { McpAuthenticationError } from '../../ui/shared/mcp-authentication.js';
import { McpServerConfigError, parseMcpServerConfig } from '../../mcp-server-config.js';

export async function handleInstallPackages(
  content: Record<string, unknown>,
  session: Session,
  _inDb?: unknown,
  context?: { originMessageId: string | null },
): Promise<void> {
  const notify = (text: string) => notifyAgent(session, text, context?.originMessageId);
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages failed: agent group not found.');
    return;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const pip = (content.pip as string[]) || [];
  const reason = (content.reason as string) || '';

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const PIP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[<>=!~]=?[A-Za-z0-9._*+!-]+(?:,[<>=!~]=?[A-Za-z0-9._*+!-]+)*)?$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length + pip.length === 0) {
    notify('install_packages failed: at least one apt, npm, or pip package is required.');
    return;
  }
  if (apt.length + npm.length + pip.length > MAX_PACKAGES) {
    notify(`install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notify(`install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notify(`install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return;
  }
  const invalidPip = pip.find((p) => !PIP_RE.test(p));
  if (invalidPip) {
    notify(`install_packages failed: invalid pip package name "${invalidPip}".`);
    log.warn('install_packages: invalid pip package rejected', { pkg: invalidPip });
    return;
  }

  const packageList = [
    ...apt.map((p) => `apt: ${p}`),
    ...npm.map((p) => `npm: ${p}`),
    ...pip.map((p) => `pip: ${p}`),
  ].join(', ');
  await requestApproval({
    session,
    originMessageId: context?.originMessageId,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, pip, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}

export async function handleAddMcpServer(
  content: Record<string, unknown>,
  session: Session,
  _inDb?: unknown,
  context?: { originMessageId: string | null },
): Promise<void> {
  const notify = (text: string) => notifyAgent(session, text, context?.originMessageId);
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server failed: agent group not found.');
    return;
  }
  const serverName = content.name;
  if (typeof serverName !== 'string' || !serverName.trim()) {
    notify('add_mcp_server failed: name is required.');
    return;
  }
  if (!content.command && !content.url) {
    notify('add_mcp_server failed: either command (stdio) or url (remote) is required.');
    return;
  }
  if (content.command && content.url) {
    notify('add_mcp_server failed: provide either command (stdio) or url (remote), not both.');
    return;
  }

  const payload = {
    name: serverName,
    command: content.command,
    args: content.args,
    env: content.env,
    url: content.url,
    transport: content.url ? (content.transport ?? 'http') : undefined,
    headers: content.headers,
    authentication: content.authentication,
    instructions: content.instructions,
    timeout: content.timeout,
  };
  let server;
  try {
    server = parseMcpServerConfig(payload);
  } catch (error) {
    if (!(error instanceof McpServerConfigError) && !(error instanceof McpAuthenticationError)) throw error;
    notify(`add_mcp_server failed: ${error.message}`);
    return;
  }
  await requestApproval({
    session,
    originMessageId: context?.originMessageId,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload,
    title: 'Add tools',
    question:
      'url' in server
        ? `Agent "${agentGroup.name}" wants to add ${serverName} tools:\n${server.url}`
        : `Agent "${agentGroup.name}" wants to add ${serverName} tools:\n${server.command}`,
  });
}
