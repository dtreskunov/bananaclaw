/**
 * Agent-link MCP tool: add_agent_destination.
 *
 * Fire-and-forget request to add another agent group as a destination from
 * this agent. The host validates permissions and either auto-applies (when an
 * admin of this group is also admin of the target) or queues an approval for
 * the target group's admins.
 *
 * Admin-only. Non-admin containers never see this tool (see mcp-tools/index.ts).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './tool-registry.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const addAgentDestination: McpToolDefinition = {
  tool: {
    name: 'add_agent_destination',
    description:
      'Add another existing agent group as a destination, so you can route messages to it via send_message(to="..."). Requires admin on the target group, or admin-on-both auto-applies; otherwise an approval is sent to a target-group admin. Admin-only. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_group_id: {
          type: 'string',
          description: 'Agent group id to link to (obtain via list_agents or similar).',
        },
        local_name: {
          type: 'string',
          description:
            'Name you will use to refer to the target agent (lowercase letters/digits/hyphen, ≤40 chars).',
        },
        also_reverse: {
          type: 'boolean',
          description:
            'Optional. Also create a reverse destination from the target agent back to this one. Defaults to false.',
        },
        reverse_local_name: {
          type: 'string',
          description:
            'Optional name the target agent should use to refer to this one. Defaults to this agent\'s folder/name.',
        },
      },
      required: ['target_group_id', 'local_name'],
    },
  },
  async handler(args) {
    const targetGroupId = args.target_group_id as string;
    const localName = args.local_name as string;
    if (!targetGroupId) return err('target_group_id is required');
    if (!localName) return err('local_name is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_agent_destination',
        requestId,
        target_group_id: targetGroupId,
        local_name: localName,
        also_reverse: args.also_reverse === true,
        reverse_local_name: (args.reverse_local_name as string) || undefined,
      }),
    });

    log(`add_agent_destination: ${requestId} → ${targetGroupId} as "${localName}"`);
    return ok(
      `Requested link to agent ${targetGroupId} as "${localName}". You'll be notified when it's applied or if approval is needed.`,
    );
  },
};

registerTools([addAgentDestination]);
