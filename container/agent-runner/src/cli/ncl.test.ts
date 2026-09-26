import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureRunnerStateSchema } from '../db/runner-state.js';

it('stamps standalone ncl sidecar requests using the existing durable timeline clock', async () => {
  const root = path.join(process.cwd(), `.ncl-test-${randomUUID()}`);
  fs.mkdirSync(root);
  const dbPath = path.join(root, 'runner-state.db');
  const scriptPath = path.join(root, 'ncl.ts');
  const db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    ensureRunnerStateSchema(db);
    const floor = Date.now() * 1000 + 60_000_000;
    db.prepare('UPDATE timeline_clock SET position = ?').run(floor);
    const source = fs.readFileSync(path.join(import.meta.dir, 'ncl.ts'), 'utf8');
    const declaration = "const OUTBOUND_DB = '/workspace/runner-state/runner-state.db';";
    expect(source).toContain(declaration);
    // Exercise the copied, self-contained CLI rather than importing runner helpers.
    fs.writeFileSync(scriptPath, source.replace(declaration, `const OUTBOUND_DB = ${JSON.stringify(dbPath)};`));
    child = Bun.spawn([process.execPath, scriptPath, 'groups', 'list', '--json'], { stdout: 'pipe', stderr: 'pipe' });
    let row: { id: string; content: string } | null = null;
    for (let attempt = 0; attempt < 250 && !row; attempt++) {
      row = db.prepare('SELECT id, content FROM messages_out LIMIT 1').get() as typeof row;
      if (!row) await Bun.sleep(10);
    }
    expect(row).not.toBeNull();
    const request = JSON.parse(row!.content);
    expect(request).toEqual({
      action: 'cli_request', requestId: row!.id, command: 'groups-list', args: {}, timelinePosition: floor + 1,
    });
    expect(db.prepare('SELECT position FROM timeline_clock').get()).toEqual({ position: floor + 1 });
    const frame = { id: row!.id, ok: true, data: [{ id: 'group-1' }] };
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content)
       VALUES ('response', 2, 'system', datetime('now'), ?)`,
    ).run(JSON.stringify({ action: 'cli_response', requestId: row!.id, frame }));
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual(frame);
    expect(db.prepare("SELECT status FROM processing_ack WHERE message_id = 'response'").get())
      .toEqual({ status: 'completed' });
  } finally {
    child?.kill();
    if (child) await child.exited;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
