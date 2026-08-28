import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';

const DEFAULT_PATH = '/workspace/native-state.db';

interface StoredMessageRow {
  id: number;
  content_json: string;
}

export class NativeStore {
  private readonly db: Database;

  constructor(filename = process.env.NATIVE_STATE_PATH || DEFAULT_PATH) {
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
    `);
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

    const child = this.createConversation();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages (conversation_id, content_json, created_at)
       SELECT ?, content_json, ? FROM messages
       WHERE conversation_id = ? AND id <= ? ORDER BY id`,
      )
      .run(child, now, conversationId, anchor);
    return child;
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
