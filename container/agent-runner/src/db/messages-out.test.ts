import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensureRunnerStateSchema } from './runner-state.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(filePath)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

describe('writeMessageOut', () => {
  it('keeps the rollback journal beside the mounted runner database', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runner-journal-'));
    roots.push(root);
    const stateDir = path.join(root, 'runner-state');
    fs.mkdirSync(stateDir);
    const dbPath = path.join(stateDir, 'runner-state.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE state (value TEXT)');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO state VALUES (?)').run('pending');
      expect(fs.existsSync(`${dbPath}-journal`)).toBe(true);
      expect(path.dirname(`${dbPath}-journal`)).toBe(stateDir);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });

  it('rejects host-incompatible message collections before journaling', async () => {
    const { closeSessionDb, getOutboundDb, initTestSessionDb } = await import('./connection.js');
    const { writeMessageOut } = await import('./messages-out.js');
    initTestSessionDb();
    try {
      expect(() =>
        writeMessageOut({
          id: 'unsafe',
          kind: 'chat',
          content: JSON.stringify({ files: ['../secret.txt'] }),
        }),
      ).toThrow('invalid outbound files');
      expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM pending_runner_events').get()).toEqual({ count: 0 });
    } finally {
      closeSessionDb();
    }
  });

  it('serializes sequence allocation across independent runner-state connections', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-message-seq-'));
    roots.push(root);
    const runnerPath = path.join(root, 'runner-state.db');
    const readyPath = path.join(root, 'ready');
    const resultPath = path.join(root, 'result');

    const runner = new Database(runnerPath);
    runner.exec('PRAGMA journal_mode = DELETE');
    runner.exec('PRAGMA busy_timeout = 5000');
    ensureRunnerStateSchema(runner);

    runner.exec('BEGIN IMMEDIATE');
    runner
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content)
         VALUES ('main-writer', 1, datetime('now'), 'chat', '{}')`,
      )
      .run();

    const moduleUrl = pathToFileURL(path.join(import.meta.dir, 'messages-out.ts')).href;
    const childScript = `
      import { Database } from 'bun:sqlite';
      import fs from 'node:fs';
      import { writeMessageOutWithConnections } from ${JSON.stringify(moduleUrl)};
      const runner = new Database(${JSON.stringify(runnerPath)});
      runner.exec('PRAGMA busy_timeout = 5000');
      fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      const seq = writeMessageOutWithConnections(
        { id: 'sidecar-writer', kind: 'system', content: '{}' },
        runner,
        runner,
      );
      fs.writeFileSync(${JSON.stringify(resultPath)}, String(seq));
      runner.close();
    `;
    const child = Bun.spawn([process.execPath, '-e', childScript], { stdout: 'pipe', stderr: 'pipe' });

    try {
      await waitForFile(readyPath);
      await Bun.sleep(50);
      expect(fs.existsSync(resultPath)).toBe(false);

      runner.exec('COMMIT');
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, stderr).toBe(0);
      expect(fs.readFileSync(resultPath, 'utf8')).toBe('3');
      expect(runner.prepare('SELECT id, seq FROM messages_out ORDER BY seq').all()).toEqual([
        { id: 'main-writer', seq: 1 },
        { id: 'sidecar-writer', seq: 3 },
      ]);
    } finally {
      if (runner.inTransaction) runner.exec('ROLLBACK');
      child.kill();
      runner.close();
    }
  });
});
