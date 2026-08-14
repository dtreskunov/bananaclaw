/**
 * Turn checkpoints are what make a thread forkable at full fidelity: without
 * a row here the host can only hand a branch a plain-text digest of its
 * inherited history. They're written on the ordinary turn path, so the way
 * they break is by quietly not being written at all — hence these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { loadConfig } from './config.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

const CONTINUATION = 'oc-session-1';

beforeEach(() => {
  initTestSessionDb();
  loadConfig();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

/** Emits one turn: init, an optional checkpoint, then the reply. */
class CheckpointingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  constructor(private readonly ref: string | null) {}

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: QueryInput): AgentQuery {
    const ref = this.ref;
    let ended = false;
    let waiting: (() => void) | null = null;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: CONTINUATION };
        if (ref) yield { type: 'checkpoint', ref };
        yield { type: 'result', text: '<message to="discord-test">done</message>' };
        while (!ended) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
      },
    };

    return {
      push: () => true,
      end: () => {
        ended = true;
        waiting?.();
      },
      events,
      abort: () => {
        ended = true;
        waiting?.();
      },
    };
  }
}

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

function checkpoints(): Array<Record<string, string>> {
  return getOutboundDb()
    .prepare('SELECT message_out_id, provider, continuation, provider_turn_ref FROM turn_checkpoints')
    .all() as Array<Record<string, string>>;
}

async function runTurn(provider: AgentProvider): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }),
    new Promise<void>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
  ]);
  const start = Date.now();
  while (getUndeliveredMessages().length === 0) {
    if (Date.now() - start > 2000) throw new Error('no reply');
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  await loop.catch(() => {});
}

describe('turn checkpoints', () => {
  it('anchors the turn to the outbound row the user can pick in the UI', async () => {
    insertMessage('m1', 'hello');
    await runTurn(new CheckpointingProvider('msg-anchor-1'));

    const [reply] = getUndeliveredMessages();
    expect(checkpoints()).toEqual([
      {
        message_out_id: reply!.id,
        provider: 'mock',
        continuation: CONTINUATION,
        provider_turn_ref: 'msg-anchor-1',
      },
    ]);
  });

  it('writes nothing for providers that have no branch point to offer', async () => {
    insertMessage('m1', 'hello');
    await runTurn(new CheckpointingProvider(null));

    expect(checkpoints()).toEqual([]);
  });
});
