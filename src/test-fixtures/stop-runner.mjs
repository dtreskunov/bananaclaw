import net from 'node:net';
import readline from 'node:readline';
import { initTestSessionDb, getInboundDb, getOutboundDb } from '../../container/agent-runner/src/db/connection.ts';
import { listPendingRunnerEvents } from '../../container/agent-runner/src/db/runner-state.ts';
import { getPendingMessages } from '../../container/agent-runner/src/db/messages-in.ts';
import { askUserQuestion } from '../../container/agent-runner/src/mcp-tools/interactive.ts';
import { runPollLoop } from '../../container/agent-runner/src/poll-loop.ts';
import { startSessionSignalClient, drainSessionJournal } from '../../container/agent-runner/src/session-link.ts';

// Keep the production singleton/client and protocol, redirecting only its socket address.
const connect = net.createConnection;
net.createConnection = function (...args) {
  if (args[0] === '/run/nanoclaw/runner.sock') args[0] = process.argv[2];
  return connect.apply(this, args);
};
initTestSessionDb({ unifiedHostProjection: true });
const report = (event) => process.stdout.write(`FIXTURE ${JSON.stringify(event)}\n`);
const controller = new AbortController();
let release;
const settlement = new Promise((resolve) => {
  release = resolve;
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'settle') release();
  if (line === 'finish') {
    controller.abort();
    release();
  }
});
let queries = 0;
const provider = {
  supportsNativeSlashCommands: false,
  isSessionInvalid: () => false,
  query(input) {
    const queryNumber = ++queries;
    const first = queryNumber === 1;
    let settleAnswer;
    const answerSettlement = new Promise((resolve) => {
      settleAnswer = resolve;
    });
    return {
      push: () => false,
      end() {},
      abort() {
        report({ kind: 'aborted', queryNumber, pending: getPendingMessages().map((row) => row.id) });
        if (queryNumber > 2) settleAnswer();
      },
      events: (async function* () {
        if (!first) {
          report({
            kind: queryNumber === 2 ? 'next' : 'answer',
            prompt: input.prompt,
            journalPending: listPendingRunnerEvents(getOutboundDb(), 100).length,
          });
          if (queryNumber === 2) {
            yield { type: 'result', text: 'Queued reply' };
            return;
          }
          await answerSettlement;
          controller.abort();
          return;
        }
        yield { type: 'init', continuation: 'cross-runtime-history' };
        const result = await askUserQuestion.handler({
          title: 'Continue?',
          question: 'Continue operation?',
          responseMode: 'choice',
          options: ['Yes', 'No'],
        });
        report({ kind: 'question', result });
        yield {
          type: 'usage_call',
          data: { model: 'fixture-model', input_tokens: 11, output_tokens: 2,
            cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.001 },
        };
        yield { type: 'progress', step: { kind: 'tool', id: 'tool-inflight', tool: 'write', status: 'running' } };
        await settlement;
        report({ kind: 'settled' });
        yield { type: 'result', text: 'This aborted response must not be delivered' };
      })(),
    };
  },
};

await startSessionSignalClient();
await runPollLoop({ provider, providerName: 'cross-runtime-stop', cwd: process.cwd(), signal: controller.signal });
await drainSessionJournal();
report({
  kind: 'done',
  inputs: getInboundDb().prepare('SELECT id FROM messages_in ORDER BY seq').all(),
  processing: getOutboundDb().prepare('SELECT message_id, status FROM processing_ack').all(),
});
process.exit(0);
