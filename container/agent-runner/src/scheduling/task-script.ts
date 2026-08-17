import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';
import {
  recordTaskScriptResult,
  startTaskAttempt,
  type TaskScriptAttemptResult,
} from '../db/task-attempts.js';

export const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60_000;
export const MIN_SCRIPT_TIMEOUT_MS = 1_000;
export const MAX_SCRIPT_TIMEOUT_MS = 15 * 60_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;
const SCRIPT_KILL_GRACE_MS = 250;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

export interface ScriptExecution {
  result: ScriptResult | null;
  status: 'passed' | 'failed' | 'timed_out';
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

function log(msg: string): void {
  console.error(`[task-script] ${msg}`);
}

export function normalizeScriptTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_SCRIPT_TIMEOUT_MS;
  return Math.max(MIN_SCRIPT_TIMEOUT_MS, Math.min(MAX_SCRIPT_TIMEOUT_MS, Math.round(timeoutMs)));
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* process already exited */
    }
  }
}

export async function runScript(
  script: string,
  taskId: string,
  timeoutMs?: number,
): Promise<ScriptExecution> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  const effectiveTimeoutMs = normalizeScriptTimeoutMs(timeoutMs);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const heartbeatTimer = setInterval(touchHeartbeat, 15_000);
    const child = spawn('bash', [scriptPath], {
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputOverflow = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const terminateProcessTree = (): void => {
      if (killTimer) return;
      signalProcessTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => signalProcessTree(child.pid, 'SIGKILL'), SCRIPT_KILL_GRACE_MS);
    };

    const cleanup = (): void => {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
      if (killTimer && !timedOut && !outputOverflow) clearTimeout(killTimer);
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* best-effort cleanup */
      }
    };

    const finish = (execution: ScriptExecution): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(execution);
    };

    const appendOutput = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (next.length <= SCRIPT_MAX_BUFFER) return next;
      outputOverflow = true;
      terminateProcessTree();
      return next.slice(0, SCRIPT_MAX_BUFFER);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree();
    }, effectiveTimeoutMs);

    child.on('error', (error) => {
      finish({
        result: null,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: error.message,
      });
    });

    child.on('close', (code, signal) => {
      if (stderr) {
        log(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
      }

      if (timedOut || outputOverflow || code !== 0) {
        const error = timedOut
          ? `script timed out after ${effectiveTimeoutMs}ms`
          : outputOverflow
            ? `script output exceeded ${SCRIPT_MAX_BUFFER} bytes`
            : `script exited with code ${code}${signal ? ` (${signal})` : ''}`;
        log(`[${taskId}] error: ${error}`);
        finish({
          result: null,
          status: timedOut ? 'timed_out' : 'failed',
          durationMs: Date.now() - startedAt,
          exitCode: code,
          signal,
          stdout,
          stderr,
          error,
        });
        return;
      }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log(`[${taskId}] no output`);
        finish({
          result: null,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          signal: null,
          stdout,
          stderr,
          error: 'script produced no output',
        });
        return;
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          finish({
            result: null,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            exitCode: 0,
            signal: null,
            stdout,
            stderr,
            error: 'script output missing wakeAgent boolean',
          });
          return;
        }
        finish({
          result: result as ScriptResult,
          status: 'passed',
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          signal: null,
          stdout,
          stderr,
          error: null,
        });
      } catch {
        log(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
        finish({
          result: null,
          status: 'failed',
          durationMs: Date.now() - startedAt,
          exitCode: 0,
          signal: null,
          stdout,
          stderr,
          error: 'script output is not valid JSON',
        });
      }
    });
  });
}

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: string[];
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → removed from provider input;
 *   the durable attempt distinguishes failed, timed_out, and skipped.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: string[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    startTaskAttempt(msg);

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      recordTaskScriptResult(msg.id, {
        status: 'ready',
        durationMs: 0,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
        wakeAgent: null,
      });
      keep.push(msg);
      continue;
    }

    const script = typeof content.script === 'string' ? (content.script as string) : null;
    if (!script) {
      recordTaskScriptResult(msg.id, {
        status: 'ready',
        durationMs: 0,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: null,
        wakeAgent: null,
      });
      keep.push(msg);
      continue;
    }

    log(`running script for task ${msg.id}`);
    touchHeartbeat();
    const configuredTimeout = typeof content.scriptTimeoutMs === 'number'
      ? content.scriptTimeoutMs
      : undefined;
    const execution = await runScript(script, msg.id, configuredTimeout);
    touchHeartbeat();

    const result = execution.result;
    const attemptResult: TaskScriptAttemptResult = {
      status: execution.status === 'timed_out'
        ? 'timed_out'
        : execution.status === 'failed'
          ? 'failed'
          : result?.wakeAgent
            ? 'ready'
            : 'skipped',
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdout: execution.stdout,
      stderr: execution.stderr,
      error: execution.error,
      wakeAgent: result?.wakeAgent ?? null,
    };
    recordTaskScriptResult(msg.id, attemptResult);

    if (!result || !result.wakeAgent) {
      const reason = execution.status === 'timed_out'
        ? 'timed out'
        : result
          ? 'wakeAgent=false'
          : 'script error/no output';
      log(`task ${msg.id} skipped: ${reason}`);
      skipped.push(msg.id);
      continue;
    }

    log(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
