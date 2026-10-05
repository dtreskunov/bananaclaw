import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChildProcess, spawn } from 'child_process';

const { applyContainerConfig, getAgentGroup, materializeContainerJson, admission } = vi.hoisted(() => ({
  applyContainerConfig: vi.fn(),
  getAgentGroup: vi.fn(),
  materializeContainerJson: vi.fn(),
  admission: {
    memoryBudgetMb: vi.fn(),
    estimateAgentGroupMb: vi.fn(),
    snapshotRunning: vi.fn(),
    decideAdmission: vi.fn(),
  },
}));
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = applyContainerConfig;
  },
}));

vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  isRootlessPodman: () => false,
  stopContainer: vi.fn(),
  dumpContainerProcesses: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('./db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/agent-groups.js')>()),
  getAgentGroup,
}));
vi.mock('./container-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-config.js')>()),
  materializeContainerJson,
}));
vi.mock('./container-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-admission.js')>()),
  ...admission,
}));
vi.mock('./session-link.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-link.js')>()),
  startSessionSignalServer: vi.fn().mockResolvedValue(undefined),
  stopSessionSignalServer: vi.fn().mockResolvedValue(undefined),
  confirmSessionRunnerExit: vi.fn(),
}));
vi.mock('./session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-manager.js')>()),
  markContainerStopped: vi.fn(),
}));

import { buildContainerArgs, recoverStoppedSession, wakeContainer } from './container-runner.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

beforeEach(() => {
  admission.memoryBudgetMb.mockReturnValue(0);
  admission.estimateAgentGroupMb.mockReturnValue(40);
  admission.snapshotRunning.mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('runs recovery with only the provided mounts, no networking, and no gateway credentials', async () => {
  const group: AgentGroup = {
    id: 'recovery-group',
    name: 'Recovery',
    folder: 'recovery',
    agent_provider: null,
    created_at: '2026-10-04T20:22:46.000Z',
  };
  const config: ContainerConfig = {
    mcpServers: {},
    packages: { apt: [], npm: [], pip: [] },
    additionalMounts: [],
    skills: [],
    disabledSkills: [],
  };
  const args = await buildContainerArgs(
    [{ hostPath: '/runner-state', containerPath: '/workspace/runner-state', readonly: false }],
    'recovery-test',
    group,
    config,
    'native',
    {},
    'must-not-be-provisioned',
    'session-test',
    'recovery',
  );
  expect(args).toContain('--network=none');
  expect(args).toContain('nanoclaw-recovery=true');
  expect(args).toContain('nanoclaw-session=session-test');
  expect(args).toContain('/runner-state:/workspace/runner-state');
  expect(args.at(-1)).toBe('exec bun run /app/src/recover-main.ts');
  expect(args).not.toContain('-d');
  expect(applyContainerConfig).not.toHaveBeenCalled();
});

it('deduplicates recovery and does not start a provider wake after a failed recovery', async () => {
  const session: Session = {
    id: 'recovery-failed',
    agent_group_id: 'recovery-group',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-10-04T20:22:46.000Z',
  };
  getAgentGroup.mockReturnValue({
    id: session.agent_group_id,
    name: 'Recovery',
    folder: 'recovery',
    agent_provider: null,
    created_at: session.created_at,
  } satisfies AgentGroup);
  const child = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(child);
  const recovery = recoverStoppedSession(session);
  expect(recoverStoppedSession(session)).toBe(recovery);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  const wake = wakeContainer(session);
  expect(materializeContainerJson).not.toHaveBeenCalled();
  child.emit('close', 1);
  expect(await recovery).toBe(false);
  expect(await wake).toBe(false);
  expect(getAgentGroup).toHaveBeenCalledTimes(1);
  expect(materializeContainerJson).not.toHaveBeenCalled();
});

it('does not evict a recovery container to admit another agent', async () => {
  const session: Session = {
    id: 'recovery-busy',
    agent_group_id: 'recovery-group',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-10-04T20:22:46.000Z',
  };
  getAgentGroup.mockReturnValue({
    id: session.agent_group_id,
    name: 'Recovery',
    folder: 'recovery',
    agent_provider: null,
    created_at: session.created_at,
  } satisfies AgentGroup);
  const child = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(child);
  const recovery = recoverStoppedSession(session);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
  admission.memoryBudgetMb.mockReturnValue(80);
  admission.decideAdmission.mockReturnValue({ action: 'evict', sessionId: session.id });
  try {
    expect(await wakeContainer({ ...session, id: 'another-agent' })).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(materializeContainerJson).not.toHaveBeenCalled();
  } finally {
    child.emit('close', 1);
    await recovery;
  }
});
