import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
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
