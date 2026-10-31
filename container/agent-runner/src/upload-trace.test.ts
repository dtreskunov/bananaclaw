import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { isUploadTraceCommand, traceAuthRecoveryMessage } from './upload-trace.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('isUploadTraceCommand', () => {
  const make = (text: unknown) => ({ content: JSON.stringify({ text }) }) as MessageInRow;

  it('matches /upload-trace (case-insensitive, with args)', () => {
    expect(isUploadTraceCommand(make('/upload-trace'))).toBe(true);
    expect(isUploadTraceCommand(make('/UPLOAD-TRACE'))).toBe(true);
    expect(isUploadTraceCommand(make('  /upload-trace now '))).toBe(true);
  });

  it('does not match other text or commands', () => {
    expect(isUploadTraceCommand(make('hello'))).toBe(false);
    expect(isUploadTraceCommand(make('/upload'))).toBe(false);
    expect(isUploadTraceCommand(make('/clear'))).toBe(false);
    expect(isUploadTraceCommand({ content: 'not json' } as MessageInRow)).toBe(false);
  });
});

describe('trace authentication recovery', () => {
  it('selects Agent Vault from the live egress socket environment', () => {
    const previous = process.env.NANOCLAW_EGRESS_SOCKET;
    try {
      process.env.NANOCLAW_EGRESS_SOCKET = '/run/nanoclaw/egress/egress.sock';
      expect(traceAuthRecoveryMessage('{}', '401')).toContain('Access settings');
      delete process.env.NANOCLAW_EGRESS_SOCKET;
      expect(traceAuthRecoveryMessage('{}', '401')).toContain('OneCLI vault');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_EGRESS_SOCKET;
      else process.env.NANOCLAW_EGRESS_SOCKET = previous;
    }
  });

  it('uses personal connections and agent access for Agent Vault, not legacy setup URLs', () => {
    const text = traceAuthRecoveryMessage(
      JSON.stringify({
        secret_url: 'https://legacy.example/secrets/new',
        connect_url: 'https://legacy.example/connect',
      }),
      '403',
      true,
    );
    expect(text).toContain('HTTP 403');
    expect(text).toContain('https://huggingface.co/api/whoami-v2');
    expect(text).toContain('Access settings');
    expect(text).toContain('Credentials');
    expect(text).toContain('write permission');
    expect(text).toContain('does not establish disconnection');
    expect(text).not.toContain('legacy.example');
    expect(text).not.toContain('OneCLI');
  });

  it('handles non-JSON failures without claiming that the account is disconnected', () => {
    const text = traceAuthRecoveryMessage('connection failed', '000', true);
    expect(text).toContain('HTTP 000');
    expect(text).toContain('check provider permissions and routing');
    expect(text).not.toContain('no Hugging Face token');
  });

  it('preserves legacy setup links and removes the whoami-only path restriction', () => {
    const text = traceAuthRecoveryMessage(
      JSON.stringify({
        secret_url: 'https://legacy.example/secrets/new?host=huggingface.co&path=%2Fapi%2Fwhoami-v2&name=HF',
      }),
      '401',
      false,
    );
    expect(text).toContain('https://legacy.example/secrets/new?host=huggingface.co&path=&name=HF');
    expect(text).toContain('OneCLI');
  });

  it('preserves legacy manage links and fallback instructions', () => {
    expect(
      traceAuthRecoveryMessage(JSON.stringify({ manage_url: 'https://legacy.example/manage' }), '401', false),
    ).toContain('https://legacy.example/manage');
    expect(traceAuthRecoveryMessage('not JSON', '401', false)).toContain('host pattern  huggingface.co');
  });
});

describe('poll loop — /upload-trace command', () => {
  it('handles the command in the runner, writes a status, skips query', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-upload-trace', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/upload-trace' }));

    // If the provider were ever queried it would emit this — asserting its
    // absence proves the runner intercepted /upload-trace instead of the LLM.
    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    await waitFor(() => getUndeliveredMessages().length > 0, 5000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // A status line from uploadTrace() — never the provider's reply.
    const text = JSON.parse(out[0].content).text as string;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('should not run');

    // Command message was completed (not left pending).
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
