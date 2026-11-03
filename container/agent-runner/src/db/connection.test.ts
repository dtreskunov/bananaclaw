import { afterEach, expect, it } from 'bun:test';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { getForkOrigin } from './fork-origin.js';
import {
  completeRestartRequests,
  getPendingInputEdits,
  getPendingMessages,
  getSteeringCandidates,
  hasPendingRestart,
  nextPendingDueDelayMs,
} from './messages-in.js';

afterEach(closeSessionDb);

it.each([false, true])('read helpers borrow handles without closing them (unified: %s)', (unified) => {
  const { inbound, outbound } = initTestSessionDb({ unifiedHostProjection: unified });
  const borrowed = getInboundDb();
  expect(borrowed).toBe(unified ? outbound : inbound);
  expect(getForkOrigin()).toBeNull();
  expect(getPendingMessages()).toEqual([]);
  expect(getPendingInputEdits()).toEqual([]);
  expect(hasPendingRestart()).toBe(false);
  expect(completeRestartRequests(0)).toBe(0);
  expect(nextPendingDueDelayMs()).toBeUndefined();
  expect(getSteeringCandidates({ channelType: 'web', platformId: 'room', threadId: 'thread' }, [])).toEqual([]);
  expect(getInboundDb()).toBe(borrowed);
  expect(borrowed.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
  expect(getOutboundDb().prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
});
