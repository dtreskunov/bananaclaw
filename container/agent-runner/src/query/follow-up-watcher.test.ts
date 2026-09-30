import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { emitHostEventForTesting } from '../session-link.js';
import { FollowUpWatcher } from './follow-up-watcher.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FollowUpWatcher', () => {
  let watcher: FollowUpWatcher | undefined;

  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    closeSessionDb();
  });

  it('coalesces wakes during an in-flight poll into one extra poll', async () => {
    let polls = 0;
    let release!: () => void;
    watcher = new FollowUpWatcher({
      poll: async () => {
        polls++;
        if (polls === 1) await new Promise<void>((resolve) => (release = resolve));
      },
      closed: () => false,
      finishingResult: () => false,
      onFatal: () => {},
    });
    watcher.start();
    emitHostEventForTesting();
    emitHostEventForTesting();
    emitHostEventForTesting();
    expect(polls).toBe(1);
    release();
    await tick();
    expect(polls).toBe(2);
  });

  it('does not poll while closed or while a result is being finished', async () => {
    let polls = 0;
    let closed = true;
    let finishing = false;
    watcher = new FollowUpWatcher({
      poll: async () => {
        polls++;
      },
      closed: () => closed,
      finishingResult: () => finishing,
      onFatal: () => {},
    });
    watcher.start();
    watcher.wake();
    closed = false;
    finishing = true;
    watcher.wake();
    expect(polls).toBe(0);
    finishing = false;
    watcher.wake();
    expect(polls).toBe(1);
  });

  it('exits cleanly once the session DB is gone', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    let fatal = false;
    try {
      watcher = new FollowUpWatcher({
        poll: async () => {
          throw new Error('SQLITE_CANTOPEN: unable to open database file');
        },
        closed: () => fatal,
        finishingResult: () => false,
        onFatal: () => (fatal = true),
      });
      watcher.wake();
      await tick(150);
      expect(fatal).toBe(true);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it('exits for a respawn only after a streak of corruption errors, reset by other errors', async () => {
    const exit = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    let fatal = false;
    let error = 'database disk image is malformed';
    try {
      watcher = new FollowUpWatcher({
        poll: async () => {
          throw new Error(error);
        },
        closed: () => fatal,
        finishingResult: () => false,
        onFatal: () => (fatal = true),
      });
      for (let i = 0; i < 9; i++) {
        watcher.wake();
        await tick();
      }
      error = 'database is locked';
      watcher.wake();
      await tick();
      error = 'database disk image is malformed';
      for (let i = 0; i < 9; i++) {
        watcher.wake();
        await tick();
      }
      expect(fatal).toBe(false);
      watcher.wake();
      await tick(150);
      expect(fatal).toBe(true);
      expect(exit).toHaveBeenCalledWith(75);
    } finally {
      exit.mockRestore();
    }
  });
});
