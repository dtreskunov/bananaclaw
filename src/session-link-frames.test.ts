import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: path.resolve('.test-slf'),
}));

import { insertMessage } from './db/session-db.js';
import { log } from './log.js';
import {
  getSessionActiveTurn,
  getSessionSignalTurnEndedAt,
  getSessionSignalUsage,
  getSessionTurnSignals,
  notifySessionHostState,
  onSessionSignal,
  requestSessionTurnStop,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopAllSessionSignalServers,
  stopSessionSignalServer,
} from './session-link.js';
import { inboundDbPath, initSessionFolder } from './session-manager.js';

const SESSION_ID = 'session-f';
const AGENT_GROUP_ID = 'agent-f';
const TS = '1790000000000';
const LONG_TEXT = 'x'.repeat(2_001);
const LONG_ID = 'x'.repeat(257);

type Frame = Record<string, unknown>;

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sessionLinkSocketPath(SESSION_ID));
    socket.once('connect', () => {
      socket.resume();
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

function line(frame: unknown): string {
  return `${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`;
}

/** Sends `frame` then a heartbeat probe; the probe is only processed if `frame` was accepted. */
async function outcome(frame: unknown): Promise<'accepted' | 'rejected'> {
  const socket = await connect();
  let closed = false;
  socket.once('close', () => {
    closed = true;
  });
  let beats = 0;
  const unsubscribe = onSessionSignal((_id, kind) => {
    if (kind === 'heartbeat') beats++;
  });
  const needed = (frame as Frame | null)?.type === 'heartbeat' ? 2 : 1;
  try {
    socket.write(line(frame) + line({ v: 5, type: 'heartbeat' }));
    await waitFor(() => closed || beats >= needed);
    return closed ? 'rejected' : 'accepted';
  } finally {
    unsubscribe();
    socket.destroy();
  }
}

function activity(step: unknown, extra: Frame = {}): Frame {
  return { v: 5, type: 'activity', step, turnId: 'turn-1', ts: TS, ordinal: 0, timelinePosition: 100, ...extra };
}

const USAGE = {
  cost_usd: 0.25,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  model: 'test/model',
};

function usage(value: unknown, extra: Frame = {}): Frame {
  return { v: 5, type: 'usage', usage: value, turnId: 'turn-1', ts: TS, ...extra };
}

const TURN = { id: 'turn-1', status: 'running', channelType: 'web', platformId: 'group:agent-f', threadId: null };

function turnState(turn: unknown, extra: Frame = {}): Frame {
  return { v: 5, type: 'turn.state', turn, ...extra };
}

const TOOL = { kind: 'tool', id: 'step-1', tool: 'Bash', status: 'running' };

function resetSessionFolder(): void {
  fs.rmSync(path.resolve('.test-slf'), { recursive: true, force: true });
  initSessionFolder(AGENT_GROUP_ID, SESSION_ID);
}

function queueHostMessage(): void {
  const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
  try {
    insertMessage(db, {
      id: 'in-1',
      kind: 'chat',
      timestamp: '2026-09-01 00:00:00',
      channelType: 'web',
      platformId: 'chat-1',
      threadId: null,
      content: '{"text":"hello"}',
      processAfter: null,
      recurrence: null,
    });
  } finally {
    db.close();
  }
  notifySessionHostState(SESSION_ID);
}

// Session DB creation dominates per-test cost; matrix cases never touch the DBs, so they share one folder.
beforeAll(resetSessionFolder);

beforeEach(async () => {
  await startSessionSignalServer(SESSION_ID, AGENT_GROUP_ID);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopAllSessionSignalServers();
  await stopSessionSignalServer(SESSION_ID, true);
});

afterAll(() => {
  fs.rmSync(path.resolve('.test-slf'), { recursive: true, force: true });
});

describe('session link frame acceptance', () => {
  const accepted: Array<[string, unknown]> = [
    ['heartbeat', { v: 5, type: 'heartbeat' }],
    ['activity.clear', { v: 5, type: 'activity.clear' }],
    ['usage.clear', { v: 5, type: 'usage.clear' }],
    ['turn.resume', { v: 5, type: 'turn.resume' }],
    ['turn.end', { v: 5, type: 'turn.end' }],
    ['turn.state null', turnState(null)],
    ['turn.state running', turnState(TURN)],
    ['turn.state stopping with thread', turnState({ ...TURN, status: 'stopping', threadId: 'thread-1' })],
    [
      'turn.state capabilities',
      turnState({ ...TURN, supportsSteering: true, supportsInputEditing: false, supportsInputCancellation: true }),
    ],
    ['activity null turn, zero ts', activity(TOOL, { turnId: null, ts: '0' })],
    ['activity 16-digit ts, large ordinal', activity(TOOL, { ts: '9'.repeat(16), ordinal: Number.MAX_SAFE_INTEGER })],
    ['tool minimal', activity(TOOL)],
    [
      'tool full',
      activity({
        ...TOOL,
        status: 'error',
        detail: 'd',
        description: 'Subject: <literal>\nSecond line',
        title: 't',
        error: 'e',
        durationMs: 1.5,
        rejectedBeforeExecution: false,
      }),
    ],
    ['tool empty optional strings', activity({ ...TOOL, detail: '', title: '', error: '' })],
    ['tool empty description', activity({ ...TOOL, description: '' })],
    ['tool 2000-char description', activity({ ...TOOL, description: 'x'.repeat(2_000) })],
    ['tool 256-char id and name', activity({ ...TOOL, id: 'i'.repeat(256), tool: 't'.repeat(256) })],
    ...(['pending', 'completed', 'interrupted', 'unknown'].map((status) => [
      `tool status ${status}`,
      activity({ ...TOOL, status }),
    ]) as Array<[string, unknown]>),
    ['internal', activity({ kind: 'internal', id: 's', text: 'x'.repeat(2_000) })],
    ['notification', activity({ kind: 'notification', id: 's', text: 'n' })],
    ['notification empty detail', activity({ kind: 'notification', id: 's', text: 'n', detail: '' })],
    ['notification multiline detail', activity({ kind: 'notification', id: 's', text: 'n', detail: ' \n<b>cool</b>\n ' })],
    ['notification 2000-char detail', activity({ kind: 'notification', id: 's', text: 'n', detail: 'x'.repeat(2_000) })],
    ['file minimal', activity({ kind: 'file', id: 's' })],
    ['file full', activity({ kind: 'file', id: 's', path: '', name: 'n', mime: 'text/plain' })],
    ['patch empty', activity({ kind: 'patch', id: 's', files: [] })],
    ['patch 100 files', activity({ kind: 'patch', id: 's', files: Array.from({ length: 100 }, () => 'f') })],
    ['retry', activity({ kind: 'retry', id: 's', attempt: 0 })],
    ['retry with error', activity({ kind: 'retry', id: 's', attempt: 3, error: '' })],
    ['compaction', activity({ kind: 'compaction', id: 's' })],
    ['compaction auto', activity({ kind: 'compaction', id: 's', auto: true })],
    ['subtask minimal', activity({ kind: 'subtask', id: 's' })],
    ['subtask full', activity({ kind: 'subtask', id: 's', agent: 'a', description: '' })],
    ['usage minimal', usage(USAGE)],
    ['usage null turn', usage(USAGE, { turnId: null })],
    [
      'usage full',
      usage({
        ...USAGE,
        cost_usd: 1_000_000,
        reasoning_tokens: 1,
        num_turns: 2,
        duration_ms: 3,
        duration_api_ms: 4,
        context_window: 5,
        max_output_tokens: 6,
        context_tokens: Number.MAX_SAFE_INTEGER,
      }),
    ],
  ];

  it.each(accepted)('accepts %s', async (_name, frame) => {
    expect(await outcome(frame)).toBe('accepted');
  });

  const rejected: Array<[string, unknown]> = [
    ['non-JSON', 'not json'],
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"heartbeat"'],
    ['number', '42'],
    ['missing v', { type: 'heartbeat' }],
    ['v 3', { v: 3, type: 'heartbeat' }],
    ['v 4', { v: 4, type: 'heartbeat' }],
    ['v string', { v: '4', type: 'heartbeat' }],
    ['missing type', { v: 5 }],
    ['numeric type', { v: 5, type: 42 }],
    ['unknown type', { v: 5, type: 'bogus' }],
    ['prototype type toString', { v: 5, type: 'toString' }],
    ['prototype type constructor', { v: 5, type: 'constructor' }],
    ['prototype type __proto__', { v: 5, type: '__proto__' }],
    ['prototype type hasOwnProperty', { v: 5, type: 'hasOwnProperty' }],
    ...(['heartbeat', 'activity.clear', 'usage.clear', 'turn.resume', 'turn.end'].map((type) => [
      `${type} extra key`,
      { v: 5, type, extra: 1 },
    ]) as Array<[string, unknown]>),
    ['host.ack without in-flight event', { v: 5, type: 'host.ack', eventId: 'e' }],
    ['host.nack without in-flight event', { v: 5, type: 'host.nack', eventId: 'e', fatal: true, error: 'x' }],
    ['durable missing event', { v: 5, type: 'durable', eventId: 'e', sequence: 1 }],
    ['durable array event', { v: 5, type: 'durable', eventId: 'e', sequence: 1, event: [] }],
    ['durable null event', { v: 5, type: 'durable', eventId: 'e', sequence: 1, event: null }],
    [
      'durable event extra key',
      { v: 5, type: 'durable', eventId: 'e', sequence: 1, event: { type: 'x', payload: {}, extra: 1 } },
    ],
    [
      'durable event type number',
      { v: 5, type: 'durable', eventId: 'e', sequence: 1, event: { type: 1, payload: {} } },
    ],
    [
      'durable fractional sequence',
      { v: 5, type: 'durable', eventId: 'e', sequence: 1.5, event: { type: 'x', payload: {} } },
    ],
    ['durable numeric eventId', { v: 5, type: 'durable', eventId: 1, sequence: 1, event: { type: 'x', payload: {} } }],
    [
      'durable extra key',
      { v: 5, type: 'durable', eventId: 'e', sequence: 1, event: { type: 'x', payload: {} }, extra: 1 },
    ],
    ['turn.state missing turn', { v: 5, type: 'turn.state' }],
    ['turn.state extra key', turnState(TURN, { extra: 1 })],
    ['turn.state array turn', turnState([])],
    ['turn.state string turn', turnState('turn-1')],
    ['turn.state extra turn key', turnState({ ...TURN, extra: 1 })],
    ['turn.state missing id', turnState({ ...TURN, id: undefined })],
    ['turn.state bad id', turnState({ ...TURN, id: 'bad id' })],
    ['turn.state empty id', turnState({ ...TURN, id: '' })],
    ['turn.state 129-char id', turnState({ ...TURN, id: 'x'.repeat(129) })],
    ['turn.state bad status', turnState({ ...TURN, status: 'done' })],
    ['turn.state missing status', turnState({ ...TURN, status: undefined })],
    ['turn.state empty channelType', turnState({ ...TURN, channelType: '' })],
    ['turn.state control char channelType', turnState({ ...TURN, channelType: 'web\n' })],
    ['turn.state DEL platformId', turnState({ ...TURN, platformId: 'a\u007f' })],
    ['turn.state 1025-char platformId', turnState({ ...TURN, platformId: 'p'.repeat(1_025) })],
    ['turn.state numeric platformId', turnState({ ...TURN, platformId: 1 })],
    ['turn.state missing threadId', turnState({ ...TURN, threadId: undefined })],
    ['turn.state empty threadId', turnState({ ...TURN, threadId: '' })],
    ['turn.state string supportsSteering', turnState({ ...TURN, supportsSteering: 'yes' })],
    ['turn.state numeric supportsInputEditing', turnState({ ...TURN, supportsInputEditing: 1 })],
    ['turn.state null supportsInputCancellation', turnState({ ...TURN, supportsInputCancellation: null })],
    ['activity extra key', activity(TOOL, { extra: 1 })],
    ['activity missing ordinal', activity(TOOL, { ordinal: undefined })],
    ['activity missing position', activity(TOOL, { timelinePosition: undefined })],
    ['activity null position', activity(TOOL, { timelinePosition: null })],
    ['activity zero position', activity(TOOL, { timelinePosition: 0 })],
    ['activity negative position', activity(TOOL, { timelinePosition: -1 })],
    ['activity fractional position', activity(TOOL, { timelinePosition: 1.5 })],
    ['activity unsafe position', activity(TOOL, { timelinePosition: Number.MAX_SAFE_INTEGER + 1 })],
    ['activity string position', activity(TOOL, { timelinePosition: '100' })],
    ['activity negative ordinal', activity(TOOL, { ordinal: -1 })],
    ['activity fractional ordinal', activity(TOOL, { ordinal: 1.5 })],
    ['activity string ordinal', activity(TOOL, { ordinal: '0' })],
    ['activity unsafe ordinal', activity(TOOL, { ordinal: Number.MAX_SAFE_INTEGER + 1 })],
    ['activity non-digit ts', activity(TOOL, { ts: 'abc' })],
    ['activity empty ts', activity(TOOL, { ts: '' })],
    ['activity 17-digit ts', activity(TOOL, { ts: '1'.repeat(17) })],
    ['activity numeric ts', activity(TOOL, { ts: 1 })],
    ['activity bad turnId', activity(TOOL, { turnId: 'bad id' })],
    ['activity missing turnId', activity(TOOL, { turnId: undefined })],
    ['activity null step', activity(null)],
    ['activity array step', activity([])],
    ['activity string step', activity('tool')],
    ['step missing kind', activity({ id: 's', text: 't' })],
    ['step numeric kind', activity({ kind: 1, id: 's' })],
    ['step unknown kind', activity({ kind: 'bogus', id: 's' })],
    ['step prototype kind toString', activity({ kind: 'toString', id: 's' })],
    ['step prototype kind constructor', activity({ kind: 'constructor', id: 's' })],
    ['step missing id', activity({ ...TOOL, id: undefined })],
    ['step empty id', activity({ ...TOOL, id: '' })],
    ['step 257-char id', activity({ ...TOOL, id: LONG_ID })],
    ['step numeric id', activity({ ...TOOL, id: 1 })],
    ['tool extra key', activity({ ...TOOL, extra: 1 })],
    ['tool missing tool', activity({ ...TOOL, tool: undefined })],
    ['tool empty tool', activity({ ...TOOL, tool: '' })],
    ['tool 257-char tool', activity({ ...TOOL, tool: LONG_ID })],
    ['tool bad status', activity({ ...TOOL, status: 'done' })],
    ['tool missing status', activity({ ...TOOL, status: undefined })],
    ['tool array status', activity({ ...TOOL, status: ['running'] })],
    ['tool numeric detail', activity({ ...TOOL, detail: 1 })],
    ['tool 2001-char detail', activity({ ...TOOL, detail: LONG_TEXT })],
    ['tool 2001-char description', activity({ ...TOOL, description: LONG_TEXT })],
    ['tool numeric description', activity({ ...TOOL, description: 1 })],
    ['tool null description', activity({ ...TOOL, description: null })],
    ['tool array description', activity({ ...TOOL, description: [] })],
    ['tool null title', activity({ ...TOOL, title: null })],
    ['tool object error', activity({ ...TOOL, error: {} })],
    ['tool negative durationMs', activity({ ...TOOL, durationMs: -1 })],
    ['tool string durationMs', activity({ ...TOOL, durationMs: '5' })],
    ['tool string rejectedBeforeExecution', activity({ ...TOOL, rejectedBeforeExecution: 'true' })],
    ...(['internal', 'notification'].flatMap((kind) => [
      [`${kind} missing text`, activity({ kind, id: 's' })],
      [`${kind} empty text`, activity({ kind, id: 's', text: '' })],
      [`${kind} 2001-char text`, activity({ kind, id: 's', text: LONG_TEXT })],
      [`${kind} extra key`, activity({ kind, id: 's', text: 't', extra: 'd' })],
    ]) as Array<[string, unknown]>),
    ['internal extra detail', activity({ kind: 'internal', id: 's', text: 't', detail: 'd' })],
    ['notification numeric detail', activity({ kind: 'notification', id: 's', text: 't', detail: 1 })],
    ['notification null detail', activity({ kind: 'notification', id: 's', text: 't', detail: null })],
    ['notification array detail', activity({ kind: 'notification', id: 's', text: 't', detail: [] })],
    ['notification 2001-char detail', activity({ kind: 'notification', id: 's', text: 't', detail: LONG_TEXT })],
    ['file numeric path', activity({ kind: 'file', id: 's', path: 1 })],
    ['file 2001-char name', activity({ kind: 'file', id: 's', name: LONG_TEXT })],
    ['file null mime', activity({ kind: 'file', id: 's', mime: null })],
    ['file extra key', activity({ kind: 'file', id: 's', size: 1 })],
    ['patch missing files', activity({ kind: 'patch', id: 's' })],
    ['patch object files', activity({ kind: 'patch', id: 's', files: {} })],
    ['patch 101 files', activity({ kind: 'patch', id: 's', files: Array.from({ length: 101 }, () => 'f') })],
    ['patch empty file name', activity({ kind: 'patch', id: 's', files: [''] })],
    ['patch numeric file', activity({ kind: 'patch', id: 's', files: [1] })],
    ['patch 2001-char file', activity({ kind: 'patch', id: 's', files: [LONG_TEXT] })],
    ['patch extra key', activity({ kind: 'patch', id: 's', files: [], extra: 1 })],
    ['retry missing attempt', activity({ kind: 'retry', id: 's' })],
    ['retry negative attempt', activity({ kind: 'retry', id: 's', attempt: -1 })],
    ['retry fractional attempt', activity({ kind: 'retry', id: 's', attempt: 1.5 })],
    ['retry string attempt', activity({ kind: 'retry', id: 's', attempt: '1' })],
    ['retry numeric error', activity({ kind: 'retry', id: 's', attempt: 1, error: 1 })],
    ['retry extra key', activity({ kind: 'retry', id: 's', attempt: 1, extra: 1 })],
    ['compaction string auto', activity({ kind: 'compaction', id: 's', auto: 'true' })],
    ['compaction extra key', activity({ kind: 'compaction', id: 's', extra: 1 })],
    ['subtask numeric agent', activity({ kind: 'subtask', id: 's', agent: 1 })],
    ['subtask 2001-char description', activity({ kind: 'subtask', id: 's', description: LONG_TEXT })],
    ['subtask extra key', activity({ kind: 'subtask', id: 's', extra: 1 })],
    ['usage frame extra key', usage(USAGE, { extra: 1 })],
    ['usage bad ts', usage(USAGE, { ts: 'x' })],
    ['usage bad turnId', usage(USAGE, { turnId: 'bad id' })],
    ['usage missing turnId', usage(USAGE, { turnId: undefined })],
    ['usage null value', usage(null)],
    ['usage extra key', usage({ ...USAGE, extra: 1 })],
    ['usage negative cost', usage({ ...USAGE, cost_usd: -1 })],
    ['usage huge cost', usage({ ...USAGE, cost_usd: 1_000_001 })],
    ['usage string cost', usage({ ...USAGE, cost_usd: '0' })],
    ['usage missing cost', usage({ ...USAGE, cost_usd: undefined })],
    ['usage missing input_tokens', usage({ ...USAGE, input_tokens: undefined })],
    ['usage fractional output_tokens', usage({ ...USAGE, output_tokens: 1.5 })],
    ['usage negative cache_read_tokens', usage({ ...USAGE, cache_read_tokens: -1 })],
    ['usage unsafe cache_write_tokens', usage({ ...USAGE, cache_write_tokens: Number.MAX_SAFE_INTEGER + 1 })],
    ['usage empty model', usage({ ...USAGE, model: '' })],
    ['usage 257-char model', usage({ ...USAGE, model: LONG_ID })],
    ['usage missing model', usage({ ...USAGE, model: undefined })],
    ['usage negative reasoning_tokens', usage({ ...USAGE, reasoning_tokens: -1 })],
    ['usage string context_tokens', usage({ ...USAGE, context_tokens: '5' })],
    ['usage null num_turns', usage({ ...USAGE, num_turns: null })],
  ];

  it.each(rejected)('rejects %s', async (_name, frame) => {
    expect(await outcome(frame)).toBe('rejected');
  });
});

describe('session link live state', () => {
  beforeEach(async () => {
    await stopSessionSignalServer(SESSION_ID, true);
    resetSessionFolder();
    await startSessionSignalServer(SESSION_ID, AGENT_GROUP_ID);
  });

  it('stores each activity kind with a canonical key order', async () => {
    const socket = await connect();
    const steps = [
      {
        rejectedBeforeExecution: true,
        durationMs: 12,
        error: 'e',
        title: 't',
        detail: 'd',
        status: 'error',
        tool: 'Bash',
        id: 'a',
        kind: 'tool',
      },
      { text: 'i', id: 'b', kind: 'internal' },
      { text: 'n', id: 'c', kind: 'notification' },
      { mime: 'm', name: 'n', path: 'p', id: 'd', kind: 'file' },
      { files: ['x', 'y'], id: 'e', kind: 'patch' },
      { error: 'boom', attempt: 2, id: 'f', kind: 'retry' },
      { auto: false, id: 'g', kind: 'compaction' },
      { description: 'desc', agent: 'ag', id: 'h', kind: 'subtask' },
    ];
    try {
      socket.write(steps.map((step, ordinal) => line(activity(step, { ordinal }))).join(''));
      await waitFor(() => getSessionTurnSignals(SESSION_ID).activity.length === steps.length);
      expect(getSessionTurnSignals(SESSION_ID).activity.map((entry) => entry.text)).toEqual([
        '{"kind":"tool","id":"a","tool":"Bash","status":"error","detail":"d","title":"t","error":"e","durationMs":12,"rejectedBeforeExecution":true}',
        '{"kind":"internal","id":"b","text":"i"}',
        '{"kind":"notification","id":"c","text":"n"}',
        '{"kind":"file","id":"d","path":"p","name":"n","mime":"m"}',
        '{"kind":"patch","id":"e","files":["x","y"]}',
        '{"kind":"retry","id":"f","attempt":2,"error":"boom"}',
        '{"kind":"compaction","id":"g","auto":false}',
        '{"kind":"subtask","id":"h","agent":"ag","description":"desc"}',
      ]);
    } finally {
      socket.destroy();
    }
  });

  it('replaces activity by turn and ordinal and keeps only the newest lines', async () => {
    const socket = await connect();
    try {
      const frames = Array.from({ length: 130 }, (_, ordinal) =>
        line(activity({ kind: 'internal', id: `s${ordinal}`, text: 'old' }, { ordinal })),
      );
      socket.write(frames.join(''));
      await waitFor(() => getSessionTurnSignals(SESSION_ID).activity.some((entry) => entry.ordinal === 129));
      let lines = getSessionTurnSignals(SESSION_ID).activity;
      expect(lines).toHaveLength(128);
      expect(lines[0].ordinal).toBe(2);

      socket.write(
        line(activity({ kind: 'internal', id: 'r', text: 'new' }, { ordinal: 50 })) +
          line(activity({ kind: 'internal', id: 'o', text: 'other' }, { ordinal: 50, turnId: 'turn-2' })),
      );
      await waitFor(() => getSessionTurnSignals(SESSION_ID).activity.some((entry) => entry.turnId === 'turn-2'));
      lines = getSessionTurnSignals(SESSION_ID).activity;
      expect(lines).toHaveLength(128);
      expect(lines.filter((entry) => entry.turnId === 'turn-1' && entry.ordinal === 50)).toEqual([
        { ts: TS, text: '{"kind":"internal","id":"r","text":"new"}', turnId: 'turn-1', ordinal: 50, timelinePosition: 100 },
      ]);
      expect(lines.at(-2)).toMatchObject({ turnId: 'turn-1', ordinal: 50 });
      expect(lines.at(-1)).toMatchObject({ turnId: 'turn-2', ordinal: 50 });
      expect(lines[0].ordinal).toBe(3);

      socket.write(line({ v: 5, type: 'activity.clear' }));
      await waitFor(() => getSessionTurnSignals(SESSION_ID).activity.length === 0);
    } finally {
      socket.destroy();
    }
  });

  it('records usage with its turn and clears it on usage.clear', async () => {
    const kinds: string[] = [];
    const unsubscribe = onSessionSignal((_id, kind) => kinds.push(kind));
    const socket = await connect();
    try {
      socket.write(
        line(
          usage({
            model: 'm',
            cache_write_tokens: 4,
            cache_read_tokens: 3,
            output_tokens: 2,
            input_tokens: 1,
            cost_usd: 0.5,
            context_tokens: 9,
          }),
        ),
      );
      await waitFor(() => getSessionSignalUsage(SESSION_ID) !== null);
      expect(JSON.stringify(getSessionTurnSignals(SESSION_ID).usage)).toBe(
        JSON.stringify({
          turnId: 'turn-1',
          ts: Number(TS),
          value: {
            cost_usd: 0.5,
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_write_tokens: 4,
            model: 'm',
            context_tokens: 9,
          },
        }),
      );
      socket.write(line({ v: 5, type: 'usage.clear' }));
      await waitFor(() => getSessionSignalUsage(SESSION_ID) === null);
      expect(getSessionTurnSignals(SESSION_ID).usage).toBeNull();
      expect(kinds.filter((kind) => kind === 'usage')).toHaveLength(2);
      expect(socket.destroyed).toBe(false);
    } finally {
      unsubscribe();
      socket.destroy();
    }
  });

  it('turn.resume reopens an ended turn without emitting a signal', async () => {
    const socket = await connect();
    try {
      socket.write(line({ v: 5, type: 'turn.end' }));
      await waitFor(() => getSessionSignalTurnEndedAt(SESSION_ID) > 0);
      const kinds: string[] = [];
      const unsubscribe = onSessionSignal((_id, kind) => kinds.push(kind));
      socket.write(line({ v: 5, type: 'turn.resume' }) + line({ v: 5, type: 'heartbeat' }));
      await waitFor(() => kinds.includes('heartbeat'));
      unsubscribe();
      expect(getSessionSignalTurnEndedAt(SESSION_ID)).toBe(0);
      expect(kinds).toEqual(['heartbeat']);
    } finally {
      socket.destroy();
    }
  });

  it('drops a pending stop when the runner reports a different turn', async () => {
    const socket = await connect();
    try {
      socket.write(line(turnState(TURN)));
      await waitFor(() => getSessionActiveTurn(SESSION_ID).connected);
      expect(await requestSessionTurnStop(SESSION_ID, 'turn-1')).toMatchObject({ accepted: true });
      socket.write(line(turnState({ ...TURN, id: 'turn-2', supportsSteering: true })));
      await waitFor(() => getSessionActiveTurn(SESSION_ID).turn?.id === 'turn-2');
      expect(getSessionActiveTurn(SESSION_ID).turn).toEqual({ ...TURN, id: 'turn-2', supportsSteering: true });
      socket.write(line(turnState({ ...TURN, id: 'turn-1' })));
      await waitFor(() => getSessionActiveTurn(SESSION_ID).turn?.id === 'turn-1');
      expect(getSessionActiveTurn(SESSION_ID).turn?.status).toBe('running');
    } finally {
      socket.destroy();
    }
  });

  it('closes the link and keeps the host event when the runner nacks it', async () => {
    const errorSpy = vi.spyOn(log, 'error');
    const socket = await connect();
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    let closed = false;
    socket.once('close', () => {
      closed = true;
    });
    queueHostMessage();
    await waitFor(() => received.includes('"host.event"'));
    const event = received
      .trim()
      .split('\n')
      .map((value) => JSON.parse(value) as Frame)
      .find((frame) => frame.type === 'host.event')!;

    socket.write(line({ v: 5, type: 'host.nack', eventId: event.eventId, fatal: true, error: 'no thanks' }));
    await waitFor(() => closed);
    expect(errorSpy).toHaveBeenCalledWith('Runner rejected host session event', {
      sessionId: SESSION_ID,
      sequence: event.sequence,
      error: 'no thanks',
    });
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT event_id FROM pending_host_events ORDER BY sequence').pluck().all()).toContain(
        event.eventId,
      );
    } finally {
      db.close();
    }
  });

  it.each([
    ['non-fatal', { fatal: false, error: 'x' }],
    ['numeric error', { fatal: true, error: 1 }],
    ['extra key', { fatal: true, error: 'x', extra: 1 }],
    ['mismatched eventId', { fatal: true, error: 'x', eventId: 'other' }],
  ])('rejects a malformed host.nack (%s) without logging it as a runner rejection', async (_name, fields) => {
    const errorSpy = vi.spyOn(log, 'error');
    const socket = await connect();
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    let closed = false;
    socket.once('close', () => {
      closed = true;
    });
    queueHostMessage();
    await waitFor(() => received.includes('"host.event"'));
    const event = JSON.parse(
      received
        .trim()
        .split('\n')
        .find((value) => value.includes('"host.event"'))!,
    ) as Frame;
    socket.write(line({ v: 5, type: 'host.nack', eventId: event.eventId, ...fields }));
    await waitFor(() => closed);
    expect(errorSpy).not.toHaveBeenCalledWith('Runner rejected host session event', expect.anything());
  });
});
