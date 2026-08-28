import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { CONTAINER_IMAGE } from '../src/config.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../src/db/schema.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const runtime = process.env.CONTAINER_RUNTIME || 'docker';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-native-e2e-'));
const sessionDir = path.join(temp, 'session');
const groupDir = path.join(temp, 'group');
const containerName = `nanoclaw-native-e2e-${process.pid}`;

fs.mkdirSync(path.join(sessionDir, 'outbox'), { recursive: true });
fs.mkdirSync(groupDir, { recursive: true });
fs.chmodSync(sessionDir, 0o777);
fs.chmodSync(groupDir, 0o777);

const inboundPath = path.join(sessionDir, 'inbound.db');
const outboundPath = path.join(sessionDir, 'outbound.db');
const inbound = new Database(inboundPath);
inbound.pragma('journal_mode = DELETE');
inbound.exec(INBOUND_SCHEMA);
inbound
  .prepare(
    `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
   VALUES (1, 'test', 'native-e2e', NULL)`,
  )
  .run();
inbound
  .prepare(
    `INSERT INTO messages_in
     (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content)
   VALUES (?, 2, 'chat', ?, 'pending', 1, 'native-e2e', 'test', ?)`,
  )
  .run(
    'native-e2e-message',
    new Date().toISOString(),
    JSON.stringify({ sender: 'Native smoke test', text: 'Send the smoke-test message.' }),
  );
inbound.close();

const outbound = new Database(outboundPath);
outbound.pragma('journal_mode = DELETE');
outbound.exec(OUTBOUND_SCHEMA);
outbound.close();
fs.chmodSync(inboundPath, 0o666);
fs.chmodSync(outboundPath, 0o666);

fs.writeFileSync(
  path.join(groupDir, 'container.json'),
  JSON.stringify({
    provider: 'native',
    model: 'local/smoke-model',
    assistantName: 'Native Smoke',
    groupName: 'Native Smoke',
    agentGroupId: 'native-smoke',
    maxMessagesPerPrompt: 10,
    mcpServers: {},
    modelParams: {},
  }),
);
fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'Use the requested BananaClaw tool exactly once.\n');

let requestCount = 0;
const stub = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
  requestCount++;
  const hasToolResult = parsed.messages?.some((message) => message.role === 'tool') ?? false;
  const chunks = hasToolResult
    ? [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
        },
      ]
    : [
        {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'native-smoke-call',
                    type: 'function',
                    function: {
                      name: 'mcp__nanoclaw__send_message',
                      arguments: '{"text":"Native provider end-to-end smoke test passed."}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ];

  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks)
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${requestCount}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'smoke-model',
        ...chunk,
      })}\n\n`,
    );
  response.end('data: [DONE]\n\n');
});

await new Promise<void>((resolve) => stub.listen(0, '0.0.0.0', resolve));
const address = stub.address();
if (!address || typeof address === 'string') throw new Error('Could not bind native provider stub');

const args = [
  'run',
  '--rm',
  '--name',
  containerName,
  '--add-host=host.docker.internal:host-gateway',
  '-e',
  `NATIVE_BASE_URL=http://host.docker.internal:${address.port}/v1`,
  '-e',
  'NO_PROXY=host.docker.internal,127.0.0.1,localhost',
  '-v',
  `${sessionDir}:/workspace`,
  '-v',
  `${groupDir}:/workspace/agent`,
  '-v',
  `${path.join(ROOT, 'container/agent-runner/src')}:/app/src:ro`,
  '-v',
  `${path.join(ROOT, 'container/skills')}:/app/skills:ro`,
  '-v',
  `${path.join(ROOT, 'container/CLAUDE.md')}:/app/CLAUDE.md:ro`,
  CONTAINER_IMAGE,
];

const child = spawn(runtime, args, { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end('{}');
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  logs += chunk.toString();
});

try {
  const deadline = Date.now() + 30_000;
  let passed = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const db = new Database(outboundPath, { readonly: true });
      try {
        const message = db
          .prepare("SELECT content FROM messages_out WHERE kind = 'chat' ORDER BY seq LIMIT 1")
          .get() as { content: string } | undefined;
        const ack = db.prepare("SELECT status FROM processing_ack WHERE message_id = 'native-e2e-message'").get() as
          | { status: string }
          | undefined;
        const usage = db.prepare('SELECT COUNT(*) AS count FROM turn_usage').get() as { count: number };
        const checkpoints = db.prepare('SELECT COUNT(*) AS count FROM turn_checkpoints').get() as { count: number };
        if (message && ack?.status === 'completed' && usage.count > 0 && checkpoints.count > 0) {
          const text = (JSON.parse(message.content) as { text?: string }).text;
          if (text !== 'Native provider end-to-end smoke test passed.') {
            throw new Error(`Unexpected outbound text: ${text}`);
          }
          passed = true;
          break;
        }
      } finally {
        db.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such table|database is locked|unable to open database/i.test(message)) throw error;
    }
  }

  if (!passed) throw new Error(`Native provider smoke test timed out.\n${logs.slice(-4000)}`);
  if (!fs.existsSync(path.join(sessionDir, 'native-state.db'))) {
    throw new Error('native-state.db was not created');
  }
  console.log('Native provider E2E passed: container → Chat stream → built-in tool → outbound DB.');
} finally {
  await new Promise<void>((resolve) => {
    const cleanup = spawn(runtime, ['rm', '-f', containerName]);
    cleanup.on('close', () => resolve());
    cleanup.on('error', () => resolve());
  });
  stub.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
