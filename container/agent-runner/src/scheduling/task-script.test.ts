import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import type { MessageInRow } from '../db/messages-in.js';
import {
  applyPreTaskScripts,
  MAX_SCRIPT_TIMEOUT_MS,
  MIN_SCRIPT_TIMEOUT_MS,
  normalizeScriptTimeoutMs,
  runScript,
} from './task-script.js';

const cleanupPaths: string[] = [];

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    try {
      fs.unlinkSync(cleanupPath);
    } catch {
      /* best-effort cleanup */
    }
  }
  closeSessionDb();
});

function taskMessage(id: string, content: Record<string, unknown>): MessageInRow {
  return {
    id,
    seq: 2,
    kind: 'task',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: '0 9 * * *',
    series_id: 'series-1',
    tries: 0,
    trigger: 1,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(content),
  };
}

describe('scheduled task scripts', () => {
  it('clamps configured timeouts to safe bounds', () => {
    expect(normalizeScriptTimeoutMs(1)).toBe(MIN_SCRIPT_TIMEOUT_MS);
    expect(normalizeScriptTimeoutMs(MAX_SCRIPT_TIMEOUT_MS + 1)).toBe(MAX_SCRIPT_TIMEOUT_MS);
  });

  it('kills the full process group when a script times out', async () => {
    const markerPath = `/tmp/nanoclaw-task-script-marker-${process.pid}-${Date.now()}`;
    const termMarkerPath = `${markerPath}-term`;
    cleanupPaths.push(markerPath, termMarkerPath);

    const result = await runScript(
      `(trap 'printf term > ${JSON.stringify(termMarkerPath)}' TERM; while :; do sleep 2; done) & wait\nprintf survived > ${JSON.stringify(markerPath)}`,
      `timeout-${process.pid}-${Date.now()}`,
      MIN_SCRIPT_TIMEOUT_MS,
    );

    expect(result.status).toBe('timed_out');
    expect(result.result).toBeNull();
    await Bun.sleep(300);
    expect(fs.existsSync(termMarkerPath)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('records wakeAgent=false as a skipped attempt without provider work', async () => {
    const message = taskMessage('skip-task', {
      prompt: 'only wake on a match',
      script: `printf '%s\\n' '{"wakeAgent":false,"data":{"matches":0}}'`,
    });

    const outcome = await applyPreTaskScripts([message]);

    expect(outcome.keep).toEqual([]);
    expect(outcome.skipped).toEqual(['skip-task']);
    const attempt = getOutboundDb()
      .prepare(
        `SELECT status, trigger_source, wake_agent, provider_invoked, completed_at
         FROM task_attempts WHERE task_message_id = ?`,
      )
      .get('skip-task') as Record<string, unknown>;
    expect(attempt.status).toBe('skipped');
    expect(attempt.trigger_source).toBe('scheduled');
    expect(attempt.wake_agent).toBe(0);
    expect(attempt.provider_invoked).toBe(0);
    expect(attempt.completed_at).not.toBeNull();
  });

  it('fails a script that exits nonzero even if it printed valid JSON', async () => {
    const result = await runScript(
      `printf '%s\\n' '{"wakeAgent":true}'\nexit 7`,
      `nonzero-${process.pid}-${Date.now()}`,
    );

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(result.result).toBeNull();
    expect(result.error).toBe('script exited with code 7');
  });

  it('fails a script whose final output line is malformed JSON', async () => {
    const result = await runScript(
      `printf '%s\\n' 'not-json'`,
      `malformed-${process.pid}-${Date.now()}`,
    );

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(0);
    expect(result.result).toBeNull();
    expect(result.error).toBe('script output is not valid JSON');
  });
});