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
import { McpAuthenticationError, parseMcpAuthentication } from '../../ui/shared/mcp-authentication.js';

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
  const serverName = content.name as string;
  const command = content.command as string | undefined;
  const url = content.url as string | undefined;
  if (!serverName) {
    notify('add_mcp_server failed: name is required.');
    return;
  }
  if (!command && !url) {
    notify('add_mcp_server failed: either command (stdio) or url (remote) is required.');
    return;
  }
  if (command && url) {
    notify('add_mcp_server failed: provide either command (stdio) or url (remote), not both.');
    return;
  }

  if (url) {
    // Basic URL sanity — must be http(s)
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        notify(`add_mcp_server failed: url must be http(s), got "${parsed.protocol}".`);
        return;
      }
    } catch {
      notify(`add_mcp_server failed: invalid url "${url}".`);
      return;
    }
    const transport = (content.transport as string) === 'sse' ? 'sse' : 'http';
    let authentication;
    try {
      authentication = parseMcpAuthentication(content.authentication, url);
    } catch (error) {
      if (!(error instanceof McpAuthenticationError)) throw error;
      notify(`add_mcp_server failed: ${error.message}`);
      return;
    }
    await requestApproval({
      session,
      originMessageId: context?.originMessageId,
      agentName: agentGroup.name,
      action: 'add_mcp_server',
      payload: {
        name: serverName,
        url,
        transport,
        headers: (content.headers as Record<string, string>) || {},
        authentication,
      },
      title: 'Add MCP Request',
      question: `Agent "${agentGroup.name}" is attempting to add a remote MCP server:\n${serverName} (${transport.toUpperCase()} ${url})`,
    });
    return;
  }

  if (content.authentication !== undefined) {
    notify('add_mcp_server failed: connection references require HTTP/SSE transport.');
    return;
  }
  await requestApproval({
    session,
    originMessageId: context?.originMessageId,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: {
      name: serverName,
      command,
      args: (content.args as string[]) || [],
      env: (content.env as Record<string, string>) || {},
    },
    title: 'Add MCP Request',
    question: `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n${serverName} (${command})`,
  });
}
