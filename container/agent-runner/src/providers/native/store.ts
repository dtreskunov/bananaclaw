import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';

const DEFAULT_PATH = '/workspace/native-state/native-state.db';

interface StoredMessageRow {
  id: number;
  content_json: string;
  finished?: number;
}

export interface NativeContextEntry {
  ref: string | null;
  coveredThrough?: string;
  message: ModelMessage;
  finished?: boolean;
}

interface CompactionRow {
  through_id: number;
  summary: string;
  retained_ids: string;
}

export class NativeStore {
  private readonly db: Database;
  private readonly directory: string;

  constructor(filename = process.env.NATIVE_STATE_PATH || DEFAULT_PATH) {
    this.directory = path.dirname(filename);
    this.db = new Database(filename, { create: true });
    this.db.exec('PRAGMA journal_mode = DELETE');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_native_messages_conversation
        ON messages(conversation_id, id);
      CREATE TABLE IF NOT EXISTS applied_steering (
        conversation_id TEXT NOT NULL,
        steering_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, steering_id)
      );
      CREATE TABLE IF NOT EXISTS context_compactions (
        conversation_id TEXT PRIMARY KEY,
        through_id INTEGER NOT NULL,
        summary TEXT NOT NULL,
        retained_ids TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS finished_turns (
        conversation_id TEXT NOT NULL,
        first_id INTEGER NOT NULL,
        last_id INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, first_id)
      );
      CREATE TABLE IF NOT EXISTS media_quarantines (
        conversation_id TEXT NOT NULL,
        provider_scope TEXT NOT NULL,
        media_key TEXT NOT NULL,
        confirmed_ref INTEGER NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (conversation_id, provider_scope, media_key)
      );
      CREATE TABLE IF NOT EXISTS tool_results (
        id TEXT PRIMARY KEY,
        content_json TEXT NOT NULL
      );
    `);
    try {
      for (const row of this.db.query<{ id: string; content_json: string }, []>(
        'SELECT id, content_json FROM tool_results',
      ).iterate()) this.materializeResult(row.id, row.content_json);
    } catch (error) { this.db.close(); throw error; }
  }

  archiveResult(complete: string): string {
    const id = createHash('sha256').update(complete).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO tool_results (id,content_json) VALUES (?,?)').run(id, complete);
    return this.materializeResult(id, complete);
  }

  private materializeResult(id: string, complete: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid archived tool result ID');
    const directory = path.join(this.directory, 'tool-results');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `${id}.json`);
    fs.writeFileSync(filename, complete, { mode: 0o600 });
    return filename;
  }

  hasConversation(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id) != null;
  }

  createConversation(): string {
    const id = `native-${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
    return id;
  }

  messages(conversationId: string): ModelMessage[] {
    const rows = this.db
      .prepare('SELECT id, content_json FROM messages WHERE conversation_id = ? ORDER BY id')
      .all(conversationId) as StoredMessageRow[];
    return rows.map((row) => JSON.parse(row.content_json) as ModelMessage);
  }

  contextEntries(conversationId: string): NativeContextEntry[] {
    const compacted = this.db.prepare('SELECT * FROM context_compactions WHERE conversation_id = ?')
      .get(conversationId) as CompactionRow | undefined;
    const rows = this.db.prepare(`
      SELECT id, content_json, EXISTS (
        SELECT 1 FROM finished_turns f WHERE f.conversation_id=messages.conversation_id
        AND messages.id BETWEEN f.first_id AND f.last_id
      ) AS finished FROM messages WHERE conversation_id = ?
      AND (id > ? OR id IN (SELECT value FROM json_each(?))) ORDER BY id
    `).all(conversationId, compacted?.through_id ?? 0, compacted?.retained_ids ?? '[]') as StoredMessageRow[];
    const entries: NativeContextEntry[] = rows.map((row) => ({
      ref: String(row.id), message: JSON.parse(row.content_json) as ModelMessage,
      ...(row.finished === 1 ? { finished: true } : {}),
    }));
    if (compacted) entries.unshift({
      ref: null,
      coveredThrough: String(compacted.through_id),
      message: {
        role: 'assistant',
        content: `[Compacted conversation and completed work. Preserve completed side effects; continue pending requests without repeating completed actions.]\n${compacted.summary}`,
      },
    });
    return entries;
  }

  contextMessages(conversationId: string): ModelMessage[] {
    return this.contextEntries(conversationId).map((entry) => entry.message);
  }

  finishTurn(conversation: string, first: string, last: string): void {
    const start = Number(first), end = Number(last);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
      throw new Error('Invalid finished-turn boundary');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND id IN (?,?)')
      .get(conversation, start, end) as { n: number };
    if (count.n !== (start === end ? 1 : 2)) throw new Error('Invalid finished-turn boundary');
    this.db.prepare('INSERT OR REPLACE INTO finished_turns (conversation_id,first_id,last_id) VALUES (?,?,?)')
      .run(conversation, start, end);
  }

  mediaQuarantines(conversationId: string, providerScope: string): Map<string, string> {
    const rows = this.db.prepare(
      'SELECT media_key, reason FROM media_quarantines WHERE conversation_id = ? AND provider_scope = ?',
    ).all(conversationId, providerScope) as Array<{ media_key: string; reason: string }>;
    return new Map(rows.map(row => [row.media_key, row.reason]));
  }

  quarantineMedia(conversationId: string, providerScope: string, mediaKey: string, confirmedRef: string, reason: string): void {
    if (!providerScope || !mediaKey || !reason.trim() || !Number.isSafeInteger(Number(confirmedRef)) ||
        !this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id = ?')
          .get(conversationId, Number(confirmedRef)))
      throw new Error('Invalid media quarantine checkpoint or identity');
    this.db.prepare(
      `INSERT OR IGNORE INTO media_quarantines
       (conversation_id, provider_scope, media_key, confirmed_ref, reason) VALUES (?, ?, ?, ?, ?)`,
    ).run(conversationId, providerScope, mediaKey, Number(confirmedRef), reason);
  }

  saveCompaction(conversationId: string, throughRef: string, retainedRefs: string[], summary: string): void {
    const through = Number(throughRef);
    if (!Number.isSafeInteger(through) || through < 1 || !summary.trim()) {
      throw new Error('Invalid native compaction');
    }
    this.db.transaction(() => {
      const belongs = this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id = ?');
      if (!belongs.get(conversationId, through)) throw new Error('Compaction boundary is outside the conversation');
      for (const ref of retainedRefs) {
        if (!Number.isSafeInteger(Number(ref)) || Number(ref) > through || !belongs.get(conversationId, Number(ref))) {
          throw new Error('Invalid retained compaction input');
        }
      }
      this.db.prepare(`
        INSERT INTO context_compactions (conversation_id, through_id, summary, retained_ids)
        VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
        through_id=excluded.through_id, summary=excluded.summary, retained_ids=excluded.retained_ids
      `).run(conversationId, through, summary, JSON.stringify(retainedRefs.map(Number)));
    })();
  }

  append(conversationId: string, messages: ModelMessage[]): string {
    if (messages.length === 0) return this.head(conversationId) ?? '0';
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT INTO messages (conversation_id, content_json, created_at) VALUES ($conversation_id, $content_json, $created_at)',
    );
    const commit = this.db.transaction((items: ModelMessage[]) => {
      let last = 0;
      for (const message of items) {
        const result = insert.run({
          $conversation_id: conversationId,
          $content_json: JSON.stringify(message),
          $created_at: now,
        });
        last = Number(result.lastInsertRowid);
      }
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
      return last;
    });
    return String(commit(messages));
  }

  fork(conversationId: string, anchorRef: string): string | null {
    const anchor = Number(anchorRef);
    if (!Number.isSafeInteger(anchor) || anchor < 1 || !this.hasConversation(conversationId)) return null;
    const belongs = this.db
      .prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id = ?')
      .get(conversationId, anchor);
    if (!belongs) return null;

    return this.db.transaction(() => {
      const child = this.createConversation();
      const rows = this.db.prepare(
        'SELECT id, content_json FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id',
      ).all(conversationId, anchor) as StoredMessageRow[];
      const refs = new Map<number, string>();
      for (const row of rows) {
        const copiedId = this.append(child, [JSON.parse(row.content_json) as ModelMessage]);
        refs.set(row.id, copiedId);
        this.db.prepare(
          `INSERT INTO applied_steering (conversation_id, steering_id, message_id)
           SELECT ?, steering_id, ? FROM applied_steering
           WHERE conversation_id = ? AND message_id = ?`,
        ).run(child, Number(copiedId), conversationId, row.id);
        this.db.prepare(
          `INSERT INTO media_quarantines (conversation_id, provider_scope, media_key, confirmed_ref, reason)
           SELECT ?, provider_scope, media_key, ?, reason FROM media_quarantines
           WHERE conversation_id = ? AND confirmed_ref = ?`,
        ).run(child, Number(copiedId), conversationId, row.id);
      }
      const finished = this.db.prepare('SELECT first_id,last_id FROM finished_turns WHERE conversation_id=? AND last_id<=?')
        .all(conversationId, anchor) as Array<{ first_id: number; last_id: number }>;
      for (const turn of finished) {
        const first = refs.get(turn.first_id), last = refs.get(turn.last_id);
        if (first === undefined || last === undefined) throw new Error('Missing finished-turn fork boundary');
        this.finishTurn(child, first, last);
      }
      return child;
    })();
  }

  appliedSteering(conversationId: string, ids: string[]): string[] {
    const lookup = this.db.prepare(
      'SELECT 1 FROM applied_steering WHERE conversation_id = ? AND steering_id = ?',
    );
    return ids.filter((id) => lookup.get(conversationId, id) != null);
  }

  appendSteering(conversationId: string, id: string, message: ModelMessage): string | null {
    return this.db.transaction(() => {
      if (this.appliedSteering(conversationId, [id]).length > 0) return null;
      const ref = this.append(conversationId, [message]);
      this.db.prepare(
        'INSERT INTO applied_steering (conversation_id, steering_id, message_id) VALUES (?, ?, ?)',
      ).run(conversationId, id, Number(ref));
      return ref;
    })();
  }

  replaceAfter(conversationId: string, anchorRef: string, messages: ModelMessage[]): string {
    return this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM context_compactions WHERE conversation_id = ?
        AND (through_id > ? OR EXISTS (SELECT 1 FROM json_each(retained_ids) WHERE value > ?))
      `).run(conversationId, Number(anchorRef), Number(anchorRef));
      this.db.prepare('DELETE FROM applied_steering WHERE conversation_id = ? AND message_id > ?')
        .run(conversationId, Number(anchorRef));
      this.db.prepare('DELETE FROM media_quarantines WHERE conversation_id = ? AND confirmed_ref > ?')
        .run(conversationId, Number(anchorRef));
      this.db.prepare('DELETE FROM finished_turns WHERE conversation_id = ? AND last_id > ?')
        .run(conversationId, Number(anchorRef));
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id > ?')
        .run(conversationId, Number(anchorRef));
      return this.append(conversationId, messages);
    })();
  }

  updateMessage(conversationId: string, id: string, message: ModelMessage): void {
    this.db.prepare('UPDATE messages SET content_json = ? WHERE conversation_id = ? AND id = ?')
      .run(JSON.stringify(message), conversationId, Number(id));
  }

  private head(conversationId: string): string | null {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversationId) as {
      id: number | null;
    };
    return row.id == null ? null : String(row.id);
  }

  close(): void {
    this.db.close();
  }
}
