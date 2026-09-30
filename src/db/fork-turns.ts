import type Database from 'better-sqlite3';

import { getTurn, linkTurnInput, putTurn, type TurnInputRow } from './turns.js';

type Row = Record<string, unknown>;

function rows(db: Database.Database, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
}

function insert(db: Database.Database, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(
    ...Object.values(row),
  );
}

/**
 * Copy only metadata justified by the selected transcript. Partial/active turns
 * become inert historical snapshots; unanchored totals require a complete,
 * settled source turn.
 */
export function copyForkTurnHistory(
  src: Database.Database,
  dst: Database.Database,
  options: {
    inputIds: Set<string>;
    outputRows: Row[];
    parentSessionId: string;
    channelType: string;
    platformId: string | null;
    threadId: string;
  },
): Set<string> {
  return src.transaction(() => {
    const outputIds = new Set(options.outputRows.map((r) => String(r.id)));
    const activity = rows(src, 'turn_activity');
    const usage = rows(src, 'turn_usage');
    const inputs = src.prepare('SELECT * FROM turn_inputs').all() as TurnInputRow[];
    const inputsByTurn = new Map<string, TurnInputRow[]>();
    const incomplete = new Set<string>();
    const candidates = new Set<string>();
    for (const row of options.outputRows) {
      if (typeof row.turn_id === 'string') candidates.add(row.turn_id);
    }
    for (const row of [...activity, ...usage]) {
      if (typeof row.turn_id === 'string' && outputIds.has(String(row.message_out_id))) candidates.add(row.turn_id);
      if (
        typeof row.turn_id === 'string' &&
        row.message_out_id !== null &&
        !outputIds.has(String(row.message_out_id))
      ) {
        incomplete.add(row.turn_id);
      }
    }
    for (const row of inputs) {
      const associated = inputsByTurn.get(row.turn_id) ?? [];
      associated.push(row);
      inputsByTurn.set(row.turn_id, associated);
      if (options.inputIds.has(row.message_in_id)) candidates.add(row.turn_id);
      else incomplete.add(row.turn_id);
    }
    const allOutputs = src.prepare('SELECT id, turn_id FROM messages_out').all() as Row[];
    for (const row of allOutputs) {
      if (typeof row.turn_id === 'string' && !outputIds.has(String(row.id))) incomplete.add(row.turn_id);
    }
    const copied = new Set<string>();
    const complete = new Set<string>();
    dst.transaction(() => {
      for (const id of candidates) {
        const turn = getTurn(src, id);
        if (!turn) continue;
        const turnInputs = inputsByTurn.get(id) ?? [];
        const entireTurn = turn.phase === 'settled' && !incomplete.has(id);
        if (entireTurn) complete.add(id);
        putTurn(dst, {
          ...turn,
          origin_channel_type: options.channelType,
          origin_platform_id: options.platformId,
          origin_thread_id: options.threadId,
          origin_source_session_id: null,
          phase: 'settled',
          outcome: entireTurn ? turn.outcome : 'unknown',
          started_at: entireTurn ? turn.started_at : null,
          ended_at: entireTurn ? turn.ended_at : null,
          provenance: 'fork',
          imported_from_session_id: options.parentSessionId,
          imported_from_turn_id: turn.id,
        });
        copied.add(id);
        for (const input of turnInputs) {
          if (options.inputIds.has(input.message_in_id)) linkTurnInput(dst, input);
        }
      }
      for (const [table, records] of [
        ['turn_activity', activity],
        ['turn_usage', usage],
      ] as const) {
        for (const row of records) {
          const includedOutput = row.message_out_id !== null && outputIds.has(String(row.message_out_id));
          const includedTurn =
            row.message_out_id === null && typeof row.turn_id === 'string' && complete.has(row.turn_id);
          if (!includedOutput && !includedTurn) continue;
          insert(dst, table, {
            ...row,
            turn_id: typeof row.turn_id === 'string' && copied.has(row.turn_id) ? row.turn_id : null,
          });
        }
      }
    })();
    return copied;
  })();
}
