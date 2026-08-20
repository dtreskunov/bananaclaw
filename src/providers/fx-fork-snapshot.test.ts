/**
 * The snapshot is the load-bearing half of a native fx fork: without it the
 * container has no parent state to rewind, and an unbounded copy would let a
 * few branches of a busy thread fill the host's disk. These tests pin the
 * copy, the size guard, and the failure modes that must decline rather than
 * leave a half-populated state directory behind.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cloneFxSessionState } from './fx-fork-snapshot.js';

let root: string;
let parentDir: string;
let forkDir: string;

function fxRoot(sessionDir: string): string {
  return path.join(sessionDir, 'fx-state');
}

function seedParentState(logBytes = 1024): string {
  const sessionDir = path.join(fxRoot(parentDir), 'sessions', 'sess-1');
  fs.mkdirSync(path.join(sessionDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), 'x'.repeat(logBytes));
  fs.writeFileSync(path.join(sessionDir, 'commit.abc.json'), '{}');
  fs.writeFileSync(path.join(sessionDir, 'artifacts', 'a.txt'), 'artifact');
  fs.writeFileSync(path.join(fxRoot(parentDir), 'usage.jsonl'), '{}');
  return sessionDir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-fx-fork-'));
  parentDir = path.join(root, 'parent');
  forkDir = path.join(root, 'fork');
  fs.mkdirSync(parentDir, { recursive: true });
  fs.mkdirSync(forkDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FX_FORK_MAX_STATE_BYTES;
});

describe('cloneFxSessionState', () => {
  it('copies the whole state tree, sidecars included', () => {
    seedParentState();
    expect(cloneFxSessionState(parentDir, forkDir)).toBe(true);

    const copied = path.join(fxRoot(forkDir), 'sessions', 'sess-1');
    expect(fs.existsSync(path.join(copied, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(copied, 'commit.abc.json'))).toBe(true);
    expect(fs.readFileSync(path.join(copied, 'artifacts', 'a.txt'), 'utf8')).toBe('artifact');
    expect(fs.existsSync(path.join(fxRoot(forkDir), 'usage.jsonl'))).toBe(true);
  });

  it('declines when the parent never ran an fx session', () => {
    // The mount exists from the moment the container starts, so an empty
    // directory is the normal "nothing to fork" case, not an error.
    fs.mkdirSync(fxRoot(parentDir), { recursive: true });
    expect(cloneFxSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(fxRoot(forkDir))).toBe(false);
  });

  it('declines when the parent state is over the size limit', () => {
    seedParentState(4096);
    process.env.FX_FORK_MAX_STATE_BYTES = '1024';
    expect(cloneFxSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(fxRoot(forkDir))).toBe(false);
  });

  it('does not follow symlinks out of the state directory', () => {
    const sessionDir = seedParentState();
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(sessionDir, 'link.txt'));

    expect(cloneFxSessionState(parentDir, forkDir)).toBe(true);
    const copied = path.join(fxRoot(forkDir), 'sessions', 'sess-1');
    expect(fs.existsSync(path.join(copied, 'link.txt'))).toBe(false);
  });

  it('replaces any state left over from an earlier attempt', () => {
    seedParentState();
    const stale = path.join(fxRoot(forkDir), 'sessions', 'sess-stale');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'events.jsonl'), 'stale');

    expect(cloneFxSessionState(parentDir, forkDir)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
