import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  callbacks: [] as Array<(error: Error | null, stdout: string, stderr: string) => void>,
  updateConfig: vi.fn(),
  packages: { packages_apt: '[]', packages_npm: '["mcp-remote"]', packages_pip: '[]' },
}));
const TEST_DIR = path.resolve('.test-state/container-image-build');

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFile.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      mocks.callbacks.push(callback);
      return new actual.ChildProcess();
    }),
  };
});
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${process.cwd()}/.test-state/container-image-build`,
}));
vi.mock('./db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/agent-groups.js')>()),
  getAgentGroup: (id: string) => ({ id }),
}));
vi.mock('./db/container-configs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/container-configs.js')>()),
  getContainerConfig: () => ({ ...mocks.packages }),
  updateContainerConfigScalars: mocks.updateConfig,
}));

import { buildAgentGroupImage } from './container-runner.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callbacks.length = 0;
  mocks.packages.packages_npm = '["mcp-remote"]';
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('buildAgentGroupImage', () => {
  it('keeps the event loop responsive and publishes only a completed build', async () => {
    const pending = buildAgentGroupImage('build-group');
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));
    expect(mocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      ['build', '--memory=2g', '-t', expect.any(String), '-f', path.join(TEST_DIR, 'Dockerfile.build-group'), '.'],
      { cwd: TEST_DIR, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 },
      expect.any(Function),
    );
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.existsSync(path.join(TEST_DIR, 'Dockerfile.build-group'))).toBe(true);

    mocks.callbacks[0]!(null, '', '');
    await pending;
    expect(mocks.updateConfig).toHaveBeenCalledExactlyOnceWith('build-group', { image_tag: expect.any(String) });
    expect(fs.existsSync(path.join(TEST_DIR, 'Dockerfile.build-group'))).toBe(false);
  });

  it('does not skip packages changed during an earlier build of the same group', async () => {
    const first = buildAgentGroupImage('build-group');
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));
    mocks.packages.packages_npm = '["mcp-remote","new-cli"]';
    const second = buildAgentGroupImage('build-group');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    mocks.callbacks[0]!(null, '', '');
    await first;

    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(2));
    expect(fs.readFileSync(path.join(TEST_DIR, 'Dockerfile.build-group'), 'utf8')).toContain("'new-cli'");
    mocks.callbacks[1]!(null, '', '');
    await second;
    expect(mocks.updateConfig).toHaveBeenCalledTimes(2);
  });

  it('cleans up a failed build, preserves the previous image, and permits retry', async () => {
    const failure = Object.assign(new Error('build failed'), { code: 137 });
    const pending = buildAgentGroupImage('build-group');
    const rejected = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));
    mocks.callbacks[0]!(failure, '', 'exit status 137');
    await rejected;
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(TEST_DIR, 'Dockerfile.build-group'))).toBe(false);

    const retry = buildAgentGroupImage('build-group');
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(2));
    mocks.callbacks[1]!(null, '', '');
    await retry;
    expect(mocks.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('serializes different groups and continues after an earlier build fails', async () => {
    const first = buildAgentGroupImage('first-group');
    const rejected = expect(first).rejects.toThrow('first build failed');
    const second = buildAgentGroupImage('second-group');
    const third = buildAgentGroupImage('third-group');
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    mocks.callbacks[0]!(new Error('first build failed'), '', '');
    await rejected;
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(2));
    mocks.callbacks[1]!(null, '', '');
    await second;
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(3));
    expect(mocks.updateConfig).toHaveBeenCalledExactlyOnceWith('second-group', { image_tag: expect.any(String) });
    mocks.callbacks[2]!(null, '', '');
    await third;
    expect(mocks.updateConfig).toHaveBeenNthCalledWith(2, 'third-group', { image_tag: expect.any(String) });
  });
});
