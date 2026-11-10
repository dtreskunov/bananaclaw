import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  DATA_DIR: path.resolve('.test-session-candidates'),
}));
vi.mock('./container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(false),
  recoverStoppedSession: vi.fn().mockResolvedValue(false),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { createSession, deleteSession } from './db/sessions.js';
import { insertTask, pauseTask, resumeTask, updateTask } from './modules/scheduling/db.js';
import { recordSessionDatabaseChange } from './db/transaction.js';
import { onHostChange, publishHostChange } from './host-changes.js';
import { SessionCandidates } from './session-candidates.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { setDeliveryAdapter, startSweepDeliveryPoll, stopDeliveryPolls } from './delivery.js';
import { isContainerRunning, recoverStoppedSession, wakeContainer } from './container-runner.js';
import * as manager from './session-manager.js';
import { log } from './log.js';

const ROOT = path.resolve('.test-session-candidates');
const GROUP = 'candidate-group';
const START = Date.parse('2026-11-10T18:00:00Z');
const PERIOD = 60_000;
let deliver = vi.fn();

function seed(id: string): void {
  createSession({
    id,
    agent_group_id: GROUP,
    messaging_group_id: 'candidate-chat',
    thread_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: START,
  });
  manager.initSessionFolder(GROUP, id);
}

function task(sessionId: string, processAfter: number): void {
  const db = manager.openInboundDb(GROUP, sessionId);
  try {
    insertTask(db, {
      id: 'task',
      processAfter,
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"prompt":"scheduled work"}',
    });
  } finally {
    db.close();
  }
}

function output(sessionId: string, deliverAfter: number | null = null): void {
  const db = manager.openOutboundDbRw(GROUP, sessionId);
  try {
    db.prepare(
      `INSERT INTO messages_out(id,seq,timestamp,deliver_after,kind,platform_id,channel_type,content)
       VALUES(?,1,?,?,'chat','chat','telegram','{"text":"hello"}')`,
    ).run(`output-${sessionId}`, START, deliverAfter);
    recordSessionDatabaseChange(db);
  } finally {
    db.close();
  }
}

async function startPolls(): Promise<void> {
  await Promise.resolve();
  startHostSweep();
  startSweepDeliveryPoll();
  await waitForPolls();
}

async function waitForPolls(): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (vi.getTimerCount() === 2) return;
    await delay(1);
  }
  throw new Error(`Session polls did not finish their inspections (${vi.getTimerCount()} timers)`);
}

async function tick(count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    await vi.advanceTimersByTimeAsync(PERIOD);
    await waitForPolls();
  }
}

function stopPolls(): void {
  stopHostSweep();
  stopDeliveryPolls();
}

function watchConnections() {
  const input = vi.spyOn(manager, 'openInboundDb');
  const output = vi.spyOn(manager, 'openOutboundDb');
  const writable = vi.spyOn(manager, 'openOutboundDbRw');
  return {
    input,
    output,
    writable,
    expectNone() {
      expect(input).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(writable).not.toHaveBeenCalled();
    },
    clear() {
      input.mockClear();
      output.mockClear();
      writable.mockClear();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(false);
  vi.mocked(recoverStoppedSession).mockReset().mockResolvedValue(false);
  fs.mkdirSync(ROOT, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({ id: GROUP, name: 'Candidates', folder: GROUP, agent_provider: null, created_at: START });
  createMessagingGroup({
    id: 'candidate-chat',
    channel_type: 'telegram',
    platform_id: 'chat',
    name: 'Candidates',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: START,
  });
  deliver = vi.fn().mockResolvedValue('platform-output');
  setDeliveryAdapter({ deliver });
});

afterEach(async () => {
  stopPolls();
  await Promise.resolve();
  closeDb();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('candidate-filtered session polls', () => {
  it('does not reopen or invalidate quiet historical sessions over ten intervals', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `quiet-${i}`;
      seed(id);
      const input = manager.openInboundDb(GROUP, id);
      const output = manager.openOutboundDbRw(GROUP, id);
      try {
        input
          .prepare(
            "INSERT INTO messages_in(id,seq,kind,timestamp,status,content) VALUES('old',2,'chat',?,'completed','{}')",
          )
          .run(START);
        output.prepare("INSERT INTO processing_ack VALUES('old','completed',?)").run(START);
      } finally {
        input.close();
        output.close();
      }
    }
    await startPolls();
    const connections = watchConnections();
    const listener = vi.fn();
    const off = onHostChange(listener);
    try {
      await tick(10);
      connections.expectNone();
      expect(listener).not.toHaveBeenCalled();
      expect(wakeContainer).not.toHaveBeenCalled();
      expect(recoverStoppedSession).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('keeps future input and output cached until their existing periodic deadline', async () => {
    seed('future');
    task('future', START + PERIOD * 3);
    output('future', START + PERIOD * 3);
    await startPolls();
    const connections = watchConnections();

    await tick(2);
    connections.expectNone();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();

    await tick();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('invalidates only the changed idle session, not the rest of its group', async () => {
    seed('changed');
    seed('quiet');
    await startPolls();
    const connections = watchConnections();
    manager.writeSessionMessage(GROUP, 'changed', {
      id: 'new',
      kind: 'chat',
      timestamp: Date.now(),
      content: '{"text":"new work"}',
    });
    await Promise.resolve();
    connections.clear();

    await tick();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(connections.input.mock.calls.every(([, id]) => id === 'changed')).toBe(true);
    expect(connections.output.mock.calls.every(([, id]) => id === 'changed')).toBe(true);
    expect(connections.writable).not.toHaveBeenCalled();
  });

  it('updates eligibility after edits, pause/resume, and deletion', async () => {
    seed('task-session');
    task('task-session', START + PERIOD * 10);
    await startPolls();
    const input = manager.openInboundDb(GROUP, 'task-session');
    try {
      updateTask(input, 'task', { processAfter: START + PERIOD * 2 });
      await tick();
      expect(wakeContainer).not.toHaveBeenCalled();
      pauseTask(input, 'task');
      await tick(2);
      expect(wakeContainer).not.toHaveBeenCalled();
      resumeTask(input, 'task');
      await tick();
      expect(wakeContainer).toHaveBeenCalledTimes(1);
    } finally {
      input.close();
    }
    deleteSession('task-session');
    await Promise.resolve();
    const connections = watchConnections();
    await tick(2);
    connections.expectNone();
  });

  it('reconstructs overdue work after restart without another input', async () => {
    seed('restart');
    task('restart', START + PERIOD * 2);
    output('restart', START + PERIOD * 2);
    await startPolls();
    stopPolls();
    vi.setSystemTime(START + PERIOD * 4);
    await startPolls();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('retains the next occurrence created by recurrence without polling it early', async () => {
    seed('recurring');
    task('recurring', START);
    const input = manager.openInboundDb(GROUP, 'recurring');
    try {
      input.exec("UPDATE messages_in SET status='completed',recurrence='*/5 * * * *' WHERE id='task'");
      await startPolls();
      expect(input.prepare("SELECT count(*) FROM messages_in WHERE status='pending'").pluck().get()).toBe(1);
      await tick();
      const connections = watchConnections();
      await tick(3);
      connections.expectNone();
      expect(wakeContainer).not.toHaveBeenCalled();
      await tick();
      expect(wakeContainer).toHaveBeenCalledTimes(1);
    } finally {
      input.close();
    }
  });

  it('retries failed inspections without repeatedly opening healthy sessions', async () => {
    seed('broken');
    seed('healthy');
    const original = manager.openInboundDb;
    const input = vi.spyOn(manager, 'openInboundDb').mockImplementation((group, id) => {
      if (id === 'broken') throw new Error('store unavailable');
      return original(group, id);
    });
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    await startPolls();
    input.mockClear();
    await tick();
    expect(input.mock.calls.map(([, id]) => id)).toEqual(['broken', 'broken']);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('retaining candidate for retry'),
      expect.objectContaining({ sessionId: 'broken' }),
    );
    input.mockImplementation(original);
    await tick();
    input.mockClear();
    await tick();
    expect(input).not.toHaveBeenCalled();
  });

  it('retains failed delivery and recovery work until it succeeds', async () => {
    seed('delivery');
    output('delivery');
    seed('recovery');
    const outbound = manager.openOutboundDbRw(GROUP, 'recovery');
    outbound.exec("INSERT INTO turns(id,phase,outcome,provenance) VALUES('turn','running','pending','native')");
    outbound.close();
    deliver.mockRejectedValueOnce(new Error('adapter unavailable'));
    vi.mocked(recoverStoppedSession).mockImplementation(async () => {
      if (vi.mocked(recoverStoppedSession).mock.calls.length === 1) return false;
      const db = manager.openOutboundDbRw(GROUP, 'recovery');
      try {
        db.exec("UPDATE turns SET phase='settled',outcome='interrupted'");
        recordSessionDatabaseChange(db);
      } finally {
        db.close();
      }
      return true;
    });
    await startPolls();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recoverStoppedSession).toHaveBeenCalledTimes(1);
    await tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(recoverStoppedSession).toHaveBeenCalledTimes(2);
    await tick();
    const connections = watchConnections();
    await tick();
    connections.expectNone();
  });

  it('keeps missing runner recovery storage visible and retryable', async () => {
    seed('missing-runner');
    const output = manager.openOutboundDbRw(GROUP, 'missing-runner');
    output.exec("INSERT INTO turns(id,phase,outcome,provenance) VALUES('turn','running','pending','native')");
    output.close();
    fs.unlinkSync(manager.runnerStateDbPath(GROUP, 'missing-runner'));
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});
    await startPolls();
    errors.mockClear();
    await tick(2);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(recoverStoppedSession).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(fs.existsSync(manager.runnerStateDbPath(GROUP, 'missing-runner'))).toBe(false);
  });

  it('continues liveness inspections for running sessions without input', async () => {
    seed('running');
    vi.mocked(isContainerRunning).mockReturnValue(true);
    await startPolls();
    const connections = watchConnections();
    await tick(2);
    expect(connections.input).toHaveBeenCalledTimes(2);
    expect(connections.output).toHaveBeenCalledTimes(2);
    expect(recoverStoppedSession).not.toHaveBeenCalled();
  });
});

describe('candidate invalidation', () => {
  it('handles access notices that supersede specific session notices in the shared bus', async () => {
    seed('session');
    await Promise.resolve();
    const candidates = new SessionCandidates();
    candidates.start();
    try {
      candidates.inspected('session', candidates.token('session'), null);
      publishHostChange({ kind: 'sessions', sessionId: 'session' });
      publishHostChange({ kind: 'access' });
      await Promise.resolve();
      expect([...candidates.due()].map((session) => session.id)).toEqual(['session']);
    } finally {
      candidates.stop();
    }
  });

  it('preserves a concurrent commit and evaluates cached eligibility against wall time', async () => {
    seed('session');
    await Promise.resolve();
    const candidates = new SessionCandidates();
    candidates.start();
    try {
      const old = candidates.token('session');
      publishHostChange({ kind: 'sessions', sessionId: 'session' });
      await Promise.resolve();
      candidates.inspected('session', old, null);
      expect([...candidates.due()].map((session) => session.id)).toEqual(['session']);
      candidates.inspected('session', candidates.token('session'), START + PERIOD);
      expect([...candidates.due()]).toEqual([]);
      vi.setSystemTime(START + PERIOD * 2);
      expect([...candidates.due()]).toHaveLength(1);
      vi.setSystemTime(START - PERIOD);
      expect([...candidates.due()]).toEqual([]);
    } finally {
      candidates.stop();
    }
  });

  it('does not let an inspection from a previous start clear a new candidate', async () => {
    seed('session');
    await Promise.resolve();
    const candidates = new SessionCandidates();
    candidates.start();
    try {
      const old = candidates.token('session');
      candidates.stop();
      candidates.start();
      candidates.inspected('session', old, null);
      expect([...candidates.due()].map((session) => session.id)).toEqual(['session']);
    } finally {
      candidates.stop();
    }
  });
});
