import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: fs.mkdtempSync('/tmp/ncl-r-'),
}));

import { DATA_DIR } from './config.js';
import { putTurn } from './db/turns.js';
import { initSessionFolder, openInboundDb, openOutboundDbRw } from './session-manager.js';
import {
  onSessionTurnChange,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopAllSessionSignalServers,
} from './session-link.js';

let child: ChildProcess | undefined;
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  await stopAllSessionSignalServers();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

it.skipIf(spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0).each(['failed', 'abandoned'])(
  'recovers %s turns across the real Node/Bun session link with no pending input',
  async (mode) => {
    initSessionFolder('recovery-group', 'recovery-session');
    const inbound = openInboundDb('recovery-group', 'recovery-session');
    expect(inbound.prepare("SELECT count(*) AS n FROM messages_in WHERE status='pending'").get()).toEqual({ n: 0 });
    inbound.close();
    const db = openOutboundDbRw('recovery-group', 'recovery-session');
    putTurn(db, {
      id: 'saved-turn',
      origin_channel_type: 'web',
      origin_platform_id: 'chat',
      origin_thread_id: null,
      origin_source_session_id: null,
      started_at: '2026-10-04T20:22:46.226Z',
      ended_at: null,
      phase: 'running',
      outcome: 'pending',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    });
    await startSessionSignalServer('recovery-session', 'recovery-group');
    const changes: string[] = [];
    const unsubscribe = onSessionTurnChange((_sessionId, change) => {
      if (change.settledTurnId) changes.push(change.settledTurnId);
    });
    let stderr = '';
    try {
      child = spawn('bun', ['src/test-fixtures/recovery-runner.mjs', sessionLinkSocketPath('recovery-session'), mode], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.once('close', resolve);
        child!.once('error', reject);
      });
      expect(code, stderr).toBe(0);
      expect(db.prepare('SELECT phase,outcome FROM turns WHERE id=?').get('saved-turn')).toEqual({
        phase: 'settled',
        outcome: mode === 'failed' ? 'failed' : 'interrupted',
      });
      expect(changes).toContain('saved-turn');
      if (mode === 'failed') {
        expect(db.prepare("SELECT json_extract(content,'$.text') AS text FROM messages_out").get()).toEqual({
          text: 'Agent provider error: context window exceeds limit (2013)',
        });
      } else {
        expect(db.prepare('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
      }
    } finally {
      unsubscribe();
      db.close();
    }
  },
);
