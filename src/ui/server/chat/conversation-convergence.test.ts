import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: path.resolve('.test-converge'),
}));

import { initTestDb, runMigrations, getDb, closeDb } from '../../../db/index.js';
import { backfillTurns, type TurnRow } from '../../../db/turns.js';
import { initSessionFolder, inboundDbPath, outboundDbPath } from '../../../session-manager.js';
import { applyDurableRunnerEvent, type DurableRunnerFrame } from '../../../session-link-durable.js';
import {
  confirmSessionRunnerExit,
  getSessionTurnSignals,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopSessionSignalServer,
} from '../../../session-link.js';
import { onConversationChange, invalidateConversation } from '../../../conversation-events.js';
import {
  parseConversationFrame,
  reduceConversation,
  type ConversationSnapshot,
} from '../../shared/conversation-protocol.js';
import { readConversation } from './conversation.js';
import { conversationSnapshot, startConversationStream } from './conversation-stream.js';

const root = path.resolve('.test-converge');
const group = 'convergence-group';
const session = 'convergence-session';
const user = 'web:member';
const route = { channelType: 'web', messagingGroupId: 'web-mg' };
const now = '2026-09-30T00:00:00.000Z';
let socket: net.Socket | undefined;
const stops: (() => void)[] = [];
let sequence = 0;
function turn(id: string, extra: Partial<TurnRow> = {}): TurnRow {
  return {
    id,
    phase: 'running',
    outcome: 'pending',
    provenance: 'native',
    origin_channel_type: 'web',
    origin_platform_id: `group:${group}`,
    origin_thread_id: 'thread',
    origin_source_session_id: null,
    started_at: now,
    ended_at: null,
    imported_from_session_id: null,
    imported_from_turn_id: null,
    ...extra,
  };
}
function apply(type: string, payload: object): DurableRunnerFrame {
  const frame = { sequence: ++sequence, eventId: `event-${sequence}`, event: { type, payload } };
  applyDurableRunnerEvent(group, session, frame);
  return frame;
}
function settle(id: string, extra: Partial<TurnRow>, usageId: string | null = null) {
  apply('state.upsert', {
    key: `turn-metadata:${id}`,
    updated_at: now,
    value: JSON.stringify({
      turnId: id,
      durationMs: 1000,
      model: usageId ? 'fixture' : null,
      usageId,
      status: usageId ? 'final' : 'unavailable',
      final: true,
    }),
  });
  return apply('turn.upsert', turn(id, { phase: 'settled', ended_at: now, ...extra }));
}
function output(id: string, turnId: string, seq: number, thread = 'thread') {
  return {
    id,
    turn_id: turnId,
    seq,
    in_reply_to: null,
    kind: 'chat',
    timestamp: now,
    deliver_after: null,
    recurrence: null,
    channel_type: 'web',
    platform_id: `group:${group}`,
    thread_id: thread,
    content: JSON.stringify({ text: id, delivery_origin: 'response' }),
  };
}
const read = (thread = 'thread') => readConversation(user, group, thread, route);
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 65));
async function connect(turnId: string) {
  await startSessionSignalServer(session, group);
  socket = net.createConnection(sessionLinkSocketPath(session));
  await new Promise<void>((resolve, reject) => {
    socket!.once('error', reject);
    socket!.once('connect', resolve);
  });
  socket.resume();
  socket.write(
    JSON.stringify({
      v: 4,
      type: 'turn.state',
      turn: {
        id: turnId,
        status: 'running',
        channelType: 'web',
        platformId: `group:${group}`,
        threadId: 'thread',
        supportsSteering: true,
        supportsInputEditing: true,
        supportsInputCancellation: true,
      },
    }) + '\n',
  );
  for (let i = 0; i < 100; i++) {
    if (getSessionTurnSignals(session).active.turn?.id === turnId) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Fixture signal was not received');
}
async function replay(frame: DurableRunnerFrame): Promise<void> {
  const connection = socket!;
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      connection.off('data', receive);
      reject(new Error('Fixture durable ACK not received'));
    }, 1000);
    const receive = (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const next = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (next.type === 'ack' && next.eventId === frame.eventId) {
          clearTimeout(timeout);
          connection.off('data', receive);
          resolve();
        }
      }
    };
    connection.on('data', receive);
    connection.write(JSON.stringify({ v: 4, type: 'durable', ...frame }) + '\n');
  });
}
function browser(thread = 'thread') {
  let state: ConversationSnapshot | null = null;
  let dropInvalidations = false;
  const errors: unknown[] = [];
  const frames: ConversationSnapshot[] = [];
  const stop = startConversationStream({
    read: () => read(thread),
    subscribe: (invalidate) =>
      onConversationChange(() => {
        if (!dropInvalidations) invalidate();
      }),
    send: (frame) => {
      state = reduceConversation(state, parseConversationFrame(json(frame)));
      frames.push(state);
    },
    fail: (error) => errors.push(error),
  });
  stops.push(stop);
  return {
    get state() {
      return state!;
    },
    errors,
    frames,
    stop,
    dropInvalidations: () => {
      dropInvalidations = true;
    },
    async converged() {
      await flush();
      expect(errors).toEqual([]);
      // A new authorized read at the same host state, not a handcrafted expected view.
      const fresh = reduceConversation(null, parseConversationFrame(json(conversationSnapshot(read(thread)))));
      expect(state!.conversation).toEqual(fresh.conversation);
      return state!;
    },
  };
}

beforeEach(() => {
  sequence = 0;
  runMigrations(initTestDb());
  const db = getDb();
  db.prepare("INSERT INTO users (id,kind,created_at) VALUES (?,'web',?)").run(user, now);
  db.prepare('INSERT INTO agent_groups(id,name,folder,created_at) VALUES (?,?,?,?)').run(group, group, group, now);
  db.prepare('INSERT INTO agent_group_members(user_id,agent_group_id,added_by,added_at) VALUES (?,?,?,?)').run(
    user,
    group,
    user,
    now,
  );
  db.prepare(
    `INSERT INTO messaging_groups(id,channel_type,platform_id,instance,is_group,created_at)
    VALUES ('web-mg','web',?,'web',1,?)`,
  ).run(`group:${group}`, now);
  db.prepare(
    `INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
    VALUES ('wire','web-mg',?,'agent-shared',?)`,
  ).run(group, now);
  db.prepare(
    `INSERT INTO sessions(id,agent_group_id,status,container_status,created_at)
    VALUES (?,?,'active','stopped',?)`,
  ).run(session, group, now);
  initSessionFolder(group, session);
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  socket?.destroy();
  socket = undefined;
  await stopSessionSignalServer(session, true);
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('host projector → ordered stream → browser reducer convergence', () => {
  it('converges migrated partial accounting without inventing missing numeric values', async () => {
    const input = new Database(inboundDbPath(group, session));
    input
      .prepare(
        `INSERT INTO messages_in (id,seq,kind,timestamp,content,channel_type,platform_id,thread_id)
      VALUES ('legacy-in',2,'chat',?,'{"text":"input"}','web',?,'thread')`,
      )
      .run(now, `group:${group}`);
    input.close();
    const db = new Database(outboundDbPath(group, session));
    db.prepare(
      `INSERT INTO messages_out(id,seq,in_reply_to,kind,timestamp,content,channel_type,platform_id,thread_id)
      VALUES ('legacy-out',1,'legacy-in','chat',?,'{"text":"old answer"}','web',?,'thread')`,
    ).run(now, `group:${group}`);
    db.prepare("INSERT INTO turn_usage(id,message_out_id,input_tokens) VALUES('partial-bill','legacy-out',17)").run();
    backfillTurns(db, [
      {
        id: 'legacy-in',
        channel_type: 'web',
        platform_id: `group:${group}`,
        thread_id: 'thread',
        source_session_id: null,
      },
    ]);
    db.close();
    const client = browser();
    await client.converged();
    expect(client.state.conversation.turns[0].usage).toEqual([{ id: 'partial-bill', value: { input_tokens: 17 } }]);
    expect(client.state.conversation.turns[0].metadata.status).toBe('partial');
  });
  it('settles a pending previous final under a successor, then replays after host restart without double billing', async () => {
    const client = browser();
    apply('turn.upsert', turn('previous'));
    await connect('previous');
    await client.converged();
    expect(client.state.conversation.capabilities.stop).toBe(true);
    apply('activity.persist', {
      turn_id: 'previous',
      message_out_id: null,
      ordinal: 0,
      ts: now,
      text: 'original activity',
    });
    apply('turn.upsert', turn('previous', { phase: 'settling' }));
    apply('message.upsert', output('final', 'previous', 1));
    apply('message.upsert', output('second-final', 'previous', 3));
    const bill = apply('usage.persist', {
      id: 'stable-accounting-id',
      message_out_id: 'final',
      turn_id: 'previous',
      timestamp: now,
      cost_usd: 0.25,
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'fixture',
      reasoning_tokens: null,
      num_turns: 1,
      duration_ms: 1000,
      duration_api_ms: null,
      context_window: null,
      max_output_tokens: null,
      context_tokens: null,
    });
    apply('turn.upsert', turn('successor'));
    socket!.write(
      JSON.stringify({
        v: 4,
        type: 'turn.state',
        turn: {
          id: 'successor',
          status: 'running',
          channelType: 'web',
          platformId: `group:${group}`,
          threadId: 'thread',
        },
      }) + '\n',
    );
    await client.converged();
    expect(client.state.conversation.messages).toEqual([]);
    expect(client.state.conversation.connection.activeTurnId).toBe('successor');
    const settled = settle('previous', { outcome: 'replied' }, 'stable-accounting-id');
    await client.converged();
    expect(client.state.conversation.messages.map((m) => m.id)).toEqual(['final', 'second-final']);
    expect(client.state.conversation.turns.find((t) => t.id === 'previous')?.usage).toHaveLength(1);
    const revision = client.state.revision;
    // Every apply reopens the host projection; restart also clears volatile link state.
    socket!.destroy();
    await stopSessionSignalServer(session, true);
    await connect('successor');
    await client.converged();
    expect(client.state.revision).toBeGreaterThanOrEqual(revision);
    const afterRestart = client.state.revision;
    await replay(bill);
    await replay(settled);
    await client.converged();
    expect(client.state.revision).toBe(afterRestart);
    const resumed = browser();
    await resumed.converged();
    expect(resumed.state.conversation).toEqual(client.state.conversation);
    const db = new Database(outboundDbPath(group, session), { readonly: true });
    try {
      expect(db.prepare('SELECT count(*) n, sum(cost_usd) cost FROM turn_usage').get()).toEqual({ n: 1, cost: 0.25 });
    } finally {
      db.close();
    }
  });

  it('never settles on disconnect/confirmed exit; missed notifications recover through an actual resnapshot', async () => {
    apply('turn.upsert', turn('interrupted'));
    await connect('interrupted');
    const client = browser();
    await client.converged();
    socket!.destroy();
    await flush();
    confirmSessionRunnerExit(session);
    await client.converged();
    expect(client.state.conversation.capabilities.stop).toBe(false);
    expect(client.state.conversation.turns[0].phase).toBe('running');
    client.dropInvalidations();
    settle('interrupted', { outcome: 'interrupted' });
    await flush();
    expect(client.state.conversation.turns[0].phase).toBe('running');
    client.stop();
    const repaired = browser();
    await repaired.converged();
    expect(repaired.state.conversation.turns[0]).toMatchObject({
      phase: 'settled',
      outcome: 'interrupted',
      usage: [],
      outputIds: [],
      metadata: { status: 'unavailable' },
    });
    apply('turn.upsert', turn('silent'));
    settle('silent', { outcome: 'silent' });
    await repaired.converged();
    expect(repaired.state.conversation.turns.find((t) => t.id === 'silent')).toMatchObject({
      phase: 'settled',
      outcome: 'silent',
      outputIds: [],
      usage: [],
      liveUsage: null,
    });
  });

  it('scopes sidecars by route and reauthorizes before every update or new snapshot', async () => {
    const client = browser();
    const other = browser('private');
    apply('turn.upsert', turn('private-turn', { origin_thread_id: 'private' }));
    apply('activity.persist', {
      turn_id: 'private-turn',
      message_out_id: null,
      ordinal: 0,
      ts: now,
      text: 'private trace',
    });
    apply('message.upsert', output('cross-route-send', 'private-turn', 1));
    settle('private-turn', { origin_thread_id: 'private', outcome: 'replied' });
    await client.converged();
    await other.converged();
    expect(client.state.conversation.turns).toEqual([]);
    expect(client.state.conversation.messages[0]).not.toHaveProperty('turnId');
    expect(other.state.conversation.turns[0].activity[0].text).toBe('private trace');
    const sent = client.frames.length;
    getDb().prepare('DELETE FROM agent_group_members WHERE user_id=? AND agent_group_id=?').run(user, group);
    invalidateConversation(session);
    await flush();
    expect(client.errors).toHaveLength(1);
    expect(client.frames).toHaveLength(sent);
    expect(() => read()).toThrow('not accessible');
    expect(browser().errors).toHaveLength(1);
  });
});
