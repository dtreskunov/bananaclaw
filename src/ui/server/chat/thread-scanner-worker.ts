import { parentPort, workerData } from 'node:worker_threads';

import { scanThreadSession, type ThreadScanSpec, type SessionThreadScan } from './thread-scan.js';
import { ThreadScanCache } from './thread-scan-cache.js';

export interface ScanRequest {
  id: number;
  specs: ThreadScanSpec[];
  invalidations: string[] | null;
}

export type ScanResponse = { id: number; scans: SessionThreadScan[] } | { id: number; error: string };

const cache = new ThreadScanCache((spec) => scanThreadSession(workerData.dataDir, spec));

parentPort!.on('message', ({ id, specs, invalidations }: ScanRequest) => {
  let response: ScanResponse;
  try {
    if (invalidations === null) cache.invalidate(null);
    else for (const sessionId of invalidations) cache.invalidate(sessionId);
    response = { id, scans: specs.map((spec) => cache.get(spec)) };
  } catch (error) {
    response = { id, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort!.postMessage(response);
});
