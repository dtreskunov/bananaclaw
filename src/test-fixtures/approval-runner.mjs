import net from 'node:net';
import readline from 'node:readline';
import { initTestSessionDb } from '../../container/agent-runner/src/db/connection.ts';
import { runPollLoop } from '../../container/agent-runner/src/poll-loop.ts';
import { drainSessionJournal, startSessionSignalClient } from '../../container/agent-runner/src/session-link.ts';

const connect = net.createConnection;
net.createConnection = function (...args) {
  if (args[0] === '/run/nanoclaw/runner.sock') args[0] = process.argv[2];
  return connect.apply(this, args);
};
initTestSessionDb({ unifiedHostProjection: true });

let wake;
let completed = false;
let ended = false;
const events = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'complete') completed = true;
  wake?.();
});
const provider = {
  supportsNativeSlashCommands: false,
  structuredReplies: true,
  supportsSteering: true,
  isSessionInvalid: () => false,
  query() {
    return {
      push: () => false,
      steer(input) {
        events.push({ type: 'steering_applied', id: input.id });
        wake?.();
        return true;
      },
      end() {
        ended = true;
        wake?.();
      },
      abort() {
        throw new Error('Approval must not abort the response');
      },
      events: (async function* () {
        yield { type: 'init', continuation: 'approval-test' };
        while (!ended) {
          if (events.length) yield events.shift();
          else if (completed) {
            completed = false;
            yield {
              type: 'result',
              text: 'Response finished normally.',
              replies: [{ text: 'Response finished normally.' }],
            };
          } else
            await new Promise((resolve) => {
              wake = resolve;
            });
        }
      })(),
    };
  },
};
await startSessionSignalClient();
await runPollLoop({ provider, providerName: 'approval-test', cwd: process.cwd() });
await drainSessionJournal();
process.exit(0);
