import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: path.resolve('.test-session-recovery'),
}));

import { initSessionFolder, openOutboundDbRw, runnerStateDbPath } from './session-manager.js';
import { needsStoppedRunnerRecovery } from './session-recovery.js';
import type { Session } from './types.js';

const session: Session = {
  id: 'session-recovery',
  agent_group_id: 'group-recovery',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-10-04T20:22:46.000Z',
};

beforeEach(() => initSessionFolder(session.agent_group_id, session.id));
afterEach(() => fs.rmSync('.test-session-recovery', { recursive: true, force: true }));

describe('needsStoppedRunnerRecovery', () => {
  it('recovers an unsettled turn with no pending inbound work', () => {
    const db = openOutboundDbRw(session.agent_group_id, session.id);
    try {
      db.prepare(
        `INSERT INTO turns (id,phase,outcome,provenance) VALUES ('turn-1','running','pending','native')`,
      ).run();
    } finally {
      db.close();
    }
    expect(needsStoppedRunnerRecovery(session)).toBe(true);
  });

  it('recovers an outstanding processing projection before applying stale-claim retries', () => {
    const db = openOutboundDbRw(session.agent_group_id, session.id);
    try {
      db.prepare("INSERT INTO processing_ack VALUES ('input-1','processing','2026-10-04 20:22:46')").run();
    } finally {
      db.close();
    }
    expect(needsStoppedRunnerRecovery(session)).toBe(true);
  });

  it('recovers a stale running registry entry after startup adoption finds no container', () => {
    expect(needsStoppedRunnerRecovery({ ...session, container_status: 'running' })).toBe(true);
  });

  it('does not repeatedly recover completed sessions or create missing runner storage', () => {
    expect(needsStoppedRunnerRecovery(session)).toBe(false);
    fs.unlinkSync(runnerStateDbPath(session.agent_group_id, session.id));
    expect(needsStoppedRunnerRecovery({ ...session, container_status: 'running' })).toBe(false);
  });
});
