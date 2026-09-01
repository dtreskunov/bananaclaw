import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';
import { SESSION_LINK_VERSION } from './session-link.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  const allLive = () => true;
  const noneLive = () => false;

  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(noneLive);

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}\t{{.Label "nanoclaw-session"}}\t{{.Label "nanoclaw-session-link"}}'`,
      expect.any(Object),
    );
  });

  it('stops containers whose session is not live', () => {
    mockExecSync.mockReturnValueOnce(`nanoclaw-group1-111\tsess-1\t${SESSION_LINK_VERSION}\nnanoclaw-group2-222\tsess-2\t${SESSION_LINK_VERSION}\n`);
    mockExecSync.mockReturnValue('');

    const adopted = cleanupOrphans(noneLive);

    expect(adopted).toEqual([]);
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('adopts containers whose session is still live (does not stop them)', () => {
    mockExecSync.mockReturnValueOnce(`nanoclaw-group1-111\tsess-1\t${SESSION_LINK_VERSION}\nnanoclaw-group2-222\tsess-2\t${SESSION_LINK_VERSION}\n`);

    const adopted = cleanupOrphans(allLive);

    expect(adopted).toEqual([
      { name: 'nanoclaw-group1-111', sessionId: 'sess-1' },
      { name: 'nanoclaw-group2-222', sessionId: 'sess-2' },
    ]);
    // No stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('Adopted running containers from previous host run', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('mixes adoption and stop in a single pass', () => {
    mockExecSync.mockReturnValueOnce(`keep-name\tlive-sess\t${SESSION_LINK_VERSION}\nkill-name\tdead-sess\t${SESSION_LINK_VERSION}\n`);
    mockExecSync.mockReturnValue('');

    const adopted = cleanupOrphans((sid) => sid === 'live-sess');

    expect(adopted).toEqual([{ name: 'keep-name', sessionId: 'live-sess' }]);
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 kill-name`, {
      stdio: 'pipe',
    });
  });

  it('stops containers with no session label (treats as orphan)', () => {
    mockExecSync.mockReturnValueOnce('orphan-name\t\n');
    mockExecSync.mockReturnValue('');

    const adopted = cleanupOrphans(allLive);

    expect(adopted).toEqual([]);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 orphan-name`, {
      stdio: 'pipe',
    });
  });

  it('stops a live pre-session-link container instead of adopting it', () => {
    mockExecSync.mockReturnValueOnce('legacy-name\tlive-sess\t\n');
    mockExecSync.mockReturnValue('');

    expect(cleanupOrphans(allLive)).toEqual([]);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 legacy-name`, {
      stdio: 'pipe',
    });
  });

  it('does nothing when no containers exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(allLive);

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(allLive); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to reconcile orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce(`nanoclaw-a-1\tdead-1\t${SESSION_LINK_VERSION}\nnanoclaw-b-2\tdead-2\t${SESSION_LINK_VERSION}\n`);
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(noneLive); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 1,
      names: ['nanoclaw-b-2'],
    });
  });
});
