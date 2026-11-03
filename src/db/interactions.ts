import type { Interaction } from '../types.js';
import { invalidateConversation } from '../conversation-events.js';
import { getDb } from './connection.js';

export function queryInteractions<T extends Interaction>(sql: string, ...params: unknown[]): T[] {
  return (
    getDb()
      .prepare(sql)
      .all(...params) as (Record<string, unknown> & { input_json: string; response_json: string | null })[]
  ).map(
    ({ input_json, response_json, ...record }) =>
      ({
        ...record,
        input: JSON.parse(input_json),
        response: response_json === null ? null : JSON.parse(response_json),
      }) as T,
  );
}

export function getInteraction(id: string): Interaction | undefined {
  return queryInteractions<Interaction>('SELECT * FROM interactions WHERE id=?', id)[0];
}

export function interactionChanged(id: string): void {
  const sessionId = getInteraction(id)?.session_id;
  if (sessionId) queueMicrotask(() => invalidateConversation(sessionId));
}

export function createInteraction(
  record: Pick<Interaction, 'id' | 'kind' | 'input' | 'created_at'> & Partial<Interaction>,
): boolean {
  const { input, response = null, ...columns } = record;
  const values = {
    updated_at: record.created_at,
    ...columns,
    input_json: JSON.stringify(input),
    response_json: response === null ? null : JSON.stringify(response),
  };
  const keys = Object.keys(values);
  const result = getDb()
    .prepare(
      `INSERT INTO interactions(${keys}) VALUES(${keys.map((key) => `@${key}`)})
    ON CONFLICT(id) DO NOTHING`,
    )
    .run(values);
  if (!result.changes && getInteraction(record.id)?.kind !== record.kind)
    throw new Error(`Global interaction ID collision: ${record.id}`);
  if (result.changes) interactionChanged(record.id);
  return result.changes > 0;
}
