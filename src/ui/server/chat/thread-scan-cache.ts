import type { SessionThreadScan, ThreadScanSpec } from './thread-scan.js';

export const THREAD_SCAN_MAX_AGE_MS = 60_000;
const MAX_CACHED_SCANS = 1024;

export class ThreadScanCache {
  private entries = new Map<string, { sessionId: string; at: number; scan: SessionThreadScan }>();

  constructor(
    private readonly read: (spec: ThreadScanSpec) => SessionThreadScan,
    private readonly now = Date.now,
  ) {}

  get(spec: ThreadScanSpec): SessionThreadScan {
    const key = JSON.stringify(spec);
    const cached = this.entries.get(key);
    const now = this.now();
    this.entries.delete(key);
    const entry =
      cached && now - cached.at < THREAD_SCAN_MAX_AGE_MS
        ? cached
        : { sessionId: spec.sessionId, at: now, scan: this.read(spec) };
    this.entries.set(key, entry);
    if (this.entries.size > MAX_CACHED_SCANS) this.entries.delete(this.entries.keys().next().value!);
    return entry.scan;
  }

  invalidate(sessionId: string | null): void {
    for (const [key, entry] of this.entries) {
      if (sessionId === null || entry.sessionId === sessionId) this.entries.delete(key);
    }
  }
}
