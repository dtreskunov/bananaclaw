import { getApproval } from '../../db/approvals.js';
import { queryInteractions } from '../../db/interactions.js';
import type { Approval } from '../../types.js';
import { registerResource } from '../crud.js';

const filters = ['id', 'session_id', 'request_id', 'agent_group_id', 'kind', 'status', 'created_at', 'expires_at'];
registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'interactions',
  idColumn: 'id',
  description: 'Current confirmation and account interactions; private progress is never listed.',
  columns: filters.map((name) => ({ name, type: 'string', description: name })),
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List retained approval interactions; filter --status pending for decisions awaiting a response.',
      handler: async (args) => {
        const selected = Object.entries(args).filter(([key]) => filters.includes(key));
        return queryInteractions<Approval>(
          `SELECT * FROM interactions WHERE kind!='question'
          ${selected.map(([key]) => `AND ${key}=?`).join(' ')} LIMIT ?`,
          ...selected.map(([, value]) => value),
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
