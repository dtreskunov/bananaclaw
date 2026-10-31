import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MessageInRow } from './db/messages-in.js';

/**
 * `/upload-trace` command: upload this session's Claude Code transcript to the user's
 * own private `{hf_user}/nanoclaw-traces` dataset, browsable in the HF Agent
 * Trace Viewer. The transcript the Claude provider keeps under
 * `~/.claude/projects/<dir>/<sessionId>.jsonl` is already in the format the
 * viewer auto-detects, so this just locates the newest one and pushes it.
 *
 * Auth is the credential gateway's job: curl goes out through the injected
 * HTTPS_PROXY, which adds the user's HF token. We never see the raw token, and
 * a failed `whoami` returns backend-specific access and recovery guidance.
 */

/**
 * Narrow check for /upload-trace — the runner handles this command directly
 * (no LLM turn). Admin-gated by the host router before it reaches the container.
 */
export function isUploadTraceCommand(msg: MessageInRow): boolean {
  let text = '';
  try {
    text = (JSON.parse(msg.content)?.text ?? '').trim();
  } catch {
    return false; // non-JSON content is never a command
  }
  return text.toLowerCase().startsWith('/upload-trace');
}

/** Newest Claude Code transcript jsonl (the current session). */
function newestTranscript(): string | null {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let best: { p: string; m: number } | null = null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(projects, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(projects, dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  }
  return best?.p ?? null;
}

function curl(args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync('curl', args, { input, encoding: 'utf-8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * Agent Vault recovery uses personal connections and group grants; only the
 * legacy backend uses gateway-provided setup URLs.
 */
export function traceAuthRecoveryMessage(
  body: string,
  status: string,
  agentVault = Boolean(process.env.NANOCLAW_EGRESS_SOCKET),
): string {
  if (agentVault) {
    return [
      `Can't upload — the Hugging Face account check failed (HTTP ${status}).`,
      'Endpoint: https://huggingface.co/api/whoami-v2',
      '',
      "Check this agent's Access settings and the owner's connection in Credentials.",
      'If access is missing, connect a Hugging Face credential privately and grant this agent access to https://huggingface.co. Uploads require write permission.',
      'A 401/403 alone does not establish disconnection; check provider permissions and routing. Never send tokens in chat.',
      '',
      'Then run /upload-trace again.',
    ].join('\n');
  }
  let setupUrl: string | undefined;
  try {
    const e = JSON.parse(body) as { secret_url?: string; connect_url?: string; manage_url?: string };
    if (e.secret_url) {
      // The pre-filled `path` defaults to the failing request path
      // (/api/whoami-v2), which scopes the secret to that one endpoint. Blank
      // it so the secret matches all of huggingface.co — the upload endpoints
      // included, not just whoami.
      setupUrl = e.secret_url.replace(/([?&]path=)[^&]*/, '$1');
    } else {
      setupUrl = e.connect_url ?? e.manage_url;
    }
  } catch {
    /* non-JSON body (e.g. HF's own error, or no gateway) — generic fallback */
  }
  const lines = [
    "Can't upload — no Hugging Face token is available to this agent. To set it up:",
    '',
    '1. Create a token with WRITE access at https://huggingface.co/settings/tokens',
    '   (New token → type "Write" → copy it).',
    '',
    setupUrl
      ? `2. Add it to OneCLI here: ${setupUrl}`
      : '2. Add it to the OneCLI vault as a secret with host pattern  huggingface.co',
    '',
    'Then run /upload-trace again.',
  ];
  return lines.join('\n');
}

/** Returns a user-facing status line. Never throws. */
export function uploadTrace(): string {
  const file = newestTranscript();
  if (!file) return 'No transcript to upload for this session yet.';

  // whoami, capturing the body + HTTP status (no -f, so the gateway's error
  // JSON survives a 401). Legacy setup URLs are used only on that backend.
  const who = curl(['-s', '-w', '\n%{http_code}', 'https://huggingface.co/api/whoami-v2']);
  const nl = who.out.lastIndexOf('\n');
  const body = nl === -1 ? '' : who.out.slice(0, nl);
  const status = nl === -1 ? who.out.trim() : who.out.slice(nl + 1).trim();

  if (status !== '200') {
    return traceAuthRecoveryMessage(body, status);
  }
  let user: string | undefined;
  try {
    user = JSON.parse(body)?.name;
  } catch {
    /* fall through */
  }
  if (!user) return 'Could not resolve your Hugging Face username.';

  const repo = `${user}/nanoclaw-traces`;
  // Idempotent create — ignore failure (already exists / no-op). The
  // Content-Type header is required: without it curl sends form-encoding and
  // the Hub rejects the body with 400 (expected string at "name").
  curl([
    '-sf',
    '-X',
    'POST',
    'https://huggingface.co/api/repos/create',
    '-H',
    'Content-Type: application/json',
    '-d',
    JSON.stringify({ type: 'dataset', name: 'nanoclaw-traces', private: true }),
  ]);

  const content = fs.readFileSync(file).toString('base64');
  const repoPath = `sessions/${path.basename(file)}`;
  const ndjson =
    JSON.stringify({ key: 'header', value: { summary: 'add session trace' } }) +
    '\n' +
    JSON.stringify({
      key: 'file',
      value: { path: repoPath, encoding: 'base64', content },
    }) +
    '\n';

  const commit = curl(
    [
      '-sf',
      '-X',
      'POST',
      `https://huggingface.co/api/datasets/${repo}/commit/main`,
      '-H',
      'Content-Type: application/x-ndjson',
      '--data-binary',
      '@-',
    ],
    ndjson,
  );
  if (!commit.ok) {
    return 'Upload to Hugging Face failed (the transcript may be too large for an inline commit).';
  }
  return `Uploaded → https://huggingface.co/datasets/${repo}/blob/main/${repoPath}`;
}
