import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const oldConstraint = /answer_type\s+TEXT\s+CHECK\s*\(answer_type IS NULL OR answer_type IN\s*\('choice',\s*'text'\)\)/;
const newConstraint =
  /answer_type\s+TEXT\s+CHECK\s*\(answer_type IS NULL OR answer_type IN\s*\('choice',\s*'text',\s*'skipped'\)\)/;
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function migrateQuestionSkips(dbPath: string): Promise<{ changed: boolean; backup: string | null }> {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'questions'").get() as
      | { sql: string }
      | undefined;
    if (!table) throw new Error('Missing questions table');
    if (newConstraint.test(table.sql)) return { changed: false, backup: null };
    if (!oldConstraint.test(table.sql) || /WITHOUT\s+ROWID/i.test(table.sql))
      throw new Error('Unexpected questions schema; no changes made');
    const header = /^CREATE TABLE\s+(?:"questions"|questions)\s*\(/i;
    if (!header.test(table.sql)) throw new Error('Unexpected questions table declaration');
    const replacement = table.sql
      .replace(header, 'CREATE TABLE questions_new (')
      .replace(
        oldConstraint,
        "answer_type TEXT CHECK(answer_type IS NULL OR answer_type IN ('choice', 'text', 'skipped')) CHECK(answer_type != 'skipped' OR answer_value IS NULL)",
      );
    const columns = (db.pragma('table_info(questions)') as { name: string }[])
      .map(({ name }) => quote(name))
      .join(', ');
    const objects = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name = 'questions' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      )
      .all() as { sql: string }[];
    const digest = () =>
      createHash('sha256')
        .update(JSON.stringify(db.prepare('SELECT rowid, * FROM questions ORDER BY rowid').all()))
        .digest('hex');
    const original = digest();
    const violations = new Set((db.pragma('foreign_key_check') as object[]).map((row) => JSON.stringify(row)));
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed');

    const backup = `${dbPath}.before-question-skips-${randomUUID()}.db`;
    fs.closeSync(fs.openSync(backup, 'wx', 0o600));
    await db.backup(backup);
    console.log(`Backup: ${backup}`);
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(replacement);
        db.exec(`INSERT INTO questions_new (rowid, ${columns}) SELECT rowid, ${columns} FROM questions`);
        db.exec('DROP TABLE questions; ALTER TABLE questions_new RENAME TO questions');
        for (const object of objects) db.exec(object.sql);
        if (digest() !== original) throw new Error('Question data changed during migration');
        const introduced = (db.pragma('foreign_key_check') as object[]).filter(
          (row) => !violations.has(JSON.stringify(row)),
        );
        if (introduced.length) throw new Error('Migration introduced foreign-key violations');
        if (db.pragma('integrity_check', { simple: true }) !== 'ok')
          throw new Error('Migrated database integrity check failed');
      }).exclusive();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    return { changed: true, backup };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , dbPath, confirmation] = process.argv;
  if (!dbPath || confirmation !== '--host-stopped') {
    console.error(
      'Stop the host first. Usage: pnpm exec tsx scripts/migrate-question-skips.ts <db-path> --host-stopped',
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await migrateQuestionSkips(dbPath);
      console.log(
        result.changed ? 'Question skip migration verified.' : 'Question skips already supported; no changes.',
      );
    } catch (error) {
      console.error('Question skip migration failed:', error);
      process.exitCode = 1;
    }
  }
}
