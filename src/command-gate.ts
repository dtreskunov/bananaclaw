/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Intercepted commands: handled by the host (e.g. /web-login mints a
 *   UI magic link); the host writes a direct outbound reply.
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';
import { issueMagicLink } from './ui/server/auth.js';
import { isUiEnabled, uiBaseUrl } from './ui/server/config.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'reply'; text: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands, 'reply' for host-handled commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (command === '/web-login') return handleWebLogin(userId);

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function handleWebLogin(userId: string | null): GateResult {
  if (!userId) {
    return { action: 'reply', text: 'Could not identify your account for login.' };
  }
  if (!isUiEnabled()) {
    return { action: 'reply', text: 'Web UI is not enabled on this server.' };
  }
  const { token } = issueMagicLink(userId);
  const url = `${uiBaseUrl()}/auth/redeem?t=${token}`;
  return { action: 'reply', text: `Your one-time login link (expires in 10 minutes, single use):\n${url}` };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
