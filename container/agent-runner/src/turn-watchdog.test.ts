import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { maxOutboundSeq, writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';
import { startTurnWatchdog } from './turn-watchdog.js';

const ROUTING: RoutingContext = {
  platformId: 'chan-1',
  channelType: 'web',
  threadId: 'thread-1',
  inReplyTo: null,
};

function outboundChatTexts(): string[] {
  const { outbound } = grab();
  const rows = outbound.prepare("SELECT content FROM messages_out WHERE kind = 'chat' ORDER BY seq").all() as Array<{
    content: string;
  }>;
  return rows.map((r) => JSON.parse(r.content).text as string);
}

let dbs: ReturnType<typeof initTestSessionDb>;
function grab() {
  return dbs;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let idCounter = 0;
const genId = () => `wd-${idCounter++}`;

beforeEach(() => {
  dbs = initTestSessionDb();
  idCounter = 0;
});

afterEach(() => {
  closeSessionDb();
});

describe('startTurnWatchdog', () => {
  it('emits a durable progress notice when the turn stays silent', async () => {
    const wd = startTurnWatchdog(ROUTING, { firstNoticeMs: 20, repeatMs: 10_000, generateId: genId });
    await sleep(50);
    wd.stop();
    const texts = outboundChatTexts();
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain('Still working');
  });

  it('re-notifies while silence continues', async () => {
    const wd = startTurnWatchdog(ROUTING, { firstNoticeMs: 15, repeatMs: 15, generateId: genId });
    await sleep(70);
    wd.stop();
    expect(outboundChatTexts().length).toBeGreaterThanOrEqual(2);
  });

  it('stops re-notifying once the notice cap is reached', async () => {
    // A hung turn never calls stop(); the cap must bound total notices.
    const wd = startTurnWatchdog(ROUTING, {
      firstNoticeMs: 10,
      repeatMs: 10,
      maxNotices: 2,
      generateId: genId,
    });
    await sleep(200);
    // Do NOT call stop() — simulate a turn whose finally never runs.
    expect(outboundChatTexts().length).toBe(2);
    wd.stop();
  });

  it('backs off the interval between successive notices', async () => {
    // With base 10ms doubling each notice (10 → 20 → 40 …), a 55ms window
    // fits the first two notices (at ~10 and ~30) but not a fixed-interval
    // third (which a non-backoff 10ms cadence would place at ~30 too — this
    // asserts the second gap widened past the window's remainder).
    const wd = startTurnWatchdog(ROUTING, {
      firstNoticeMs: 10,
      repeatMs: 10,
      maxNotices: 10,
      generateId: genId,
    });
    await sleep(55);
    wd.stop();
    // Fixed 10ms cadence would emit ~5 notices in 55ms; backoff caps it low.
    expect(outboundChatTexts().length).toBeLessThanOrEqual(3);
    expect(outboundChatTexts().length).toBeGreaterThanOrEqual(2);
  });

  it('stays quiet once the agent emits a real message', async () => {
    const wd = startTurnWatchdog(ROUTING, { firstNoticeMs: 15, repeatMs: 15, generateId: genId });
    // Real agent output arrives before the first notice fires.
    writeMessageOut({
      id: 'real-1',
      kind: 'chat',
      platform_id: ROUTING.platformId,
      channel_type: ROUTING.channelType,
      thread_id: ROUTING.threadId,
      content: JSON.stringify({ text: 'here is your answer' }),
    });
    await sleep(60);
    wd.stop();
    const texts = outboundChatTexts();
    expect(texts).toContain('here is your answer');
    expect(texts.some((t) => t.includes('Still working'))).toBe(false);
  });

  it('does not count pre-turn output as progress', async () => {
    // A prior turn's reply already sits in the table before the watchdog starts.
    writeMessageOut({
      id: 'old-1',
      kind: 'chat',
      platform_id: ROUTING.platformId,
      channel_type: ROUTING.channelType,
      thread_id: ROUTING.threadId,
      content: JSON.stringify({ text: 'previous turn reply' }),
    });
    const baseline = maxOutboundSeq();
    expect(baseline).toBeGreaterThan(0);
    const wd = startTurnWatchdog(ROUTING, { firstNoticeMs: 20, repeatMs: 10_000, generateId: genId });
    await sleep(50);
    wd.stop();
    const texts = outboundChatTexts();
    expect(texts.some((t) => t.includes('Still working'))).toBe(true);
  });

  it('stop() before the first tick emits nothing', async () => {
    const wd = startTurnWatchdog(ROUTING, { firstNoticeMs: 40, repeatMs: 40, generateId: genId });
    wd.stop();
    await sleep(80);
    expect(outboundChatTexts().length).toBe(0);
  });
});
