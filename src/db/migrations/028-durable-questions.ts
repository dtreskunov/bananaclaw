import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration028: Migration = {
  version: 28,
  name: 'durable-questions',
  up: (db: Database.Database) => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'questions'").get();
    if (exists) return;

    db.exec(`
      CREATE TABLE questions (
        question_id     TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        message_out_id  TEXT NOT NULL,
        in_reply_to     TEXT,
        platform_id     TEXT,
        channel_type    TEXT,
        thread_id       TEXT,
        title           TEXT NOT NULL,
        question_text   TEXT NOT NULL,
        response_mode   TEXT NOT NULL CHECK(response_mode IN ('choice', 'text', 'choice_or_text')),
        options_json    TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'cancelled')),
        answer_value    TEXT,
        answer_type     TEXT CHECK(answer_type IS NULL OR answer_type IN ('choice', 'text')),
        answered_by     TEXT,
        answered_at     TEXT,
        cancelled_at    TEXT,
        created_at      TEXT NOT NULL
      );
      INSERT INTO questions
        (question_id, session_id, message_out_id, platform_id, channel_type, thread_id,
         title, question_text, response_mode, options_json, status, created_at)
        SELECT question_id, session_id, message_out_id, platform_id, channel_type, thread_id,
               title, title, 'choice', options_json, 'pending', created_at
          FROM pending_questions;
      DROP TABLE pending_questions;
      CREATE INDEX idx_questions_session_status ON questions(session_id, status);
    `);
  },
};
