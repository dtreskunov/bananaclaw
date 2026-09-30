import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getOutboundDb, initTestSessionDb, closeSessionDb } from './db/connection.js';
import { beginTurn } from './turn-execution.js';
import { getTurnContext, readTurnContext, withTurnContext } from './current-batch.js';
import { writeMessageOut, writeMessageOutWithConnections } from './db/messages-out.js';
import { invokeRegisteredTool, registerTools } from './mcp-tools/tool-registry.js';

afterEach(() => closeSessionDb());
const routing = { channelType: 'web', platformId: 'chat', threadId: null, inReplyTo: null };

it('captures a tool invocation before its await instead of stamping the successor', async () => {
  initTestSessionDb();
  const first = beginTurn(routing, []);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerTools([{
    tool: { name: 'late-context-test', description: 'test', inputSchema: { type: 'object' } },
    async handler() {
      await gate;
      writeMessageOut({ id: 'late', kind: 'chat', content: '{"text":"late"}' });
      return { content: [] };
    },
  }]);
  const pending = invokeRegisteredTool('late-context-test');
  const second = beginTurn(routing, []);
  release();
  await pending;
  expect(getTurnContext()?.turnId).toBe(second.turnId);
  expect(getOutboundDb().prepare("SELECT turn_id FROM messages_out WHERE id='late'").get()).toEqual({ turn_id: first.turnId });
});

it('reads the durable handoff through another SQLite connection with no local context', () => {
  initTestSessionDb();
  const first = beginTurn({ ...routing, inReplyTo: 'input-a' }, []);
  const root = path.resolve('.test-turn-context');
  fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'runner.db');
  const source = getOutboundDb();
  source.prepare('VACUUM INTO ?').run(filename);
  const sidecar = new Database(filename);
  try {
    const captured = readTurnContext(sidecar);
    expect(captured).toMatchObject({ turnId: first.turnId, inReplyTo: 'input-a' });
    beginTurn({ ...routing, inReplyTo: 'input-b' }, []);
    withTurnContext(captured, () => writeMessageOutWithConnections({
      id: 'sidecar', turn_id: getTurnContext()!.turnId, in_reply_to: getTurnContext()!.inReplyTo,
      kind: 'chat', content: '{"text":"sidecar"}',
    }, sidecar, sidecar));
    expect(sidecar.prepare("SELECT turn_id, in_reply_to FROM messages_out WHERE id='sidecar'").get())
      .toEqual({ turn_id: first.turnId, in_reply_to: 'input-a' });
  } finally {
    sidecar.close();
    fs.rmSync(root, { recursive: true });
  }
});

it('captures turn ownership in a separate Bun sidecar process before a successor is published', async () => {
  initTestSessionDb();
  const first = beginTurn({ ...routing, inReplyTo: 'sidecar-input' }, []);
  const root = path.resolve('.test-turn-sidecar');
  fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'runner.db');
  getOutboundDb().prepare('VACUUM INTO ?').run(filename);
  const contextUrl = pathToFileURL(path.join(import.meta.dir, 'current-batch.ts')).href;
  const writerUrl = pathToFileURL(path.join(import.meta.dir, 'db/messages-out.ts')).href;
  const script = `
    import { Database } from 'bun:sqlite';
    import fs from 'node:fs';
    import { readTurnContext, getTurnContext, withTurnContext } from ${JSON.stringify(contextUrl)};
    import { writeMessageOutWithConnections } from ${JSON.stringify(writerUrl)};
    const db = new Database(${JSON.stringify(filename)});
    const context = readTurnContext(db);
    fs.writeFileSync(${JSON.stringify(path.join(root, 'ready'))}, 'ready');
    await withTurnContext(context, async () => {
      while (!fs.existsSync(${JSON.stringify(path.join(root, 'release'))})) await Bun.sleep(5);
      writeMessageOutWithConnections({ id: 'external-output', kind: 'chat', content: '{"text":"late"}',
        turn_id: getTurnContext().turnId, in_reply_to: getTurnContext().inReplyTo }, db, db);
    });
    db.close();
  `;
  const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const parent = new Database(filename);
  try {
    for (let i = 0; i < 300 && !fs.existsSync(path.join(root, 'ready')); i++) await Bun.sleep(5);
    expect(fs.existsSync(path.join(root, 'ready'))).toBe(true);
    parent.prepare("UPDATE session_state SET value = ? WHERE key = 'runner:turn-context'")
      .run(JSON.stringify({ turnId: 'successor', inReplyTo: 'other-input', startedAt: first.startedAt }));
    fs.writeFileSync(path.join(root, 'release'), 'release');
    expect(await child.exited).toBe(0);
    expect(parent.prepare('SELECT turn_id, in_reply_to FROM messages_out').get())
      .toEqual({ turn_id: first.turnId, in_reply_to: 'sidecar-input' });
  } finally {
    child.kill();
    await child.exited;
    parent.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
