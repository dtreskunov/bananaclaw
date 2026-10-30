import type http from 'node:http';
import { log } from '../../../log.js';
import { listAccessibleAgentGroups } from '../../../modules/permissions/access.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { AgentVaultError, gatewayMessage } from '../../../modules/credentials/agent-vault-client.js';
import {
  changeConnectionApp,
  ConnectionInputError,
  createConnection,
  deleteConnection,
  discoverConnectionScopes,
  detachConnection,
  getConnection,
  grantConnection,
  groupConnectionAccess,
  listConnectionApps,
  listConnections,
  objectBody,
  revokeConnectionGrant,
  startConnectionSignIn,
  updateConnection,
} from '../../../modules/credentials/shared-connections.js';
import { getSignIn } from '../../../modules/credentials/sign-ins.js';
import { uiBaseUrl } from '../server.js';
import { recordAdminAction } from './audit.js';
import {
  applyAccessRequest,
  previewAccessRequest,
  reviewAccessRequest,
} from '../../../modules/credentials/access-requests.js';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 262144) throw new ConnectionInputError('Credential request is too large', 413);
    chunks.push(data);
  }
  if (!chunks.length) return {};
  try {
    return objectBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConnectionInputError('Invalid JSON');
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new ConnectionInputError('Invalid identifier');
  }
}

export async function handleCredentialsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  userId: string,
): Promise<boolean> {
  const access = /^\/api\/groups\/([^/]+)\/admin\/access(?:\/([^/]+))?$/.exec(path);
  if (path !== '/api/credentials' && !path.startsWith('/api/credentials/') && !access) return false;
  try {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      if (
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== new URL(uiBaseUrl()).origin)
      )
        throw new ConnectionInputError('Invalid request origin', 403);
    }
    const method = req.method;
    if (access) {
      const group = decode(access[1]);
      if (method === 'GET' && !access[2]) json(res, 200, { grants: await groupConnectionAccess(userId, group) });
      else if (method === 'DELETE' && access[2]) {
        await detachConnection(userId, decode(access[2]), group);
        audit(userId, 'credential_group_detach', decode(access[2]), { group });
        json(res, 200, { detached: true });
      } else throw new ConnectionInputError('Method not allowed', 405);
      return true;
    }
    const sub = path.slice('/api/credentials'.length);
    const request = /^\/access-requests\/([^/]+)(?:\/(preview|apply))?$/.exec(sub);
    if (request) {
      const requestId = decode(request[1]);
      if (method === 'GET' && !request[2]) {
        json(res, 200, reviewAccessRequest(userId, requestId));
      } else if (method === 'POST' && request[2] === 'preview') {
        const body = await readBody(req);
        if (typeof body.connection_id !== 'string' || Object.keys(body).some((key) => key !== 'connection_id'))
          throw new ConnectionInputError('Select a personal connection.');
        json(res, 200, await previewAccessRequest(userId, requestId, body.connection_id));
      } else if (method === 'POST' && request[2] === 'apply') {
        const result = await applyAccessRequest(userId, requestId, await readBody(req));
        audit(userId, 'credential_access_approved', requestId, { group: result.agent_group_id });
        json(res, 200, result);
      } else throw new ConnectionInputError('Method not allowed', 405);
      return true;
    }
    if (sub === '/scopes' && method === 'POST') {
      json(res, 200, await discoverConnectionScopes(userId, await readBody(req)));
      return true;
    }
    if (!sub && method === 'GET') {
      const [connections, apps] = await Promise.all([listConnections(userId), listConnectionApps(userId)]);
      json(res, 200, {
        connections,
        apps,
        groups: listAccessibleAgentGroups(userId).map((group) => ({
          id: group.id,
          name: group.name,
          canAdmin: hasAdminPrivilege(userId, group.id),
        })),
        canEditInstall: isOwner(userId) || isGlobalAdmin(userId),
      });
      return true;
    }
    if (sub === '/connections' && method === 'POST') {
      const connection = await createConnection(userId, await readBody(req));
      audit(userId, 'credential_connection_create', connection.id, { kind: connection.kind });
      json(res, 201, connection);
      return true;
    }
    let match = /^\/connections\/([^/]+)$/.exec(sub);
    if (match) {
      const connectionId = decode(match[1]);
      if (method === 'GET') json(res, 200, await getConnection(userId, connectionId));
      else if (method === 'PUT') {
        const connection = await updateConnection(userId, connectionId, await readBody(req));
        audit(userId, 'credential_connection_update', connectionId);
        json(res, 200, connection);
      } else if (method === 'DELETE') {
        const body = await readBody(req);
        await deleteConnection(userId, connectionId, body.revision ?? req.headers['if-match']);
        audit(userId, 'credential_connection_delete', connectionId);
        json(res, 200, { deleted: true });
      } else throw new ConnectionInputError('Method not allowed', 405);
      return true;
    }
    match = /^\/connections\/([^/]+)\/start$/.exec(sub);
    if (match && method === 'POST') {
      const connectionId = decode(match[1]);
      json(res, 200, await startConnectionSignIn(userId, connectionId, await readBody(req)));
      audit(userId, 'credential_connection_sign_in', connectionId);
      return true;
    }
    match = /^\/connections\/([^/]+)\/grants\/([^/]+)$/.exec(sub);
    if (match) {
      const connectionId = decode(match[1]),
        group = decode(match[2]);
      if (method === 'PUT') {
        const result = await grantConnection(userId, connectionId, group, await readBody(req));
        audit(userId, 'credential_connection_grant', connectionId, { group });
        json(res, 200, result);
      } else if (method === 'DELETE') {
        await revokeConnectionGrant(userId, connectionId, group);
        audit(userId, 'credential_connection_revoke', connectionId, { group });
        json(res, 200, { detached: true });
      } else throw new ConnectionInputError('Method not allowed', 405);
      return true;
    }
    match = /^\/sign-ins\/([^/]+)$/.exec(sub);
    if (match && method === 'GET') {
      const state = getSignIn(decode(match[1]));
      if (!state || state.userId !== userId) throw new ConnectionInputError('Unknown or expired sign-in', 404);
      json(res, 200, {
        status: state.status,
        connection_id: state.connection_id,
        account: state.account,
        error: state.error,
      });
      return true;
    }
    match = /^\/oauth-apps\/([^/]+)$/.exec(sub);
    if (match && (method === 'PUT' || method === 'DELETE')) {
      const scope = new URL(req.url || '/', 'http://localhost').searchParams.get('scope') || 'user';
      const result = await changeConnectionApp(
        userId,
        decode(match[1]),
        method,
        scope,
        method === 'PUT' ? await readBody(req) : undefined,
      );
      audit(userId, 'credential_oauth_app_update', decode(match[1]), { scope });
      json(res, 200, result ?? { deleted: true });
      return true;
    }
    json(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof ConnectionInputError) json(res, error.status, { error: error.message });
    else if (error instanceof AgentVaultError) {
      log.warn('Credential request rejected by gateway', { status: error.status, code: error.code });
      json(res, error.unreachable ? 503 : error.status || 502, {
        error: error.unreachable ? 'The credential gateway is unavailable' : gatewayMessage(error),
        code: error.code,
      });
    } else throw error;
  }
  return true;
}

function audit(userId: string, action: string, connectionId: string, payload?: Record<string, unknown>): void {
  recordAdminAction({
    actorUserId: userId,
    action,
    targetKind: 'credential_connection',
    targetId: connectionId,
    payload,
  });
}
