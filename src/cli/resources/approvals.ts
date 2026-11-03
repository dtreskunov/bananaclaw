import { registerResource } from '../crud.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'approvals',
  description:
    'Retained approval records. Filter --status pending for requests awaiting a decision. Private account selections and recovery state are never listed.',
  idColumn: 'approval_id',
  columns: [
    {
      name: 'approval_id',
      type: 'string',
      description: 'Unique approval identifier (also used as the card questionId).',
    },
    {
      name: 'session_id',
      type: 'string',
      description: 'Session that requested the approval. Null for sessionless administrative approvals.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original request identifier (source request UUID or same as approval_id).',
    },
    {
      name: 'action',
      type: 'string',
      description:
        'Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, request_access).',
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
    { name: 'kind', type: 'string', description: 'confirmation, account_setup, or access_grant.' },
    { name: 'expires_at', type: 'string', description: 'When this approval expires (request TTL).' },
    {
      name: 'status',
      type: 'string',
      description: 'Current status.',
      enum: ['pending', 'applying', 'approved', 'completed', 'rejected', 'expired', 'failed', 'cancelled'],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
  ],
  operations: { list: 'open', get: 'open' },
});
