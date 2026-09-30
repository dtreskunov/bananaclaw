/**
 * Drives the follow-up poll for an open query. Polls run when the host
 * signals new input over the session link, or when the next scheduled row
 * falls due; overlapping wakes coalesce into one extra poll. Fatal inbound DB
 * errors end the container rather than spinning.
 */
import { nextPendingDueDelayMs } from '../db/messages-in.js';
import { onHostEvent } from '../session-link.js';

/**
 * Number of consecutive local SQLite corruption errors after which the
 * follow-up watcher gives up and exits the process.
 */
const CORRUPTION_STREAK_EXIT = 10;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

/**
 * True for SQLite errors that indicate the DB file has been removed
 * (e.g. the host deleted the chat thread / session dir). The container
 * should exit immediately rather than poll a dead file forever.
 */
export function isMissingDbError(msg: string): boolean {
  return (
    msg.includes('unable to open database file') ||
    msg.includes('SQLITE_CANTOPEN') ||
    msg.includes('no such file or directory')
  );
}

export class FollowUpWatcher {
  private inFlight = false;
  private dirty = false;
  private corruptionStreak = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: () => void = () => {};

  constructor(
    private readonly opts: {
      poll: () => Promise<void>;
      /** The query no longer accepts follow-ups. */
      closed: () => boolean;
      /** A result is being finished; the poll after it will pick input up. */
      finishingResult: () => boolean;
      /** A fatal error is about to exit the process. */
      onFatal: () => void;
    },
  ) {}

  start(): void {
    this.unsubscribe = onHostEvent(() => this.wake());
    this.scheduleNextDue();
  }

  stop(): void {
    this.unsubscribe();
    this.unsubscribe = () => {};
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.poll();
  }

  private scheduleNextDue(): void {
    if (this.opts.closed() || this.timer) return;
    const delay = nextPendingDueDelayMs();
    if (delay === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poll();
    }, delay);
    this.timer.unref?.();
  }

  private poll(): void {
    if (this.opts.closed() || this.opts.finishingResult()) return;
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    void (async () => {
      try {
        await this.opts.poll();
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection.
        this.onPollError(err);
      } finally {
        this.inFlight = false;
        if (this.dirty) {
          this.dirty = false;
          this.poll();
        } else {
          this.scheduleNextDue();
        }
      }
    })();
  }

  private onPollError(err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Follow-up poll error: ${errMsg}`);

    // Session DB gone — the host deleted the thread and removed the on-disk
    // session dir. Exit immediately instead of polling a dead file forever.
    if (isMissingDbError(errMsg)) {
      log('Follow-up poll: inbound.db is gone — session was deleted by host. Exiting.');
      this.fatal(0);
      return;
    }

    // SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
    // gRPC-FUSE coherency bug): every fresh openInboundDb() in this process
    // sees the same torn snapshot and only a fresh container mount recovers.
    // Exit so the host sweep respawns us.
    if (!isCorruptionError(errMsg)) {
      this.corruptionStreak = 0;
      return;
    }
    this.corruptionStreak += 1;
    if (this.corruptionStreak >= CORRUPTION_STREAK_EXIT) {
      log(
        `Follow-up poll: ${this.corruptionStreak} consecutive '${errMsg}' errors — ` +
          `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
      );
      this.fatal(75);
    }
  }

  private fatal(code: number): void {
    // Stop touching the heartbeat so host-sweep stale detection fires
    // promptly even if exit() races with in-flight async work.
    this.opts.onFatal();
    this.stop();
    // Defer exit one tick so the log line flushes through Docker's log driver.
    setTimeout(() => process.exit(code), 100);
  }
}
