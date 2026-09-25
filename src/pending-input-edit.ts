import type Database from 'better-sqlite3';

export const INPUT_EDIT_PREFIX = 'input-edit:';
export const INPUT_EDIT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface InputEditRequest {
  action: 'edit_input';
  requestId: string;
  messageId: string;
  expectedText: string;
  replacementText: string;
}

export interface InputEditResult {
  requestId: string;
  messageId: string;
  status: 'accepted' | 'conflict';
  reason?: 'not_pending' | 'text_changed' | 'steering_consumed' | 'unsupported';
}

export function parseInputEditResult(value: string): InputEditResult {
  const result: unknown = JSON.parse(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid input edit result');
  const r = result as Record<string, unknown>;
  if (
    Object.keys(r).some((key) => !['requestId', 'messageId', 'status', 'reason'].includes(key)) ||
    typeof r.requestId !== 'string' ||
    !INPUT_EDIT_ID.test(r.requestId) ||
    typeof r.messageId !== 'string' ||
    !r.messageId ||
    r.messageId.length > 256 ||
    !['accepted', 'conflict'].includes(String(r.status)) ||
    (r.reason !== undefined &&
      !['not_pending', 'text_changed', 'steering_consumed', 'unsupported'].includes(String(r.reason)))
  )
    throw new Error('invalid input edit result');
  return {
    requestId: r.requestId,
    messageId: r.messageId,
    status: r.status as InputEditResult['status'],
    ...(r.reason !== undefined ? { reason: r.reason as InputEditResult['reason'] } : {}),
  };
}

export interface EditedInput {
  id: string;
  timestamp: string;
  channel_type: string;
  thread_id: string | null;
  sender_user_id: string;
  text: string;
}

/** Called inside the outbound transaction with the host's inbound DB attached. */
export function projectInputEditResult(
  db: Database.Database,
  key: string,
  value: string,
  replay = false,
): EditedInput | undefined {
  const result = parseInputEditResult(value);
  if (key !== `${INPUT_EDIT_PREFIX}${result.requestId}`) throw new Error('invalid input edit result key');
  const request = db
    .prepare(
      `SELECT content, sender_user_id, channel_type, platform_id, thread_id
       FROM input_edit_host.messages_in WHERE id = ? AND kind = 'system'`,
    )
    .get(`edit-${result.requestId}`) as
    | {
        content: string;
        sender_user_id: string;
        channel_type: string;
        platform_id: string;
        thread_id: string | null;
      }
    | undefined;
  if (!request) throw new Error('input edit result has no host request');
  const content = JSON.parse(request.content) as InputEditRequest;
  if (
    content.action !== 'edit_input' ||
    content.requestId !== result.requestId ||
    content.messageId !== result.messageId ||
    typeof content.expectedText !== 'string' ||
    typeof content.replacementText !== 'string'
  )
    throw new Error('input edit result mismatches host request');
  if (result.status === 'conflict') return undefined;
  const target = db
    .prepare(
      `SELECT id, timestamp, content, channel_type, thread_id, sender_user_id
       FROM input_edit_host.messages_in WHERE id = ? AND kind IN ('chat', 'chat-sdk')
         AND channel_type = 'web' AND channel_type = ? AND platform_id = ?
         AND source_session_id IS NULL AND trigger = 1
         AND thread_id IS ? AND sender_user_id = ?`,
    )
    .get(result.messageId, request.channel_type, request.platform_id, request.thread_id, request.sender_user_id) as
    | (Omit<EditedInput, 'text'> & { content: string })
    | undefined;
  if (!target) throw new Error('input edit target mismatches host request');
  const original: unknown = JSON.parse(target.content);
  if (
    !original ||
    typeof original !== 'object' ||
    Array.isArray(original) ||
    !('text' in original) ||
    typeof original.text !== 'string' ||
    (!replay && original.text !== content.expectedText)
  ) {
    throw new Error('input edit target changed before projection');
  }
  if (!replay) {
    db.prepare('UPDATE input_edit_host.messages_in SET content = ? WHERE id = ?').run(
      JSON.stringify({ ...original, text: content.replacementText }),
      target.id,
    );
  }
  return {
    id: target.id,
    timestamp: target.timestamp,
    channel_type: target.channel_type,
    thread_id: target.thread_id,
    sender_user_id: target.sender_user_id,
    text: replay ? original.text : content.replacementText,
  };
}
