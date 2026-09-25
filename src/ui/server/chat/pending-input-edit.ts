import {
  INPUT_EDIT_PREFIX,
  parseInputEditResult,
  type InputEditRequest,
  type InputEditResult,
} from '../../../pending-input-edit.js';
import { getSessionActiveTurn, onSessionSignal } from '../../../session-link.js';
import { openInboundDb, openOutboundDb, writeSessionMessage } from '../../../session-manager.js';

interface EditContext {
  groupId: string;
  sessionId: string;
  userId: string;
  platformIds: string[];
  threadId: string | null;
  messageId: string;
  requestId: string;
  expectedText: string;
  text: string;
}

interface EditResponse {
  status: number;
  body: { ok: true; id: string; text: string } | { error: string };
}

function readResult(ctx: EditContext, requestId = ctx.requestId): InputEditResult | undefined {
  const db = openOutboundDb(ctx.groupId, ctx.sessionId);
  try {
    const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get(`${INPUT_EDIT_PREFIX}${requestId}`) as
      | { value: string }
      | undefined;
    return row ? parseInputEditResult(row.value) : undefined;
  } finally {
    db.close();
  }
}

function response(ctx: EditContext, result: InputEditResult): EditResponse {
  if (result.status === 'conflict') {
    return {
      status: 409,
      body: { error: result.reason === 'not_pending' ? 'input_not_pending' : (result.reason ?? 'input_not_pending') },
    };
  }
  const db = openInboundDb(ctx.groupId, ctx.sessionId);
  try {
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(result.messageId) as
      | { content: string }
      | undefined;
    const content: unknown = row ? JSON.parse(row.content) : null;
    if (!content || typeof content !== 'object' || !('text' in content) || typeof content.text !== 'string') {
      throw new Error('Accepted input edit target is missing');
    }
    return { status: 200, body: { ok: true, id: ctx.messageId, text: content.text } };
  } finally {
    db.close();
  }
}

function awaitResult(ctx: EditContext): Promise<EditResponse> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve({ status: 503, body: { error: 'edit_pending' } });
    }, 5_000);
    const check = () => {
      try {
        const result = readResult(ctx);
        if (!result) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(response(ctx, result));
      } catch (err) {
        clearTimeout(timer);
        unsubscribe();
        reject(err);
      }
    };
    unsubscribe = onSessionSignal((sessionId, kind) => {
      if (sessionId === ctx.sessionId && kind === 'input.state') check();
    });
    check();
  });
}

export async function editPendingInput(ctx: EditContext): Promise<EditResponse> {
  const inDb = openInboundDb(ctx.groupId, ctx.sessionId);
  try {
    const rows = inDb
      .prepare(
        `SELECT id, content, status, sender_identity, platform_id FROM messages_in
        WHERE id IN (?, ?) AND kind IN ('chat', 'chat-sdk') AND channel_type = 'web'
          AND source_session_id IS NULL AND trigger = 1
          AND platform_id IN (${ctx.platformIds.map(() => '?').join(',')})
          AND thread_id IS ? AND sender_user_id = ?`,
      )
      .all(ctx.messageId, `${ctx.messageId}:${ctx.groupId}`, ...ctx.platformIds, ctx.threadId, ctx.userId) as Array<{
      id: string;
      content: string;
      status: string;
      sender_identity: string | null;
      platform_id: string;
    }>;
    if (rows.length !== 1) return { status: 404, body: { error: 'message_not_found' } };
    const target = rows[0];
    const request: InputEditRequest = {
      action: 'edit_input',
      requestId: ctx.requestId,
      messageId: target.id,
      expectedText: ctx.expectedText,
      replacementText: ctx.text,
    };
    const existing = inDb
      .prepare('SELECT content, sender_user_id FROM messages_in WHERE id = ?')
      .get(`edit-${ctx.requestId}`) as { content: string; sender_user_id: string | null } | undefined;
    if (existing) {
      if (existing.content !== JSON.stringify(request) || existing.sender_user_id !== ctx.userId) {
        return { status: 409, body: { error: 'request_id_conflict' } };
      }
      const result = readResult(ctx);
      if (result) return response(ctx, result);
    } else {
      const current = getSessionActiveTurn(ctx.sessionId);
      if (!current.connected) return { status: 503, body: { error: 'runner_disconnected' } };
      if (!current.turn?.supportsInputEditing) return { status: 503, body: { error: 'editing_unsupported' } };
      if (
        current.turn.status !== 'running' ||
        current.turn.channelType !== 'web' ||
        !ctx.platformIds.includes(current.turn.platformId) ||
        current.turn.threadId !== ctx.threadId
      ) {
        return { status: 409, body: { error: 'input_not_pending' } };
      }
      if (target.status !== 'pending') return { status: 409, body: { error: 'input_not_pending' } };
      const original: unknown = JSON.parse(target.content);
      if (!original || typeof original !== 'object' || !('text' in original) || original.text !== ctx.expectedText) {
        return { status: 409, body: { error: 'text_changed' } };
      }
      const outDb = openOutboundDb(ctx.groupId, ctx.sessionId);
      try {
        if (outDb.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(target.id)) {
          return { status: 409, body: { error: 'input_not_pending' } };
        }
      } finally {
        outDb.close();
      }
      const prior = inDb
        .prepare(
          `SELECT json_extract(content, '$.requestId') AS requestId FROM messages_in
          WHERE kind = 'system' AND json_valid(content)
            AND json_extract(content, '$.action') = 'edit_input'
            AND json_extract(content, '$.messageId') = ?`,
        )
        .all(target.id) as Array<{ requestId: string }>;
      if (prior.some((row) => !readResult(ctx, row.requestId))) {
        return { status: 409, body: { error: 'edit_in_progress' } };
      }
      writeSessionMessage(ctx.groupId, ctx.sessionId, {
        id: `edit-${ctx.requestId}`,
        kind: 'system',
        timestamp: new Date().toISOString(),
        channelType: 'web',
        platformId: target.platform_id,
        threadId: ctx.threadId,
        senderUserId: ctx.userId,
        senderIdentity: target.sender_identity,
        content: JSON.stringify(request),
        trigger: 0,
      });
    }
  } finally {
    inDb.close();
  }
  return awaitResult(ctx);
}
