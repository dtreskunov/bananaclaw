import { ChildProcess, spawn } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  restart: false,
  session: {
    id: 'deferred-session',
    agent_group_id: 'group',
    messaging_group_id: 'web',
    thread_id: 'thread',
    status: 'active',
    container_status: 'running',
    agent_provider: null,
    last_active: null,
    created_at: 'now',
  },
  admission: vi.fn(() => ({ action: 'reject', reason: 'test capacity' })),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('./db/sessions.js', () => ({ getSession: () => mocks.session }));
vi.mock('./session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-manager.js')>()),
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
  openInboundDb: () => ({ prepare: () => ({ get: () => (mocks.restart ? { present: 1 } : undefined) }), close() {} }),
}));
vi.mock('./session-link.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-link.js')>()),
  startSessionSignalServer: vi.fn().mockResolvedValue(undefined),
  stopSessionSignalServer: vi.fn().mockResolvedValue(undefined),
  confirmSessionRunnerExit: vi.fn(),
}));
vi.mock('./container-admission.js', () => ({
  memoryBudgetMb: () => 100,
  estimateAgentGroupMb: () => 10,
  snapshotRunning: () => [],
  decideAdmission: mocks.admission,
}));

import { adoptRunningContainers, isContainerRunning } from './container-runner.js';
import { stopSessionSignalServer } from './session-link.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.restart = false;
});

it.each([true, false])('only wakes a replacement when a durable restart instruction remains: %s', async (restart) => {
  mocks.restart = restart;
  const watcher = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(watcher);
  await adoptRunningContainers([{ name: 'deferred-test', sessionId: mocks.session.id }]);
  expect(isContainerRunning(mocks.session.id)).toBe(true);
  expect(mocks.admission).not.toHaveBeenCalled();
  watcher.emit('close', 0);
  await vi.waitFor(() => expect(stopSessionSignalServer).toHaveBeenCalled());
  if (restart) await vi.waitFor(() => expect(mocks.admission).toHaveBeenCalledTimes(1));
  else expect(mocks.admission).not.toHaveBeenCalled();
  expect(isContainerRunning(mocks.session.id)).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(1);
});
