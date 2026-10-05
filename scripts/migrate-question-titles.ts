import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const expectedColumns = [
  'question_id',
  'session_id',
  'message_out_id',
  'in_reply_to',
  'platform_id',
  'channel_type',
  'thread_id',
  'question_text',
  'response_mode',
  'options_json',
  'status',
  'answer_value',
  'answer_type',
  'answered_by',
  'answered_at',
  'cancelled_at',
  'created_at',
];

function inspect(db: Database.Database): { hasTitle: boolean; count: number } {
  const names = (db.pragma('table_info(questions)') as { name: string }[]).map((column) => column.name);
  assert.deepEqual(
    names.filter((name) => name !== 'title'),
    expectedColumns,
    'Unexpected questions schema',
  );
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'questions'").get() as
    | { sql: string }
    | undefined;
  assert.ok(table, 'Missing questions table');
  assert.match(table.sql, /'skipped'/, 'Question skip upgrade is required first');
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const row = db.prepare('SELECT count(*) AS count FROM questions').get() as { count: number };
  return { hasTitle: names.includes('title'), count: row.count };
}

export async function migrateQuestionTitles(
  dbPath: string,
  { apply = false, hostStopped = false }: { apply?: boolean; hostStopped?: boolean } = {},
): Promise<{ hasTitle: boolean; count: number; changed: boolean; backup: string | null }> {
  const db = new Database(dbPath, { fileMustExist: true, readonly: !apply });
  try {
    const before = inspect(db);
    if (!apply || !before.hasTitle) return { ...before, changed: false, backup: null };
    assert.equal(hostStopped, true, 'Stop the host and pass --host-stopped before applying');
    const backup = `${path.resolve(dbPath)}.before-question-title-removal-${randomUUID()}.db`;
    fs.closeSync(fs.openSync(backup, 'wx', 0o600));
    await db.backup(backup);
    console.log(`Backup: ${backup}`);
    db.transaction(() => {
      const rows = (
        db.prepare('SELECT rowid, * FROM questions ORDER BY question_id').all() as Record<string, unknown>[]
      ).map(({ title: _title, ...row }) => row);
      const migrations = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
      const objects = db
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'questions' AND type != 'table' ORDER BY type, name",
        )
        .all();
      const otherSchema = db
        .prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name != 'questions' ORDER BY type, name")
        .all();
      db.exec('ALTER TABLE questions DROP COLUMN title');
      assert.deepEqual(db.prepare('SELECT rowid, * FROM questions ORDER BY question_id').all(), rows);
      assert.deepEqual(db.prepare('SELECT * FROM schema_version ORDER BY version').all(), migrations);
      assert.deepEqual(
        db
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'questions' AND type != 'table' ORDER BY type, name",
          )
          .all(),
        objects,
      );
      assert.deepEqual(
        db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name != 'questions' ORDER BY type, name").all(),
        otherSchema,
      );
      assert.deepEqual(inspect(db), { hasTitle: false, count: before.count });
    }).immediate();
    return { hasTitle: false, count: before.count, changed: true, backup };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , dbPath, ...flags] = process.argv;
  if (!dbPath || flags.some((flag) => !['--apply', '--host-stopped'].includes(flag))) {
    console.error('Usage: pnpm exec tsx scripts/migrate-question-titles.ts <db-path> [--apply --host-stopped]');
    process.exitCode = 2;
  } else {
    try {
      console.log(
        JSON.stringify(
          await migrateQuestionTitles(dbPath, {
            apply: flags.includes('--apply'),
            hostStopped: flags.includes('--host-stopped'),
          }),
        ),
      );
    } catch (error) {
      console.error('Question title migration failed:', error);
      process.exitCode = 1;
    }
  }
}
