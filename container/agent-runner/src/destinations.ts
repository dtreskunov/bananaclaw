/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';
import { getSessionRouting } from './db/session-routing.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  // The session origin — the channel this conversation actually lives on — is
  // recorded in session_routing. Match it back to a destination so we can flag
  // it explicitly. This stops the agent from picking a same-named-but-wrong
  // destination (e.g. an outbound email persona named after the user) instead
  // of the channel the human is actually waiting on.
  const routing = getSessionRouting();
  const origin =
    routing.channel_type && routing.platform_id
      ? all.find(
          (d) =>
            d.type === 'channel' &&
            d.channelType === routing.channel_type &&
            d.platformId === routing.platform_id,
        )
      : undefined;

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    lines.push(`Your destination is ${describeDestination(d)}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const marker = origin && d.name === origin.name ? ' — **← this conversation; reply here by default**' : '';
      lines.push(`- ${describeDestination(d)}${marker}`);
    }
  }
  lines.push('');
  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking to show in the activity trace but not send to a destination.',
  );
  lines.push('');
  lines.push(
    '**Routing rule:** every inbound `<message>` tag carries a `from="name"` attribute. Default to addressing the destination it came `from` — a human channel message gets a human-channel reply; a peer-agent message gets a peer-agent reply. Cross-routing (forwarding a human request to a peer agent, or relaying a peer\'s answer back to the human) is fine when the request explicitly asks for it, but never silently swap destinations.',
  );
  if (origin && all.length > 1) {
    lines.push('');
    lines.push(
      `**This conversation lives on \`${origin.name}\`.** Unless a request explicitly tells you to send elsewhere, reply there — addressing a different destination means the human waiting here sees nothing.`,
    );
  }
  if (all.some((d) => d.type === 'agent') && all.some((d) => d.type === 'channel')) {
    lines.push('');
    lines.push(
      '_Common mistake to avoid:_ when a human user messages you, do not reply by addressing a peer agent destination — the human will see nothing. Reply to the channel destination the user wrote `from`, and only loop in a peer agent if the task actually calls for it.',
    );
  }
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn — handy for a quick acknowledgment ("on it") before a slow tool call. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.',
  );
  lines.push('');
  lines.push(
    '**Do not duplicate content between `send_message` and the final `<message>` wrap.** If you have already delivered the answer via `send_message`, do not also include the same body in a final-text `<message to="…">` block — the user will see it twice. Either send the full reply via `send_message` *or* via the final-text `<message>` wrap, not both. Mixing the two is only correct when they carry different content (e.g. an "on it" `send_message` followed by the actual answer in the final `<message>`).',
  );
  return lines.join('\n');
}

function describeDestination(d: DestinationEntry): string {
  const label = d.displayName && d.displayName !== d.name ? ` — ${d.displayName}` : '';
  const kind = d.type === 'agent' ? 'peer agent' : `${d.channelType ?? 'channel'} channel`;
  return `\`${d.name}\` (${kind}${label})`;
}
