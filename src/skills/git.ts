/**
 * The one place that shells out to git.
 *
 * Centralised mostly for the environment: every invocation must run with
 * credential prompting disabled, or a repo that asks for auth hangs the host
 * process instead of failing. Two flavours because callers genuinely differ —
 * install and catalog sync want the failure, reading provenance wants a null.
 */
import { execFileSync } from 'child_process';

/** Ceiling, not a wait — clones are the slow case. */
export const GIT_TIMEOUT_MS = 120_000;

/** Reads against a local checkout should give up long before a clone would. */
export const GIT_LOCAL_TIMEOUT_MS = 15_000;

function run(args: string[], cwd: string | undefined, timeoutMs: number): string {
  return execFileSync('git', args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true', GCM_INTERACTIVE: 'never' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Run git, throwing whatever `execFileSync` throws on a non-zero exit. */
export function git(args: string[], cwd?: string, timeoutMs = GIT_TIMEOUT_MS): string {
  return run(args, cwd, timeoutMs);
}

/** Run git, returning null instead of throwing. */
export function gitOrNull(args: string[], cwd?: string, timeoutMs = GIT_LOCAL_TIMEOUT_MS): string | null {
  try {
    return run(args, cwd, timeoutMs);
  } catch {
    return null;
  }
}

/** Preserve git's diagnostic, not just execFileSync's "Command failed" header. */
export function gitErrorDetail(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const stderr =
      typeof err.stderr === 'string' ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : '';
    if (stderr.trim()) return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}
