import { getOutboundDb } from './db/connection.js';
import type { TurnContext } from './current-batch.js';
import type { RoutingContext } from './formatter.js';

export const MAX_SUGGESTED_RESPONSES = 6;
export const MAX_SUGGESTED_RESPONSE_LENGTH = 240;

export function isSuggestedResponses(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SUGGESTED_RESPONSES &&
    value.every((text) => typeof text === 'string' && !!text.trim() && text.length <= MAX_SUGGESTED_RESPONSE_LENGTH) &&
    new Set(value).size === value.length
  );
}

export function stageSuggestedResponses(context: TurnContext, responses: string[]): void {
  if (!isSuggestedResponses(responses)) throw new Error('Invalid suggested responses');
  const db = getOutboundDb();
  db.transaction(() => {
    const turn = db.prepare('SELECT phase FROM turns WHERE id=?').get(context.turnId) as { phase: string } | undefined;
    if (turn?.phase !== 'running') throw new Error('Suggested responses require a running turn');
    db.prepare(
      `INSERT INTO session_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).run(`runner:suggested-responses:${context.turnId}`, JSON.stringify(responses), Date.now());
  })();
}

export function finalizeSuggestedResponses(context: TurnContext & { routing: RoutingContext }, attach: boolean): void {
  const db = getOutboundDb();
  const key = `runner:suggested-responses:${context.turnId}`;
  const staged = db.prepare('SELECT value FROM session_state WHERE key=?').get(key) as { value: string } | undefined;
  if (!staged) return;
  const responses: unknown = JSON.parse(staged.value);
  if (!isSuggestedResponses(responses)) throw new Error('Invalid staged suggested responses');
  const output = attach
    ? (db
        .prepare(
          `SELECT id FROM messages_out
    WHERE turn_id=? AND kind IN ('chat','text')
      AND channel_type IS ? AND platform_id IS ? AND thread_id IS ?
      AND json_extract(content,'$.delivery_origin')='response'
      AND COALESCE(json_extract(content,'$.system_generated'),0)=0
      AND length(trim(json_extract(content,'$.text')))>0
    ORDER BY seq DESC LIMIT 1`,
        )
        .get(context.turnId, context.routing.channelType, context.routing.platformId, context.routing.threadId) as
        | { id: string }
        | undefined)
    : undefined;
  if (output) {
    db.prepare(
      `INSERT INTO session_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).run(`response-suggestions:${output.id}`, staged.value, Date.now());
  } else {
    console.error(`[suggested-responses] Discarded suggestions for ${context.turnId}: no successful final reply`);
  }
  db.prepare('DELETE FROM session_state WHERE key=?').run(key);
}
