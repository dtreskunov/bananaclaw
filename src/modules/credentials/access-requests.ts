import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { beginApprovalExecution, endApprovalExecution, getPendingApproval, getSession } from '../../db/sessions.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import type { McpServerConfig } from '../../container-config.js';
import { registerDeliveryAction, onDeliveryAdapterReady } from '../../delivery.js';
import { onShutdown } from '../../response-registry.js';
import { log } from '../../log.js';
import { uiBaseUrl } from '../../ui/server/server.js';
import { openInboundDb } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { isOAuthScope } from '../../ui/shared/oauth-app.js';
import {
  AccessAuthenticationError,
  connectionMatchesAccess,
  parseAccessAuthentication,
  type AccessRequirements,
} from '../../ui/shared/access-authentication.js';
import { McpAuthenticationError, parseMcpAuthentication } from '../../ui/shared/mcp-authentication.js';
import { resolveMcpAuthentication } from './mcp-authentication.js';
import { requestApproval, registerInteractiveApprovalHandler, notifyAgent } from '../approvals/primitive.js';
import {
  claimApprovalWorkflow,
  finishApprovalWorkflow,
  getApprovalWorkflow,
  notifyApprovalWorkflow,
  pendingWorkflow,
  latestApprovalWorkflow,
  linkApprovalSubmission,
  type ApprovalWorkflow,
} from '../approvals/workflows.js';
import {
  ConnectionInputError,
  getConnection,
  grantConnection,
  groupConnectionAccess,
  objectBody,
  requireGroupAdmin,
  type SharedConnection,
} from './shared-connections.js';
import { AgentVaultError, usesAgentVault } from './agent-vault-client.js';

export const ACCESS_ACTION = 'request_access';
const TTL_MS = 24 * 60 * 60_000;
const activeApplications = new Set<string>();
const reviewUrl = (id: string): string => `${uiBaseUrl()}/chat/?access_request=${encodeURIComponent(id)}#credentials`;

export interface AccessRequestInput extends AccessRequirements {
  reason: string;
}

export function accessRequestInput(raw: unknown): AccessRequestInput {
  const body = objectBody(raw);
  if (
    Object.keys(body).some((key) => !['resource_url', 'reason', 'scopes', 'mcp_server', 'authentication'].includes(key))
  )
    throw new ConnectionInputError(
      'Access requests accept only resource_url, reason, optional scopes and an optional mcp_server name. Never supply secrets.',
    );
  const url = typeof body.resource_url === 'string' ? URL.parse(body.resource_url) : null;
  let authentication;
  try {
    authentication = parseAccessAuthentication(body.authentication);
  } catch (error) {
    if (!(error instanceof AccessAuthenticationError)) throw error;
    throw new ConnectionInputError(error.message);
  }
  if (
    body.mcp_server !== undefined &&
    (typeof body.mcp_server !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(body.mcp_server))
  )
    throw new ConnectionInputError('Select an existing named MCP server.');
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 2048 ||
    [...String(body.resource_url)].some((char) => char.charCodeAt(0) <= 32 || char === '*')
  )
    throw new ConnectionInputError(
      'Provide an exact HTTPS destination without credentials, query, fragment or wildcard.',
    );
  if (
    typeof body.reason !== 'string' ||
    !body.reason.trim() ||
    body.reason.length > 1000 ||
    [...body.reason].some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char))
  )
    throw new ConnectionInputError('Explain the access needed in at most 1000 characters; do not include credentials.');
  if (
    body.scopes !== undefined &&
    (!Array.isArray(body.scopes) ||
      body.scopes.length > 64 ||
      !body.scopes.every((scope) => isOAuthScope(scope) && scope.length <= 2048))
  )
    throw new ConnectionInputError('Provide valid scope suggestions, never tokens.');
  if (
    Array.isArray(body.scopes) &&
    body.scopes.length &&
    authentication &&
    !['mcp_oauth', 'oauth_app', 'bearer'].includes(authentication.type)
  )
    throw new ConnectionInputError('OAuth scope suggestions require an OAuth or bearer authentication request.');
  return {
    resource_url: url.href,
    reason: body.reason.trim(),
    ...(authentication ? { authentication } : {}),
    ...(body.mcp_server === undefined ? {} : { mcp_server: body.mcp_server as string }),
    ...(body.scopes === undefined ? {} : { scopes: [...new Set(body.scopes as string[])].sort() }),
  };
}

function requestRecord(id: string): {
  approval: PendingApproval;
  workflow: ApprovalWorkflow;
  input: AccessRequestInput;
  session: Session;
} {
  const workflow = getApprovalWorkflow(id);
  const approval = workflow ? getPendingApproval(workflow.approval_id) : undefined;
  const session = approval?.session_id ? getSession(approval.session_id) : undefined;
  if (!approval || approval.action !== ACCESS_ACTION || !workflow || !session)
    throw new ConnectionInputError('Access request not found', 404);
  if (workflow.stage === 'pending' && approval.expires_at && approval.expires_at <= new Date().toISOString()) {
    finishApprovalWorkflow(
      workflow.approval_id,
      'expired',
      'Your access request expired without changing credentials. Request access again if still needed.',
    );
    return requestRecord(id);
  }
  return { approval, workflow, input: accessRequestInput(JSON.parse(approval.payload)), session };
}

export function accessRequestStatus(id: string, sessionId?: string) {
  const record = requestRecord(id);
  if (sessionId && record.session.id !== sessionId) throw new ConnectionInputError('Access request not found', 404);
  return {
    request_id: record.workflow.approval_id,
    status: record.workflow.stage,
    resource_url: record.input.resource_url,
    reason: record.input.reason,
    authentication: record.input.authentication,
    mcp_server: record.input.mcp_server,
    scopes: record.input.scopes,
    revision: record.workflow.revision,
    agent_group_id: record.session.agent_group_id,
    expires_at: record.approval.expires_at,
    agent_group_name: getAgentGroup(record.session.agent_group_id)?.name ?? record.session.agent_group_id,
    result: record.workflow.result_json ? (JSON.parse(record.workflow.result_json) as { message: string }) : null,
  };
}

export async function requestAccess(session: Session, raw: unknown, requestId?: string) {
  if (!usesAgentVault(session.agent_group_id))
    throw new ConnectionInputError('This agent must use AgentVault to request shared access.');
  if (getContainerConfig(session.agent_group_id)?.cli_scope === 'disabled')
    throw new ConnectionInputError('Access requests are disabled for this agent.', 403);
  const input = accessRequestInput(raw);
  if (input.mcp_server) mcpConfiguration(session.agent_group_id, input.resource_url, input.mcp_server);
  const inbound = openInboundDb(session.agent_group_id, session.id);
  let origin: { id: string; sender_user_id: string } | undefined;
  try {
    origin = inbound
      .prepare(
        "SELECT id,sender_user_id FROM messages_in WHERE kind='chat' AND sender_user_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get() as typeof origin;
  } finally {
    inbound.close();
  }
  if (requestId && !/^appr-access-[a-zA-Z0-9-]{1,100}$/.test(requestId))
    throw new ConnectionInputError('Invalid access request identifier');
  if (requestId && getApprovalWorkflow(requestId)) return accessRequestStatus(requestId, session.id);
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        session.id,
        origin?.id ?? null,
        input.resource_url,
        input.scopes ?? [],
        ...(input.mcp_server ? [input.mcp_server] : []),
        ...(input.authentication ? [input.authentication] : []),
      ]),
    )
    .digest('hex');
  const existing = pendingWorkflow(key);
  if (existing) {
    const status = accessRequestStatus(existing.approval_id, session.id);
    if (status.status === 'pending' || status.status === 'applying') {
      if (requestId) linkApprovalSubmission(status.request_id, requestId);
      return status;
    }
  }
  const prior = latestApprovalWorkflow(key);
  if (prior) {
    if (requestId) linkApprovalSubmission(prior.approval_id, requestId);
    return accessRequestStatus(prior.approval_id, session.id);
  }
  const id = requestId ?? `appr-access-${randomUUID()}`;
  if (!/^appr-access-[a-zA-Z0-9-]{1,100}$/.test(id))
    throw new ConnectionInputError('Invalid access request identifier');
  const previous = getPendingApproval(id);
  if (previous) return accessRequestStatus(id, session.id);
  const group = getAgentGroup(session.agent_group_id);
  const created = await requestApproval({
    session,
    agentName: group?.name ?? session.agent_group_id,
    action: ACCESS_ACTION,
    approvalId: id,
    workflowKey: key,
    workflowOrigin: { messageId: origin?.id ?? null, userId: origin?.sender_user_id ?? null },
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    payload: { ...input },
    title: `${group?.name ?? 'Agent'} requests access`,
    question: `${input.reason}\nDestination: ${input.resource_url}\nReview privately in BananaClaw: ${reviewUrl(id)}\nReviewing is not approval; no credentials have changed.`,
    options: [
      { label: 'Review access…', value: 'review', selectedLabel: 'Review access' },
      { label: 'Reject', value: 'reject', selectedLabel: 'Rejected' },
    ],
  });
  if (!created) throw new ConnectionInputError('No eligible owner or administrator can review this request.', 409);
  return accessRequestStatus(id, session.id);
}

export function reviewAccessRequest(userId: string, id: string) {
  const record = requestRecord(id);
  requireGroupAdmin(userId, record.session.agent_group_id);
  return accessRequestStatus(id);
}

export async function previewAccessRequest(userId: string, id: string, connectionId: string) {
  const request = reviewAccessRequest(userId, id);
  const connection = await getConnection(userId, connectionId);
  return {
    request,
    connection,
    matches: connectionMatchesAccess(connection, request),
    grantBreadth: 'All current and future URL patterns on this connection, not just the requested URL.',
    verification: 'Grant verification only. The agent must verify the authenticated operation after access is granted.',
    mcp: mcpConfiguration(request.agent_group_id, request.resource_url, request.mcp_server),
  };
}

function mcpConfiguration(groupId: string, resource: string, target?: string) {
  const row = getContainerConfig(groupId);
  if (!row) throw new ConnectionInputError('Agent configuration no longer exists.', 409);
  const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  const names = Object.entries(servers)
    .filter(([name, server]) => {
      if (target && name !== target) return false;
      if (!('url' in server)) return false;
      const url = URL.parse(server.url);
      return url?.href === resource;
    })
    .map(([name]) => name);
  if (target && !names.includes(target))
    throw new ConnectionInputError('The named MCP server no longer matches the requested endpoint.', 409);
  return {
    names,
    configured: Object.fromEntries(
      names.map((name) => [name, 'authentication' in servers[name] ? servers[name].authentication : undefined]),
    ),
    revision: createHash('sha256').update(row.mcp_servers).digest('hex'),
  };
}

async function runtimeInstructions(userId: string, groupId: string, connection: SharedConnection) {
  if (connection.kind === 'static') {
    return {
      accessPlaceholder: undefined,
      instructions: connection.services.map((service) => ({
        destination: service.host,
        path: service.path,
        authentication: service.auth.type,
        placeholders: service.substitutions?.map((sub) => ({ placeholder: sub.placeholder, in: sub.in })),
      })),
    };
  }
  const access = (await groupConnectionAccess(userId, groupId)).find(
    (grant) => grant.connection_id === connection.id && grant.status === 'active',
  );
  const handle = access?.services[0]?.auth.token;
  if (!handle || !/^BIND_[A-Z0-9]+$/.test(handle))
    throw new ConnectionInputError('The gateway did not provide a valid group-bound OAuth placeholder.', 502);
  return {
    accessPlaceholder: `av-access:${handle}`,
    instructions: [
      {
        authorization: `Bearer av-access:${handle}`,
        note: 'This is a nonsecret group-bound selector, not a provider token. Use it only at this connection’s approved destinations.',
      },
    ],
  };
}

interface ApplySelection {
  userId: string;
  connectionId: string;
  connectionRevision: string;
  configureMcp?: boolean;
  configRevision?: string;
  appliedConfigRevision?: string;
  mcpServer?: string;
  accountAlias?: string;
}

async function selectionGranted(id: string, selection: ApplySelection): Promise<boolean> {
  const request = reviewAccessRequest(selection.userId, id);
  const connection = await getConnection(selection.userId, selection.connectionId);
  return (
    connection.revision === selection.connectionRevision &&
    connection.status === 'ready' &&
    connectionMatchesAccess(connection, request) &&
    connection.grants.some((grant) => grant.vault === request.agent_group_id && grant.status === 'active')
  );
}

export async function applyAccessRequest(userId: string, id: string, raw: unknown) {
  const body = objectBody(raw);
  if (
    Object.keys(body).some(
      (key) =>
        ![
          'connection_id',
          'connection_revision',
          'request_revision',
          'configure_mcp',
          'config_revision',
          'mcp_server',
          'account_alias',
        ].includes(key),
    ) ||
    typeof body.connection_id !== 'string' ||
    typeof body.connection_revision !== 'string' ||
    !Number.isSafeInteger(body.request_revision) ||
    (body.configure_mcp !== undefined && typeof body.configure_mcp !== 'boolean') ||
    (body.configure_mcp && typeof body.config_revision !== 'string')
  )
    throw new ConnectionInputError('Select a connection and confirm the exact reviewed revisions.');
  const preview = await previewAccessRequest(userId, id, body.connection_id);
  id = preview.request.request_id;
  const current = reviewAccessRequest(userId, id);
  if (current.status !== 'pending') throw new ConnectionInputError('This approval is no longer pending.', 409);
  if (preview.request.status !== 'pending') throw new ConnectionInputError('This approval is no longer pending.', 409);
  if (!preview.matches || preview.connection.status !== 'ready')
    throw new ConnectionInputError('Connect a compatible credential before approving access.', 409);
  if (preview.connection.revision !== body.connection_revision)
    throw new ConnectionInputError('The credential changed. Review access again.', 412);
  if (
    body.configure_mcp &&
    (typeof body.mcp_server !== 'string' ||
      !preview.mcp.names.includes(body.mcp_server) ||
      typeof body.account_alias !== 'string' ||
      body.config_revision !== preview.mcp.revision)
  )
    throw new ConnectionInputError('Review one named MCP configuration before requesting a restart.', 412);
  const selection: ApplySelection = {
    userId,
    connectionId: body.connection_id,
    connectionRevision: body.connection_revision,
    configureMcp: body.configure_mcp === true,
    configRevision: preview.mcp.revision,
    ...(body.configure_mcp ? { mcpServer: String(body.mcp_server), accountAlias: String(body.account_alias) } : {}),
  };
  let authentication;
  try {
    authentication = body.configure_mcp
      ? parseMcpAuthentication({ connection_id: body.connection_id, account_alias: body.account_alias })
      : undefined;
  } catch (error) {
    if (!(error instanceof McpAuthenticationError)) throw error;
    throw new ConnectionInputError(error.message);
  }
  if (!beginApprovalExecution(getPendingApproval(id)!))
    throw new ConnectionInputError('This approval is already being applied.', 409);
  if (!claimApprovalWorkflow(id, Number(body.request_revision), { ...selection })) {
    endApprovalExecution(id);
    throw new ConnectionInputError('The approval changed or is already being applied. Refresh before continuing.', 409);
  }
  activeApplications.add(id);
  try {
    const existing = preview.connection.grants.find((grant) => grant.vault === preview.request.agent_group_id);
    if (existing?.status !== 'active') {
      await grantConnection(userId, body.connection_id, preview.request.agent_group_id, {
        revision: body.connection_revision,
      });
    }
    if (!(await selectionGranted(id, selection)))
      throw new ConnectionInputError('Access could not be verified after applying the grant.', 409);
    let runtime: Awaited<ReturnType<typeof runtimeInstructions>> | undefined;
    if (selection.configureMcp) {
      const current = mcpConfiguration(
        preview.request.agent_group_id,
        preview.request.resource_url,
        selection.mcpServer,
      );
      if (current.revision !== selection.configRevision)
        throw new ConnectionInputError(
          'MCP configuration changed while applying access; review the resulting grant and configuration.',
          412,
        );
      requireGroupAdmin(userId, preview.request.agent_group_id);
      const config = getContainerConfig(preview.request.agent_group_id)!;
      const servers = JSON.parse(config.mcp_servers) as Record<string, McpServerConfig>;
      const serverName = selection.mcpServer!;
      const server = servers[serverName];
      if (!('url' in server)) throw new ConnectionInputError('Named MCP transport changed.', 409);
      servers[serverName] = {
        ...server,
        authentication,
        headers: Object.fromEntries(
          Object.entries(server.headers ?? {}).filter(
            ([key]) => !['authorization', 'x-agentvault-binding'].includes(key.toLowerCase()),
          ),
        ),
      };
      getDb().transaction(() => {
        updateContainerConfigJson(preview.request.agent_group_id, 'mcp_servers', servers);
        selection.appliedConfigRevision = mcpConfiguration(
          preview.request.agent_group_id,
          preview.request.resource_url,
          serverName,
        ).revision;
        getDb()
          .prepare('UPDATE approval_workflows SET data_json=? WHERE approval_id=?')
          .run(JSON.stringify(selection), id);
      })();
      const resolved = await resolveMcpAuthentication(preview.request.agent_group_id, {
        [serverName]: servers[serverName],
      });
      if (resolved.statuses[0]?.status !== 'ready')
        throw new ConnectionInputError(
          'The selected MCP connection could not be resolved. Review Credentials and the named server.',
          409,
        );
    } else {
      runtime = await runtimeInstructions(userId, preview.request.agent_group_id, preview.connection);
    }
    finishApprovalWorkflow(
      id,
      'completed',
      `Access granted for ${preview.request.resource_url}. The group grant was verified; upstream authentication has not yet been verified. ${
        selection.configureMcp
          ? `Only MCP server ${JSON.stringify(selection.mcpServer)} now uses account alias ${JSON.stringify(selection.accountAlias)}. The host resolves its current binding; do not construct authentication headers.`
          : `Runtime routing: ${JSON.stringify(runtime!.instructions)}.`
      } Safely verify the original operation, then continue the original request with its original dates, timezone and account choice. Do not automatically replay writes or create a recurring poller.`,
      selection.configureMcp,
    );
  } catch (error) {
    finishApprovalWorkflow(
      id,
      'failed',
      'Applying your access approval failed or could not be verified. Some changes may have applied; review Credentials before trying again.',
    );
    log.error('Access approval application failed', { approvalId: id, userId, error });
    await notifyApprovalWorkflow(id);
    throw error;
  } finally {
    activeApplications.delete(id);
    endApprovalExecution(id);
  }
  await notifyApprovalWorkflow(id);
  return accessRequestStatus(id);
}

export async function cancelAccessRequest(id: string, sessionId: string) {
  const request = accessRequestStatus(id, sessionId);
  if (request.status !== 'pending')
    throw new ConnectionInputError('Only a pending access request can be cancelled.', 409);
  finishApprovalWorkflow(
    request.request_id,
    'cancelled',
    'Your access request was cancelled without changing credentials.',
  );
  await notifyApprovalWorkflow(request.request_id);
  return accessRequestStatus(request.request_id, sessionId);
}

registerInteractiveApprovalHandler(ACCESS_ACTION, async (approval, response, userId) => {
  const request = reviewAccessRequest(userId, approval.approval_id);
  if (request.status !== 'pending') return;
  if (response.value === 'reject') {
    finishApprovalWorkflow(
      approval.approval_id,
      'rejected',
      'Your access request was rejected. No credentials were changed. Do not repeat this request unless the user asks.',
    );
    await notifyApprovalWorkflow(approval.approval_id);
  } else if (response.value === 'review') {
    const session = getSession(approval.session_id!);
    if (session)
      notifyAgent(
        session,
        `Access review is still pending. The user must privately select and confirm a credential in BananaClaw: ${reviewUrl(approval.approval_id)}. Do not poll, search for secrets or treat review as approval.`,
      );
  } else {
    throw new ConnectionInputError(
      'Open Review access and confirm a connection; a generic Approve cannot grant credentials.',
      409,
    );
  }
});

registerDeliveryAction(ACCESS_ACTION, async (content, session) => {
  try {
    const { requestId, ...body } = content;
    delete body.action;
    delete body.timelinePosition;
    await requestAccess(session, body, typeof requestId === 'string' ? requestId : undefined);
  } catch (error) {
    if (!(error instanceof ConnectionInputError)) throw error;
    log.warn('Access request rejected', { sessionId: session.id, error: error.message });
    notifyAgent(session, `Access request failed: ${error.message}`);
  }
});

export async function recoverAccessRequests(recoverApplying = false): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT w.* FROM approval_workflows w JOIN pending_approvals a ON a.approval_id=w.approval_id
    WHERE a.action=? AND (w.stage IN ('pending','applying') OR w.notified=0)`,
    )
    .all(ACCESS_ACTION) as ApprovalWorkflow[];
  for (const row of rows) {
    try {
      if (row.stage === 'applying' && recoverApplying && !activeApplications.has(row.approval_id)) {
        const selection = JSON.parse(row.data_json) as ApplySelection;
        const request = reviewAccessRequest(selection.userId, row.approval_id);
        const configReady =
          !selection.configureMcp ||
          Boolean(
            selection.mcpServer &&
            selection.accountAlias &&
            selection.appliedConfigRevision ===
              mcpConfiguration(request.agent_group_id, request.resource_url, selection.mcpServer).revision,
          );
        if (configReady && (await selectionGranted(row.approval_id, selection))) {
          const connection = await getConnection(selection.userId, selection.connectionId);
          const runtime = selection.configureMcp
            ? undefined
            : await runtimeInstructions(selection.userId, request.agent_group_id, connection);
          if (selection.configureMcp) {
            const config = getContainerConfig(request.agent_group_id)!;
            const servers = JSON.parse(config.mcp_servers) as Record<string, McpServerConfig>;
            const resolved = await resolveMcpAuthentication(request.agent_group_id, {
              [selection.mcpServer!]: servers[selection.mcpServer!],
            });
            if (resolved.statuses[0]?.status !== 'ready')
              throw new ConnectionInputError('MCP reference no longer resolves.', 409);
          }
          finishApprovalWorkflow(
            row.approval_id,
            'completed',
            `Your approved access grant was recovered and verified after restart. ${
              selection.configureMcp
                ? `Use MCP server ${JSON.stringify(selection.mcpServer)} with account alias ${JSON.stringify(selection.accountAlias)}; the host manages authentication.`
                : `Runtime routing: ${JSON.stringify(runtime!.instructions)}.`
            } Safely verify upstream access before continuing the original request. Preserve its original dates and timezone; do not replay writes automatically.`,
            selection.configureMcp,
          );
        } else {
          finishApprovalWorkflow(
            row.approval_id,
            'failed',
            'Access approval was interrupted by restart. Review Credentials; no additional grant was replayed automatically.',
          );
        }
      } else {
        requestRecord(row.approval_id);
      }
      await notifyApprovalWorkflow(row.approval_id);
    } catch (error) {
      if (
        row.stage === 'applying' &&
        recoverApplying &&
        (error instanceof ConnectionInputError ||
          (error instanceof AgentVaultError && !error.unreachable && error.status !== undefined && error.status < 500))
      ) {
        finishApprovalWorkflow(
          row.approval_id,
          'failed',
          'Access approval cannot resume because its authority or credential changed. Review Credentials; no additional grant was replayed.',
        );
        await notifyApprovalWorkflow(row.approval_id);
      }
      // Isolate independent approval recovery; retain undelivered results for retry.
      log.error('Access approval recovery pending', { approvalId: row.approval_id, error });
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onDeliveryAdapterReady(async () => {
  await recoverAccessRequests(true);
  if (!timer) {
    timer = setInterval(() => {
      void recoverAccessRequests(true).catch((error) => log.error('Access approval recovery failed', { error }));
    }, 30_000);
    timer.unref();
  }
});
onShutdown(() => {
  if (timer) clearInterval(timer);
  timer = undefined;
});
