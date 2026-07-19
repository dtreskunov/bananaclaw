/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage, sendFile } from './core.js';

let tmpDir: string;
const outboxRoot = '/workspace/outbox';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  // /workspace/outbox must exist and be writable. In CI / container test
  // runs this is the real mount; on a dev host, create it once with
  // `sudo install -d -o $USER /workspace/outbox` before running tests.
  fs.mkdirSync(outboxRoot, { recursive: true });
});

afterEach(() => {
  // Clean up any outbox dirs this test created so /workspace/outbox
  // doesn't accumulate cruft across runs.
  for (const m of getUndeliveredMessages()) {
    fs.rmSync(path.join(outboxRoot, m.id), { recursive: true, force: true });
  }
  clearCurrentInReplyTo();
  closeSessionDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
    expect(JSON.parse(out[0].content).delivery_origin).toBe('send_message');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_file MCP tool — multi-file batching', () => {
  it('writes one outbound message with multiple filenames when `paths` is used', async () => {
    const a = path.join(tmpDir, 'a.txt');
    const b = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(a, 'aaa');
    fs.writeFileSync(b, 'bbb');

    const result = await sendFile.handler({ to: 'peer', paths: [a, b], text: 'two files' });
    expect(result.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.text).toBe('two files');
    expect(content.files).toEqual(['a.txt', 'b.txt']);
    expect(content.delivery_origin).toBe('send_file');

    // Files are staged side-by-side in the outbox dir for the host to read.
    const outboxDir = path.join(outboxRoot, out[0].id);
    expect(fs.existsSync(path.join(outboxDir, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(outboxDir, 'b.txt'))).toBe(true);
  });

  it('still accepts the legacy `path` (single-file) form', async () => {
    const f = path.join(tmpDir, 'only.txt');
    fs.writeFileSync(f, 'x');

    await sendFile.handler({ to: 'peer', path: f });
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.files).toEqual(['only.txt']);
  });

  it('errors when neither path nor paths is provided', async () => {
    const result = await sendFile.handler({ to: 'peer' });
    expect(result.isError).toBe(true);
  });

  it('errors when a path does not exist', async () => {
    const result = await sendFile.handler({ to: 'peer', paths: [path.join(tmpDir, 'nope.txt')] });
    expect(result.isError).toBe(true);
  });
});
