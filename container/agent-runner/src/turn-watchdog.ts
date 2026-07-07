/**
 * Long-turn progress watchdog.
 *
 * A single turn can run for many minutes. The only "still working" signal
 * during that time is the ephemeral typing/activity indicator, which is NOT
 * persisted into the conversation — if the user's client reconnects or
 * reloads, the thread shows their message and nothing else until the final
 * answer lands, which is indistinguishable from a dead agent.
 *
 * This watchdog runs concurrently with the provider query. If the turn goes
 * long without emitting any user-visible outbound message, it writes ONE
 * durable "still working…" chat message so the user always has feedback that
 * the agent is engaged — on every channel, surviving reloads. It re-notifies
 * at a longer interval while the silence continues, and goes quiet as soon as
 * real output appears (a normal reply, a question, a file, etc.).
 *
 * The container owns outbound.db, so writing here is safe — no single-writer
 * violation (unlike the host, which must never write outbound.db while a
 * container is alive).
 */
import { maxForeignOutboundSeq, maxOutboundSeq, writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';

/** Delay before the first "still working" notice, if the turn is still silent. */
export const FIRST_NOTICE_MS = 90_000;
/** Interval between subsequent notices while the turn remains silent. */
export const REPEAT_NOTICE_MS = 180_000;

const DEFAULT_TEXT =
  "⏳ Still working on this — it's taking longer than usual. I'll follow up here as soon as it's done.";

export interface TurnWatchdog {
  /** Stop the watchdog. Idempotent. Call from a finally when the turn ends. */
  stop(): void;
}

export interface TurnWatchdogOptions {
  firstNoticeMs?: number;
  repeatMs?: number;
  text?: string;
  /** Injected for tests; defaults to a msg-<ts>-<rand> id. */
  generateId?: () => string;
  /** Injected for tests; defaults to console.error. */
  log?: (msg: string) => void;
}

function defaultId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start a watchdog for one turn. Only meaningful for turns bound to a real
 * channel — callers should skip it when routing has no platform/channel.
 */
export function startTurnWatchdog(routing: RoutingContext, opts: TurnWatchdogOptions = {}): TurnWatchdog {
  const firstMs = opts.firstNoticeMs ?? FIRST_NOTICE_MS;
  const repeatMs = opts.repeatMs ?? REPEAT_NOTICE_MS;
  const text = opts.text ?? DEFAULT_TEXT;
  const genId = opts.generateId ?? defaultId;
  const log = opts.log ?? ((m: string) => console.error(`[turn-watchdog] ${m}`));

  // Baseline: any outbound row already present before the turn started must
  // not count as this turn's progress. Captured once; the watchdog's own
  // notices are tracked separately in `mine` so a later real reply (seq >
  // baseline, id not in `mine`) still registers as progress.
  const baseline = maxOutboundSeq();
  const mine = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = (): void => {
    if (stopped) return;
    try {
      const foreign = maxForeignOutboundSeq(baseline, mine);
      if (foreign > baseline) {
        // The agent has spoken since the turn began — the user has feedback.
        // Stay quiet this round.
      } else {
        const id = genId();
        writeMessageOut({
          id,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text }),
        });
        mine.add(id);
        log('Emitted long-turn progress notice');
      }
    } catch (err) {
      // Best-effort — a watchdog failure must never disrupt the turn.
      log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stopped) timer = setTimeout(tick, repeatMs);
  };

  timer = setTimeout(tick, firstMs);

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
