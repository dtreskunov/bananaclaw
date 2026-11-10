import { getApproval } from '../../db/approvals.js';
import { queryInteractions } from '../../db/interactions.js';
import type { Approval } from '../../types.js';
import { registerResource } from '../crud.js';
import { parseTimestamp } from '../../time.js';
import { resendSenderApproval } from '../../modules/permissions/sender-approval.js';
import { withdrawApproval } from '../../modules/approvals/withdraw.js';
import { getApprovalWorkflow } from '../../modules/approvals/workflows.js';

const filters = ['id', 'session_id', 'request_id', 'agent_group_id', 'kind', 'status', 'created_at'];
registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'interactions',
  idColumn: 'id',
  description: 'Current confirmation and account interactions; private progress is never listed.',
  columns: filters.map((name) => ({ name, type: 'string', description: name })),
  operations: {},
  customOperations: {
    resend: {
      access: 'host',
      description: 'Reissue an existing unknown-sender approval to its recorded authorized approver.',
      handler: async (args) => {
        if (typeof args.id !== 'string' || !args.id) throw new Error('--id is required');
        return resendSenderApproval(args.id);
      },
    },
    list: {
      access: 'open',
      description: 'List retained approval interactions; filter --status pending for decisions awaiting a response.',
      handler: async (args, ctx) => {
        if ('expires_at' in args) throw new Error('Interaction expiry filters are no longer supported');
        if (ctx.caller === 'agent') {
          if (
            (args.session_id !== undefined && args.session_id !== ctx.sessionId) ||
            (args.agent_group_id !== undefined && args.agent_group_id !== ctx.agentGroupId)
          )
            throw new Error('Approvals are scoped to this session.');
          args = { ...args, session_id: ctx.sessionId };
          delete args.agent_group_id;
        }
        const selected = Object.entries(args).filter(([key]) => filters.includes(key));
        return queryInteractions<Approval>(
          `SELECT * FROM interactions WHERE 1=1
          ${selected.map(([key]) => `AND ${key}=?`).join(' ')} LIMIT ?`,
          ...selected.map(([key, value]) => {
            if (key !== 'created_at') return value;
            if (value === null) return null;
            if (typeof value !== 'string') throw new Error(`${key} must be a timestamp string`);
            return parseTimestamp(value);
          }),
          Math.max(1, Number(args.limit ?? 200)),
        );
      },
    },
    get: {
      access: 'open',
      description: 'Get an approval interaction by --id.',
      handler: async (args, ctx) => {
        const id = String(args.id ?? '');
        let approval = getApproval(id);
        if (!approval) {
          const workflow = getApprovalWorkflow(id);
          if (workflow) approval = getApproval(workflow.id);
        }
        if (!approval || (ctx.caller === 'agent' && approval.session_id !== ctx.sessionId))
          throw new Error('Approval not found');
        return approval;
      },
    },
    withdraw: {
      access: 'open',
      description: 'Withdraw your own pending approval request. --id <approval-id>. Cannot undo applied actions.',
      handler: async (args, ctx) => {
        if (ctx.caller !== 'agent') throw new Error('Withdrawal requires an authenticated agent session.');
        if (typeof args.id !== 'string' || !args.id) throw new Error('--id is required');
        return withdrawApproval(args.id, ctx.sessionId);
      },
    },
  },
});
