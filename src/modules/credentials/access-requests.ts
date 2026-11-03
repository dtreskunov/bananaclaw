import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { beginApprovalExecution, endApprovalExecution, getSession } from '../../db/sessions.js';
import { getApproval, updateApprovalStatus } from '../../db/approvals.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import type { McpServerConfig } from '../../container-config.js';
import { registerDeliveryAction, onDeliveryAdapterReady } from '../../delivery.js';
import { onShutdown } from '../../response-registry.js';
import { log } from '../../log.js';
import { uiBaseUrl } from '../../ui/server/config.js';
import { openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  ApprovalMessageError,
  parseApprovalMessage,
  type ApprovalResponseMessage,
} from '../../ui/shared/approval-message.js';
import { connectionMatchesAccess } from '../../ui/shared/access-authentication.js';
import type { AccountRequestData } from '../../ui/shared/approval.js';
import { accessRequestInput } from '../../ui/shared/connection-input.js';
export { accessRequestInput } from '../../ui/shared/connection-input.js';
import { McpAuthenticationError, parseMcpAuthentication } from '../../ui/shared/mcp-authentication.js';
import { resolveMcpAuthentication } from './mcp-authentication.js';
import { requestApproval, registerInteractiveApprovalHandler, notifyAgent } from '../approvals/primitive.js';
import {
  claimApprovalWorkflow,
  finishApprovalWorkflow,
  getApprovalWorkflow,
  getAccountRequest,
  notifyApprovalWorkflow,
  pendingWorkflow,
  latestApprovalWorkflow,
  linkApprovalSubmission,
  retryApprovalWorkflow,
  updateApprovalWorkflowData,
  recoverableApprovalWorkflows,
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

export { getAccountRequest } from '../approvals/workflows.js';

export async function requestAccess(
  session: Session,
  raw: unknown,
  requestId?: string,
  originMessageId?: string | null,
) {
  if (!usesAgentVault(session.agent_group_id))
    throw new ConnectionInputError('This agent must use AgentVault to request shared access.');
  if (getContainerConfig(session.agent_group_id)?.cli_scope === 'disabled')
    throw new ConnectionInputError('Access requests are disabled for this agent.', 403);
  const input = accessRequestInput(raw);
  if (input.mcp_server)
    input.resource_url = mcpConfiguration(session.agent_group_id, input.resource_url, input.mcp_server).resourceUrl;
  const inbound = openInboundDb(session.agent_group_id, session.id);
  let origin: { id: string; sender_user_id: string } | undefined;
  try {
    origin = inbound
      .prepare(
        `SELECT id,sender_user_id FROM messages_in WHERE kind IN ('chat', 'chat-sdk')
         AND (? IS NOT NULL AND id = ? OR ? IS NULL AND sender_user_id IS NOT NULL)
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(originMessageId ?? null, originMessageId ?? null, originMessageId ?? null) as typeof origin;
  } finally {
    inbound.close();
  }
  if (originMessageId && !origin)
    throw new ConnectionInputError('The originating conversation message no longer exists.', 409);
  if (requestId && !/^appr-access-[a-zA-Z0-9-]{1,100}$/.test(requestId))
    throw new ConnectionInputError('Invalid access request identifier');
  if (requestId && (getApproval(requestId) || getApprovalWorkflow(requestId)))
    return getAccountRequest(requestId, session.id);
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
    const status = getAccountRequest(existing.id, session.id);
    if (status.status === 'pending' || status.status === 'applying') {
      if (requestId) linkApprovalSubmission(status.id, requestId);
      return status;
    }
  }
  const prior = latestApprovalWorkflow(key);
  if (prior && !(prior.status === 'completed' && prior.kind === 'account_setup')) {
    if (requestId) linkApprovalSubmission(prior.id, requestId);
    return getAccountRequest(prior.id, session.id);
  }
  const id = requestId ?? `appr-access-${randomUUID()}`;
  if (!/^appr-access-[a-zA-Z0-9-]{1,100}$/.test(id))
    throw new ConnectionInputError('Invalid access request identifier');
  const previous = getApproval(id);
  if (previous) return getAccountRequest(id, session.id);
  const group = getAgentGroup(session.agent_group_id);
  const created = await requestApproval({
    session,
    originMessageId: origin?.id,
    agentName: group?.name ?? session.agent_group_id,
    action: ACCESS_ACTION,
    approvalId: id,
    workflowKey: key,
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
  return getAccountRequest(id, session.id);
}

export function reviewAccessRequest(userId: string, id: string) {
  const request = getAccountRequest(id);
  requireGroupAdmin(userId, request.agentGroupId);
  return request;
}

async function accountPreview(userId: string, request: AccountRequestData, connectionId: string) {
  const connection = await getConnection(userId, connectionId);
  return {
    requestRevision: request.revision,
    connection,
    matches: connectionMatchesAccess(connection, request.requirements),
    grantBreadth: 'All current and future URL patterns on this connection, not just the requested URL.',
    verification: 'Grant verification only. The agent must verify the authenticated operation after access is granted.',
    mcp: mcpConfiguration(request.agentGroupId, request.requirements.resource_url, request.requirements.mcp_server),
  };
}

export async function previewAccessRequest(userId: string, id: string, connectionId: string) {
  return accountPreview(userId, reviewAccessRequest(userId, id), connectionId);
}

export function prepareAccountRequest(userId: string, id: string, raw: unknown) {
  const request = reviewAccessRequest(userId, id);
  const body = objectBody(raw);
  if (Object.keys(body).some((key) => key !== 'request_revision') || !Number.isSafeInteger(body.request_revision))
    throw new ConnectionInputError('Refresh and supply the reviewed request revision.');
  if (request.status !== 'pending' || request.revision !== body.request_revision)
    throw new ConnectionInputError('The request changed. Refresh before setting up an account.', 409);
  if (request.kind === 'account_setup') return request;
  getDb().transaction(() => {
    if (!updateApprovalStatus(request.id, 'pending', undefined, Number(body.request_revision)))
      throw new ConnectionInputError('The request changed. Refresh before setting up an account.', 409);
    getDb().prepare("UPDATE interactions SET kind='account_setup' WHERE id=?").run(request.id);
  })();
  return getAccountRequest(request.id);
}

export async function completeAccountRequest(userId: string, id: string, raw: unknown) {
  const body = objectBody(raw);
  if (
    Object.keys(body).some(
      (key) => !['connection_id', 'connection_revision', 'request_revision', 'message'].includes(key),
    ) ||
    typeof body.connection_id !== 'string' ||
    typeof body.connection_revision !== 'string' ||
    !Number.isSafeInteger(body.request_revision)
  )
    throw new ConnectionInputError('Select an account and confirm the exact reviewed revisions.');
  let message;
  try {
    message = parseApprovalMessage(body.message);
  } catch (error) {
    if (!(error instanceof ApprovalMessageError)) throw error;
    throw new ConnectionInputError(error.message);
  }
  const request = reviewAccessRequest(userId, id);
  const preview = await accountPreview(userId, request, body.connection_id);
  if (request.kind !== 'account_setup' || request.status !== 'pending')
    throw new ConnectionInputError('This account setup request is no longer pending.', 409);
  if (!preview.matches || preview.connection.status !== 'ready')
    throw new ConnectionInputError('Finish setting up a compatible account before confirming.', 409);
  if (preview.connection.revision !== body.connection_revision)
    throw new ConnectionInputError('The account changed. Review setup again.', 412);
  const metadata = {
    status: preview.connection.status,
    destination: request.requirements.resource_url,
    authentication: request.requirements.authentication?.type ?? preview.connection.kind,
    scopes: preview.connection.kind === 'static' ? undefined : preview.connection.granted_scopes,
    scope_source: preview.connection.kind === 'static' ? undefined : preview.connection.scope_source,
  };
  const responseMessage = message ? { userId, message } : undefined;
  getDb().transaction(() => {
    if (!claimApprovalWorkflow(request.id, Number(body.request_revision), { userId, responseMessage }))
      throw new ConnectionInputError('The request changed. Refresh before confirming account setup.', 409);
    finishApprovalWorkflow(
      request.id,
      'completed',
      `Account setup confirmed. Setup metadata: ${JSON.stringify(metadata)}. No agent access was granted and no MCP binding was changed. Verify this metadata only; authenticated operations require a separate request_access and explicit user approval. Do not assume account setup grants access or automatically replay writes.`,
      false,
      responseMessage,
      userId,
    );
  })();
  await notifyApprovalWorkflow(request.id);
  return getAccountRequest(request.id);
}

function mcpConfiguration(groupId: string, resource: string, target?: string) {
  const row = getContainerConfig(groupId);
  if (!row) throw new ConnectionInputError('Agent configuration no longer exists.', 409);
  const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  const endpoints = Object.entries(servers).flatMap(([name, server]) => {
    if ((target && name !== target) || !('url' in server)) return [];
    const url = URL.parse(server.url);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) return [];
    url.search = '';
    if (url.href.replace(/\/+$/, '') !== resource.replace(/\/+$/, '')) return [];
    return [{ name, resourceUrl: url.href }];
  });
  const names = endpoints.map(({ name }) => name);
  if (target && !names.includes(target))
    throw new ConnectionInputError('The named MCP server no longer matches the requested endpoint.', 409);
  return {
    resourceUrl: endpoints.find(({ name }) => name === target)?.resourceUrl ?? resource,
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
  reviewedConnectionRevision?: string;
  grantApplied?: boolean;
  configureMcp?: boolean;
  configRevision?: string;
  appliedConfigRevision?: string;
  mcpServer?: string;
  accountAlias?: string;
  responseMessage?: ApprovalResponseMessage;
}

async function selectionGranted(id: string, selection: ApplySelection): Promise<boolean> {
  const request = reviewAccessRequest(selection.userId, id);
  const connection = await getConnection(selection.userId, selection.connectionId);
  return (
    connection.revision === selection.connectionRevision &&
    connection.status === 'ready' &&
    connectionMatchesAccess(connection, request.requirements) &&
    connection.grants.some((grant) => grant.vault === request.agentGroupId && grant.status === 'active')
  );
}

export async function applyAccessRequest(userId: string, id: string, raw: unknown) {
  const body = objectBody(raw);
  let message: string | undefined;
  try {
    message = parseApprovalMessage(body.message);
  } catch (error) {
    if (!(error instanceof ApprovalMessageError)) throw error;
    throw new ConnectionInputError(error.message);
  }
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
          'message',
        ].includes(key),
    ) ||
    typeof body.connection_id !== 'string' ||
    typeof body.connection_revision !== 'string' ||
    !Number.isSafeInteger(body.request_revision) ||
    (body.configure_mcp !== undefined && typeof body.configure_mcp !== 'boolean') ||
    (body.configure_mcp && typeof body.config_revision !== 'string')
  )
    throw new ConnectionInputError('Select a connection and confirm the exact reviewed revisions.');
  const request = reviewAccessRequest(userId, id);
  const preview = await accountPreview(userId, request, body.connection_id);
  id = request.id;
  const current = reviewAccessRequest(userId, id);
  if (current.kind === 'account_setup')
    throw new ConnectionInputError(
      'Account setup cannot grant access. Confirm setup, then request access separately.',
      409,
    );
  if (current.status !== 'pending') throw new ConnectionInputError('This approval is no longer pending.', 409);
  if (request.status !== 'pending') throw new ConnectionInputError('This approval is no longer pending.', 409);
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
    reviewedConnectionRevision: body.connection_revision,
    configureMcp: body.configure_mcp === true,
    configRevision: preview.mcp.revision,
    ...(message ? { responseMessage: { userId, message } } : {}),
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
  if (!beginApprovalExecution(getApproval(id)!))
    throw new ConnectionInputError('This approval is already being applied.', 409);
  if (!claimApprovalWorkflow(id, Number(body.request_revision), { ...selection })) {
    endApprovalExecution(id);
    throw new ConnectionInputError('The approval changed or is already being applied. Refresh before continuing.', 409);
  }
  activeApplications.add(id);
  let phase = 'grant';
  try {
    const existing = preview.connection.grants.find((grant) => grant.vault === request.agentGroupId);
    if (existing?.status !== 'active') {
      const granted = await grantConnection(userId, body.connection_id, request.agentGroupId, {
        revision: body.connection_revision,
      });
      if (granted.id !== selection.connectionId)
        throw new ConnectionInputError('The gateway returned a different connection after granting access.', 502);
      // The public ETag includes recipient grants/handles and changes on our own successful mutation.
      selection.connectionRevision = granted.revision;
      selection.grantApplied = true;
      updateApprovalWorkflowData(id, { ...selection });
    }
    phase = 'grant verification';
    if (!(await selectionGranted(id, selection)))
      throw new ConnectionInputError('Access could not be verified after applying the grant.', 409);
    let runtime: Awaited<ReturnType<typeof runtimeInstructions>> | undefined;
    if (selection.configureMcp) {
      phase = 'MCP configuration';
      const current = mcpConfiguration(request.agentGroupId, request.requirements.resource_url, selection.mcpServer);
      if (current.revision !== selection.configRevision)
        throw new ConnectionInputError(
          'MCP configuration changed while applying access; review the resulting grant and configuration.',
          412,
        );
      requireGroupAdmin(userId, request.agentGroupId);
      const config = getContainerConfig(request.agentGroupId)!;
      const servers = JSON.parse(config.mcp_servers) as Record<string, McpServerConfig>;
      const serverName = selection.mcpServer!;
      const server = servers[serverName];
      if (!('url' in server)) throw new ConnectionInputError('Named MCP transport changed.', 409);
      servers[serverName] = {
        ...server,
        url: request.requirements.resource_url,
        authentication,
        headers: Object.fromEntries(
          Object.entries(server.headers ?? {}).filter(
            ([key]) => !['authorization', 'x-agentvault-binding'].includes(key.toLowerCase()),
          ),
        ),
      };
      getDb().transaction(() => {
        updateContainerConfigJson(request.agentGroupId, 'mcp_servers', servers);
        selection.appliedConfigRevision = mcpConfiguration(
          request.agentGroupId,
          request.requirements.resource_url,
          serverName,
        ).revision;
        updateApprovalWorkflowData(id, { ...selection });
      })();
      phase = 'MCP connection resolution';
      const resolved = await resolveMcpAuthentication(request.agentGroupId, {
        [serverName]: servers[serverName],
      });
      if (resolved.statuses[0]?.status !== 'ready')
        throw new ConnectionInputError(
          'The selected MCP connection could not be resolved. Review Credentials and the named server.',
          409,
        );
    } else {
      runtime = await runtimeInstructions(userId, request.agentGroupId, preview.connection);
    }
    finishApprovalWorkflow(
      id,
      'completed',
      `Access granted for ${request.requirements.resource_url}. The group grant was verified; upstream authentication has not yet been verified. ${
        selection.configureMcp
          ? `Only MCP server ${JSON.stringify(selection.mcpServer)} is configured to use account alias ${JSON.stringify(selection.accountAlias)}. The host resolves its current binding; do not construct authentication headers.`
          : `Runtime routing: ${JSON.stringify(runtime!.instructions)}.`
      } Safely verify the original operation, then continue the original request with its original dates, timezone and account choice. Do not automatically replay writes or create a recurring poller.`,
      selection.configureMcp,
      selection.responseMessage,
      userId,
    );
  } catch (error) {
    const reason =
      error instanceof ConnectionInputError
        ? error.message
        : error instanceof AgentVaultError
          ? `The credential gateway rejected the operation${error.status ? ` (HTTP ${error.status})` : ''}.`
          : 'An unexpected host error occurred; see the service logs.';
    finishApprovalWorkflow(
      id,
      'failed',
      `Access approval failed during ${phase}. ${reason} Some changes may have applied. Review and retry this request; existing credentials do not need to be recreated.`,
      false,
      selection.responseMessage,
      userId,
    );
    log.error('Access approval application failed', { approvalId: id, userId, phase, err: error });
    await notifyApprovalWorkflow(id);
    throw error;
  } finally {
    activeApplications.delete(id);
    endApprovalExecution(id);
  }
  await notifyApprovalWorkflow(id);
  return getAccountRequest(id);
}

export function retryAccessRequest(userId: string, id: string, raw: unknown) {
  const request = reviewAccessRequest(userId, id);
  const body = objectBody(raw);
  if (Object.keys(body).some((key) => key !== 'request_revision') || !Number.isSafeInteger(body.request_revision))
    throw new ConnectionInputError('Refresh and supply the reviewed request revision.');
  if (request.expiresAt && request.expiresAt <= new Date().toISOString())
    throw new ConnectionInputError('This request has expired. Ask the agent to create a new request.', 409);
  if (!retryApprovalWorkflow(request.id, Number(body.request_revision), userId))
    throw new ConnectionInputError('Only a current failed request can be reopened for review.', 409);
  log.info('Access approval reopened for review', { approvalId: request.id, userId });
  return getAccountRequest(request.id);
}

export async function cancelAccessRequest(id: string, sessionId: string) {
  const request = getAccountRequest(id, sessionId);
  if (request.status !== 'pending')
    throw new ConnectionInputError('Only a pending access request can be cancelled.', 409);
  finishApprovalWorkflow(request.id, 'cancelled', 'Your access request was cancelled without changing credentials.');
  await notifyApprovalWorkflow(request.id);
  return getAccountRequest(request.id, sessionId);
}

registerInteractiveApprovalHandler(ACCESS_ACTION, async (approval, response, userId) => {
  const request = reviewAccessRequest(userId, approval.id);
  if (request.status !== 'pending') return;
  const message = parseApprovalMessage(response.message);
  const responseMessage = message ? { userId, message } : undefined;
  if (response.value === 'reject') {
    finishApprovalWorkflow(
      approval.id,
      'rejected',
      `Your ${request.kind === 'account_setup' ? 'account setup' : 'access'} request was rejected. No credentials were changed. Do not repeat this request unless the user asks.`,
      false,
      responseMessage,
      userId,
    );
    await notifyApprovalWorkflow(approval.id);
  } else if (response.value === 'review') {
    const session = getSession(approval.session_id!);
    if (session)
      notifyAgent(
        session,
        `Access review is still pending. The user must privately select and confirm a credential in BananaClaw: ${reviewUrl(approval.id)}. Do not poll, search for secrets or treat review as approval.`,
        approval.origin_message_id,
        responseMessage,
      );
  } else {
    throw new ConnectionInputError(
      'Open Review access and confirm a connection; a generic Approve cannot grant credentials.',
      409,
    );
  }
});

registerDeliveryAction(ACCESS_ACTION, async (content, session, _inDb, context) => {
  try {
    const { requestId, ...body } = content;
    delete body.action;
    delete body.timelinePosition;
    await requestAccess(session, body, typeof requestId === 'string' ? requestId : undefined, context?.originMessageId);
  } catch (error) {
    if (!(error instanceof ConnectionInputError)) throw error;
    log.warn('Access request rejected', { sessionId: session.id, error: error.message });
    notifyAgent(session, `Access request failed: ${error.message}`, context?.originMessageId);
  }
});

export async function recoverAccessRequests(recoverApplying = false): Promise<void> {
  const rows = recoverableApprovalWorkflows();
  for (const row of rows) {
    try {
      if (row.status === 'applying' && recoverApplying && !activeApplications.has(row.id)) {
        const selection = JSON.parse(row.data_json) as ApplySelection;
        const request = reviewAccessRequest(selection.userId, row.id);
        const configReady =
          !selection.configureMcp ||
          Boolean(
            selection.mcpServer &&
            selection.accountAlias &&
            selection.appliedConfigRevision ===
              mcpConfiguration(request.agentGroupId, request.requirements.resource_url, selection.mcpServer).revision,
          );
        if (configReady && (await selectionGranted(row.id, selection))) {
          const connection = await getConnection(selection.userId, selection.connectionId);
          const runtime = selection.configureMcp
            ? undefined
            : await runtimeInstructions(selection.userId, request.agentGroupId, connection);
          if (selection.configureMcp) {
            const config = getContainerConfig(request.agentGroupId)!;
            const servers = JSON.parse(config.mcp_servers) as Record<string, McpServerConfig>;
            const resolved = await resolveMcpAuthentication(request.agentGroupId, {
              [selection.mcpServer!]: servers[selection.mcpServer!],
            });
            if (resolved.statuses[0]?.status !== 'ready')
              throw new ConnectionInputError('MCP reference no longer resolves.', 409);
          }
          finishApprovalWorkflow(
            row.id,
            'completed',
            `Your approved access grant was recovered and verified after restart. ${
              selection.configureMcp
                ? `Use MCP server ${JSON.stringify(selection.mcpServer)} with account alias ${JSON.stringify(selection.accountAlias)}; the host manages authentication.`
                : `Runtime routing: ${JSON.stringify(runtime!.instructions)}.`
            } Safely verify upstream access before continuing the original request. Preserve its original dates and timezone; do not replay writes automatically.`,
            selection.configureMcp,
            selection.responseMessage,
            selection.userId,
          );
        } else {
          finishApprovalWorkflow(
            row.id,
            'failed',
            'Access approval was interrupted by restart. Review Credentials; no additional grant was replayed automatically.',
            false,
            selection.responseMessage,
            selection.userId,
          );
        }
      } else {
        getAccountRequest(row.id);
      }
      await notifyApprovalWorkflow(row.id);
    } catch (error) {
      if (
        row.status === 'applying' &&
        recoverApplying &&
        (error instanceof ConnectionInputError ||
          (error instanceof AgentVaultError && !error.unreachable && error.status !== undefined && error.status < 500))
      ) {
        finishApprovalWorkflow(
          row.id,
          'failed',
          'Access approval cannot resume because its authority or credential changed. Review Credentials; no additional grant was replayed.',
        );
        await notifyApprovalWorkflow(row.id);
      }
      // Isolate independent approval recovery; retain undelivered results for retry.
      log.error('Access approval recovery pending', { approvalId: row.id, error });
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
