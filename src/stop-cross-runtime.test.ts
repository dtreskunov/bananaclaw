import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: path.resolve('.test-xstop'),
}));
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
}));
vi.mock('./modules/typing/index.js', () => ({
  setTypingAdapter: vi.fn(),
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

import { closeDb, createAgentGroup, createMessagingGroup, getQuestion, initTestDb, runMigrations } from './db/index.js';
import { upsertSessionRouting } from './db/session-db.js';
import { setDeliveryAdapter, deliverSessionMessages } from './delivery.js';
import { handleInteractiveResponse } from './modules/interactive/index.js';
import { openInboundDb, outboundDbPath, resolveSession, writeSessionMessage } from './session-manager.js';
import {
  getSessionActiveTurn,
  notifySessionHostState,
  onSessionSignal,
  requestSessionTurnStop,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopAllSessionSignalServers,
} from './session-link.js';
import type { Session } from './types.js';

let child: ChildProcessWithoutNullStreams | undefined;
let session: Session | undefined;
let outDb: Database.Database | undefined;
let resumeAcks: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;

afterEach(async () => {
  resumeAcks?.();
  unsubscribe?.();
  vi.restoreAllMocks();
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  await stopAllSessionSignalServers();
  if (session) await deliverSessionMessages(session);
  outDb?.close();
  closeDb();
  fs.rmSync(path.resolve('.test-xstop'), { recursive: true, force: true });
});

it.skipIf(spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0)(
  'stops only the active turn across Node/Bun while preserving questions and queued follow-ups',
  async () => {
    runMigrations(initTestDb());
    const now = new Date().toISOString();
    createAgentGroup({ id: 'agent', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now });
    createMessagingGroup({
      id: 'web-mg',
      channel_type: 'web',
      platform_id: 'group:agent',
      name: 'Web',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    session = resolveSession('agent', 'web-mg', 'thread-1', 'per-thread').session;
    const inbound = openInboundDb('agent', session.id);
    upsertSessionRouting(inbound, { channel_type: 'web', platform_id: 'group:agent', thread_id: 'thread-1' });
    inbound.close();
    const writeInput = (id: string, text: string) =>
      writeSessionMessage('agent', session!.id, {
        id,
        kind: 'chat',
        timestamp: now,
        channelType: 'web',
        platformId: 'group:agent',
        threadId: 'thread-1',
        content: JSON.stringify({ text }),
      });
    writeInput('first-input', 'initial request');
    setDeliveryAdapter({
      async deliver() {
        return 'receipt';
      },
    });
    await startSessionSignalServer(session.id, 'agent');
    outDb = new Database(outboundDbPath('agent', session.id), { readonly: true });

    const events: Array<Record<string, unknown>> = [];
    let stderr = '';
    let stdout = '';
    child = spawn('bun', ['src/test-fixtures/stop-runner.mjs', sessionLinkSocketPath(session.id)], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      let newline: number;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line.startsWith('FIXTURE ')) events.push(JSON.parse(line.slice(8)));
      }
    });
    const wait = async (check: () => void) => {
      try {
        await vi.waitFor(check, { timeout: 10_000, interval: 20 });
      } catch (error) {
        throw new Error(`${String(error)}\nRunner stderr:\n${stderr}\nEvents:${JSON.stringify(events)}`, {
          cause: error,
        });
      }
    };
    await wait(() => expect(getSessionActiveTurn(session!.id).turn?.status).toBe('running'));
    const turnId = getSessionActiveTurn(session.id).turn!.id;
    await wait(() => expect(events.some((event) => event.kind === 'question')).toBe(true));
    let original: { id: string; seq: number; content: string } | undefined;
    await wait(() => {
      original = outDb!
        .prepare("SELECT id,seq,content FROM messages_out WHERE kind='chat-sdk'")
        .get() as typeof original;
      expect(original).toBeDefined();
    });
    const questionId = JSON.parse(original!.content).questionId as string;
    expect(JSON.parse(original!.content)).not.toHaveProperty('turn_id');
    expect(getQuestion(questionId)?.status).toBe('pending');
    writeInput('queued-input', 'queued follow-up');
    notifySessionHostState(session.id);
    await wait(() => {
      const queued = openInboundDb('agent', session!.id);
      try {
        expect(queued.prepare('SELECT COUNT(*) FROM pending_host_events').pluck().get()).toBe(0);
      } finally {
        queued.close();
      }
    });

    let holdAcks = true;
    const held: Array<() => void> = [];
    const originalWrite = net.Socket.prototype.write;
    vi.spyOn(net.Socket.prototype, 'write').mockImplementation(function (
      this: net.Socket,
      ...args: Parameters<net.Socket['write']>
    ) {
      if (
        holdAcks &&
        typeof args[0] === 'string' &&
        args[0].startsWith('{"v":3,"type":"ack"') &&
        outDb!.prepare("SELECT 1 FROM messages_out WHERE json_extract(content,'$.stopped')=1").get()
      ) {
        held.push(() => Reflect.apply(originalWrite, this, args));
        return true;
      }
      return Reflect.apply(originalWrite, this, args);
    });
    resumeAcks = () => {
      holdAcks = false;
      for (const send of held.splice(0)) send();
    };
    const nullObservations: Array<{ questionStatus: string | undefined; held: number }> = [];
    unsubscribe = onSessionSignal((id, kind) => {
      if (id === session!.id && kind === 'turn.state' && !getSessionActiveTurn(id).turn) {
        nullObservations.push({ questionStatus: getQuestion(questionId)?.status, held: held.length });
      }
    });
    expect(await requestSessionTurnStop(session.id, turnId)).toMatchObject({ accepted: true });
    await wait(() => expect(events.some((event) => event.kind === 'aborted')).toBe(true));
    expect(events.find((event) => event.kind === 'aborted')!.pending).toContain('queued-input');
    expect(outDb.prepare("SELECT 1 FROM messages_out WHERE json_extract(content,'$.stopped')=1").get()).toBeUndefined();
    child.stdin.write('settle\n');
    await wait(() => expect(held.length).toBeGreaterThan(0));
    // Exceed the retired two-second drain timeout: only a real ACK may release the turn.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(getSessionActiveTurn(session.id).turn?.status).toBe('stopping');
    expect(events.some((event) => event.kind === 'next')).toBe(false);
    expect(nullObservations).toEqual([]);
    expect(getQuestion(questionId)?.status).toBe('pending');
    expect(outDb.prepare('SELECT id,seq,content FROM messages_out WHERE id=?').get(original!.id)).toEqual(original);
    resumeAcks();
    await wait(() => expect(events.some((event) => event.kind === 'next')).toBe(true));
    expect(nullObservations).toContainEqual({ questionStatus: 'pending', held: 0 });
    expect(getQuestion(questionId)?.status).toBe('pending');
    const next = events.find((event) => event.kind === 'next')!;
    expect(next.prompt).toContain('queued follow-up');
    expect(next.prompt).not.toContain('initial request');
    await wait(() => expect(getSessionActiveTurn(session!.id).turn).toBeNull());
    await handleInteractiveResponse({
      questionId,
      value: 'Yes',
      userId: null,
      channelType: 'web',
      platformId: 'group:agent',
      threadId: 'thread-1',
    });
    notifySessionHostState(session.id);
    expect(getQuestion(questionId)?.status).toBe('answered');
    await wait(() => expect(events.some((event) => event.kind === 'answer')).toBe(true));
    await wait(() => expect(getSessionActiveTurn(session!.id).turn?.status).toBe('running'));
    expect(events.find((event) => event.kind === 'answer')!.prompt).toContain('Yes');
    const answerTurn = getSessionActiveTurn(session.id).turn!;
    expect(answerTurn.id).not.toBe(turnId);
    expect(await requestSessionTurnStop(session.id, answerTurn.id)).toMatchObject({ accepted: true });
    await wait(() => expect(events.some((event) => event.kind === 'done')).toBe(true));
    expect(getQuestion(questionId)?.status).toBe('answered');
    const done = events.find((event) => event.kind === 'done')!;
    expect(done.inputs).toEqual([
      { id: 'first-input' },
      { id: 'queued-input' },
      { id: `question-response:${questionId}` },
    ]);
    expect(done.processing).toEqual(expect.arrayContaining([{ message_id: 'first-input', status: 'completed' }]));
    const stopRow = outDb
      .prepare("SELECT id,seq,content FROM messages_out WHERE json_extract(content,'$.stopped')=1 ORDER BY seq LIMIT 1")
      .get() as { id: string; seq: number; content: string };
    expect(stopRow.seq).toBeGreaterThan(original!.seq);
    expect(JSON.parse(stopRow.content)).toMatchObject({ turn_id: turnId, stopped: true });
    expect(JSON.parse(stopRow.content)).not.toHaveProperty('cancelled_question_ids');
    const stats = JSON.parse(stopRow.content).stopped_stats;
    expect(stats.model).toBe('fixture-model');
    expect(stats.durationMs).toBeGreaterThan(0);
    expect(outDb.prepare('SELECT * FROM turn_usage WHERE message_out_id=?').get(stopRow.id)).toMatchObject({
      model: 'fixture-model', input_tokens: 11, output_tokens: 2, duration_ms: stats.durationMs,
    });
  },
  30_000,
);
