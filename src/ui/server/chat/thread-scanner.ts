import { Worker } from 'node:worker_threads';

import { DATA_DIR } from '../../../config.js';
import { onShutdown } from '../../../response-registry.js';
import { onConversationChange } from '../../../conversation-events.js';
import type { SessionThreadScan, ThreadScanSpec } from './thread-scan.js';
import type { ScanResponse } from './thread-scanner-worker.js';

export class ThreadScanner {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (scans: SessionThreadScan[]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private inFlight = new Map<string, { promise: Promise<SessionThreadScan[]>; sessions: Set<string> }>();
  private dirty = new Set<string>();
  private clearCache = false;

  constructor(private readonly dataDir = DATA_DIR) {}

  scan(specs: ThreadScanSpec[]): Promise<SessionThreadScan[]> {
    if (!specs.length) return Promise.resolve([]);
    const key = JSON.stringify(specs);
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;
    if (this.pending.size >= 32) return Promise.reject(new Error('Thread scanner busy; retry the request'));
    const worker = this.getWorker();
    worker.ref();
    const promise = new Promise<SessionThreadScan[]>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.fail(worker, new Error('Thread scan timed out'));
        void worker.terminate();
      }, 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, specs, invalidations: this.clearCache ? null : [...this.dirty] });
      this.dirty.clear();
      this.clearCache = false;
    });
    this.inFlight.set(key, { promise, sessions: new Set(specs.map((spec) => spec.sessionId)) });
    const finish = () => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    };
    void promise.then(finish, finish);
    return promise;
  }

  invalidate(sessionId: string | null): void {
    if (!this.worker) return;
    for (const [key, request] of this.inFlight) {
      if (sessionId === null || request.sessions.has(sessionId)) this.inFlight.delete(key);
    }
    if (sessionId === null || this.dirty.size >= 1024) {
      this.clearCache = true;
      this.dirty.clear();
    } else if (!this.clearCache) this.dirty.add(sessionId);
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.fail(worker, new Error('Thread scanner stopped'));
    await worker.terminate();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(`./thread-scanner-worker.${source ? 'ts' : 'js'}`, import.meta.url);
    // Node workers don't inherit the parent TS loader's module hooks.
    const worker = source
      ? new Worker(
          new URL(
            `data:text/javascript,${encodeURIComponent(
              `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
         register(); await import(${JSON.stringify(entry.href)});`,
            )}`,
          ),
          { workerData: { dataDir: this.dataDir } },
        )
      : new Worker(entry, { workerData: { dataDir: this.dataDir } });
    this.worker = worker;
    worker.on('message', (response: ScanResponse) => {
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if ('error' in response) request.reject(new Error(response.error));
      else request.resolve(response.scans);
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', (error) => this.fail(worker, error));
    worker.on('exit', (code) => this.fail(worker, new Error(`Thread scanner exited (${code})`)));
    worker.unref();
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.inFlight.clear();
    this.dirty.clear();
    this.clearCache = false;
  }
}

export const threadScanner = new ThreadScanner();
onConversationChange((sessionId) => threadScanner.invalidate(sessionId));
onShutdown(() => threadScanner.close());
