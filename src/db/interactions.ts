import type { Interaction } from '../types.js';
import { getDb } from './connection.js';

import { recordHostChange, transaction } from './transaction.js';
import { interactionRoute, projectInteractionPublications } from '../conversation-publications.js';

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

export function legacyInteractionExpired(
  row: Pick<Interaction, 'status' | 'expires_at'>,
  now = new Date().toISOString(),
): boolean {
  return row.status === 'pending' && row.expires_at !== null && row.expires_at <= now;
}

export function mutateInteraction(id: string, write: () => boolean): boolean {
  const db = getDb();
  return transaction(db, () => {
    const previous = getInteraction(id);
    const changed = write();
    if (changed) {
      const current = getInteraction(id) ?? previous;
      if (current?.session_id) projectInteractionPublications(current.session_id);
      recordHostChange({ kind: 'interactions', sessionId: current?.session_id }, db);
    }
    return changed;
  })();
}

export function createInteraction(
  record: Pick<Interaction, 'id' | 'kind' | 'input' | 'created_at'> & Partial<Interaction>,
): boolean {
  const { input, response = null, ...columns } = record;
  const route = interactionRoute({ ...record, session_id: record.session_id ?? null });
  const values = {
    updated_at: record.created_at,
    ...columns,
    input_json: JSON.stringify(input),
    response_json: response === null ? null : JSON.stringify(response),
    ...(route ? { channel_type: route.channel_type, platform_id: route.platform_id, thread_id: route.thread_id || null,
      route_origin_id: record.origin_message_id ?? null } : {}),
  };
  const keys = Object.keys(values);
  return mutateInteraction(record.id, () => {
    const result = getDb()
      .prepare(
        `INSERT INTO interactions(${keys}) VALUES(${keys.map((key) => `@${key}`)})
    ON CONFLICT(id) DO NOTHING`,
      )
      .run(values);
    if (!result.changes && getInteraction(record.id)?.kind !== record.kind)
      throw new Error(`Global interaction ID collision: ${record.id}`);
    return result.changes > 0;
  });
}
