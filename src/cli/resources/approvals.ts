import { getApproval } from '../../db/approvals.js';
import { queryInteractions } from '../../db/interactions.js';
import type { Approval } from '../../types.js';
import { registerResource } from '../crud.js';
import { parseTimestamp } from '../../time.js';
import { resendSenderApproval } from '../../modules/permissions/sender-approval.js';

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
      handler: async (args) => {
        if ('expires_at' in args) throw new Error('Interaction expiry filters are no longer supported');
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
      handler: async (args) => {
        const approval = getApproval(String(args.id ?? ''));
        if (!approval) throw new Error('Approval not found');
        return approval;
      },
    },
  },
});
