import { register } from '../registry.js';
import { getSession } from '../../db/sessions.js';
import { accessRequestStatus, cancelAccessRequest, requestAccess } from '../../modules/credentials/access-requests.js';
import { ConnectionInputError } from '../../modules/credentials/shared-connections.js';

for (const verb of ['request', 'status', 'cancel'] as const) {
  register({
    name: `access-${verb}`,
    resource: 'access',
    access: 'open',
    description:
      verb === 'request'
        ? 'Request user-assisted credential access. --resource-url <exact-https-url> --reason <purpose>. Never provide secrets. Wait for user review; do not poll.'
        : `${verb === 'status' ? 'Read' : 'Cancel'} an access request from this session. --request-id <id>.`,
    parseArgs: (raw) => raw,
    handler: async (args, ctx) => {
      if (ctx.caller !== 'agent')
        throw new ConnectionInputError('Access requests require an authenticated agent session.');
      const session = getSession(ctx.sessionId);
      if (!session || session.agent_group_id !== ctx.agentGroupId)
        throw new ConnectionInputError('Session not found.', 404);
      const allowed = verb === 'request' ? ['resource-url', 'reason', 'scopes'] : ['request-id'];
      if (Object.keys(args).some((key) => !allowed.includes(key)))
        throw new ConnectionInputError('Unsupported access request field.');
      if (verb === 'request') {
        let scopes: unknown;
        if (args.scopes !== undefined) {
          if (typeof args.scopes !== 'string') throw new ConnectionInputError('Supply scopes as a JSON array.');
          scopes = JSON.parse(args.scopes);
        }
        return requestAccess(session, {
          resource_url: args['resource-url'],
          reason: args.reason,
          ...(scopes === undefined ? {} : { scopes }),
        });
      }
      if (typeof args['request-id'] !== 'string') throw new ConnectionInputError('--request-id is required.');
      return verb === 'status'
        ? accessRequestStatus(args['request-id'], ctx.sessionId)
        : cancelAccessRequest(args['request-id'], ctx.sessionId);
    },
  });
}
