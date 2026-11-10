import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { isSafeAttachmentName, routeAgentMessage } from './agent-route.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import {
  createSession,
  findSessionByAgentGroup,
  getSession,
  getSessionsByAgentGroup,
  updateSession,
} from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { wakeContainer } from '../../container-runner.js';
import { countDueMessages } from '../../db/session-db.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: `${process.cwd()}/.test-state/nanoclaw-test-a2a-route` };
});

const TEST_DIR = `${process.cwd()}/.test-state/nanoclaw-test-a2a-route`;

function now(): number {
  return Date.now();
}

function readInbound(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db
    .prepare('SELECT id, platform_id, channel_type, content, source_session_id, trigger FROM messages_in ORDER BY seq')
    .all() as Array<{
    id: string;
    platform_id: string | null;
    channel_type: string | null;
    content: string;
    source_session_id: string | null;
    trigger: number;
  }>;
  db.close();
  return rows;
}

function readPeerInbound(groupId: string) {
  return getSessionsByAgentGroup(groupId).flatMap((session) =>
    readInbound(groupId, session.id)
      .filter((row) => row.channel_type === 'agent' && row.platform_id !== groupId)
      .map((row) => ({ ...row, sessionId: session.id })),
  );
}

describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('baby-duck.png')).toBe(true);
    expect(isSafeAttachmentName('file with spaces.pdf')).toBe(true);
    expect(isSafeAttachmentName('report.v2.docx')).toBe(true);
    expect(isSafeAttachmentName('.hidden')).toBe(true);
  });

  it('rejects empty / sentinel values', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeAttachmentName('../evil.png')).toBe(false);
    expect(isSafeAttachmentName('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('nested/file.txt')).toBe(false);
    expect(isSafeAttachmentName('windows\\path.exe')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeAttachmentName('clean\0.png')).toBe(false);
  });

  it('rejects anything path.basename would strip', () => {
    expect(isSafeAttachmentName('a/b')).toBe(false);
    expect(isSafeAttachmentName('./thing')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
  });
});

/**
 * Return-path routing: when an a2a reply targets an agent group with multiple
 * sessions, it must land in the *originating* session — not the newest one.
 *
 * Setup: agent A has two active sessions S1 (older) + S2 (newer).
 * Agent B is the peer A talks to. Bidirectional destinations wired.
 */
describe('routeAgentMessage return-path', () => {
  const A = 'ag-A';
  const B = 'ag-B';
  let S1: Session;
  let S2: Session;
  let SB: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });

    // S1 (older), S2 (newer) — both active sessions on A.
    S1 = {
      id: 'sess-A-old',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: 1767225600000,
    };
    S2 = {
      id: 'sess-A-new',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: 1769904000000,
    };
    SB = {
      id: 'sess-B',
      agent_group_id: B,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: 1768435200000,
    };
    createSession(S1);
    createSession(S2);
    createSession(SB);
    initSessionFolder(A, S1.id);
    initSessionFolder(A, S2.id);
    initSessionFolder(B, SB.id);

    createDestination({
      agent_group_id: A,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
      created_by: null,
    });
    createDestination({
      agent_group_id: B,
      local_name: 'a',
      target_type: 'agent',
      target_id: A,
      created_at: now(),
      created_by: null,
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('keeps an exchange together, separates the next request, and retains exact round-trip provenance', async () => {
    const request = (id: string, thread: string) => ({
      id,
      platform_id: B,
      thread_id: thread,
      in_reply_to: null,
      content: JSON.stringify({ text: id }),
    });
    const firstThread = 'a2a:turn-1:ag-B';
    await routeAgentMessage(request('first', firstThread), S1);
    await routeAgentMessage(request('file', firstThread), S1);
    await routeAgentMessage(request('second', 'a2a:turn-2:ag-B'), S1);
    const rows = readPeerInbound(B);
    const first = rows.find((row) => JSON.parse(row.content).text === 'first')!;
    const file = rows.find((row) => JSON.parse(row.content).text === 'file')!;
    const second = rows.find((row) => JSON.parse(row.content).text === 'second')!;
    expect(first.sessionId).toBe(file.sessionId);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(readInbound(B, SB.id)).toEqual([]);
    expect(findSessionByAgentGroup(B)?.id).toBe(SB.id);
    await expect(routeAgentMessage(request('wrong-source', firstThread), S2)).rejects.toThrow(
      'belongs to another source session',
    );
    const receiver = getSession(first.sessionId)!;
    await routeAgentMessage(
      {
        id: 'answer',
        platform_id: A,
        thread_id: firstThread,
        in_reply_to: first.id,
        content: '{"text":"Answer"}',
      },
      receiver,
    );
    const answer = readInbound(A, S1.id)[0];
    expect(answer.source_session_id).toBe(receiver.id);
    expect(readInbound(A, S2.id)).toEqual([]);
    await routeAgentMessage(
      {
        id: 'ack',
        platform_id: B,
        thread_id: firstThread,
        in_reply_to: answer.id,
        content: '{"text":"Thanks"}',
      },
      S1,
    );
    expect(readInbound(B, receiver.id)).toHaveLength(3);
    await expect(
      routeAgentMessage(
        {
          id: 'wrong-thread',
          platform_id: A,
          thread_id: 'a2a:another',
          in_reply_to: first.id,
          content: '{"text":"Wrong exchange"}',
        },
        receiver,
      ),
    ).rejects.toThrow('does not match');
  });

  it('forward direction: stamps source_session_id on the target inbound row', async () => {
    // A.S1 emits an outbound a2a to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'hello B' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPeerInbound(B);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].platform_id).toBe(A);
    expect(bRows[0].source_session_id).toBe(S1.id); // <- the return address
  });

  it('records terminal peer notices as context without waking either cold or warm runners', async () => {
    vi.mocked(wakeContainer).mockClear();
    for (const timelinePosition of [100, 200])
      await routeAgentMessage(
        {
          id: `error-${timelinePosition}`,
          platform_id: B,
          in_reply_to: null,
          content: JSON.stringify({
            text: 'Provider quota exhausted',
            delivery_origin: 'response',
            system_generated: true,
            timelinePosition,
          }),
        },
        S1,
      );
    const rows = readPeerInbound(B);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.trigger === 0)).toBe(true);
    expect(rows.every((row) => row.source_session_id === S1.id)).toBe(true);
    expect(JSON.parse(rows[0].content)).toMatchObject({ text: 'Provider quota exhausted', system_generated: true });
    expect(wakeContainer).not.toHaveBeenCalled();
    for (const row of rows) {
      const targetDb = new Database(inboundDbPath(B, row.sessionId), { readonly: true });
      try {
        expect(countDueMessages(targetDb)).toBe(0);
      } finally {
        targetDb.close();
      }
    }
  });

  it('still wakes for ordinary peer requests, even if they mention a provider error', async () => {
    vi.mocked(wakeContainer).mockClear();
    await routeAgentMessage(
      {
        id: 'real-request',
        platform_id: B,
        in_reply_to: null,
        content: JSON.stringify({ text: 'Please investigate this provider error', system_generated: false }),
      },
      S1,
    );
    expect(readPeerInbound(B)[0].trigger).toBe(1);
    expect(wakeContainer).toHaveBeenCalledOnce();
  });

  it('reply direction: routes back to the originating session, not the newest', async () => {
    // A.S1 sends to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'ping' }),
        in_reply_to: null,
      },
      S1,
    );

    // Capture the synthetic id the host stamped on B's inbound — that's what
    // B's container would reference as `in_reply_to` when replying.
    const bRows = readPeerInbound(B);
    const yId = bRows[0].id;

    // B replies to that message.
    await routeAgentMessage(
      {
        id: 'msg-from-B',
        platform_id: A,
        content: JSON.stringify({ text: 'pong' }),
        in_reply_to: yId,
      },
      getSession(bRows[0].sessionId)!,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);

    // The reply lands in S1 (originator) even though S2 is newer.
    expect(s1Rows).toHaveLength(1);
    expect(s1Rows[0].platform_id).toBe(B);
    expect(JSON.parse(s1Rows[0].content).text).toBe('pong');
    expect(s2Rows).toHaveLength(0);
  });

  it('routes a new peer request into a dedicated session instead of an existing user session', async () => {
    // No prior conversation. B initiates an a2a to A out of the blue.
    await routeAgentMessage(
      {
        id: 'msg-from-B-fresh',
        platform_id: A,
        content: JSON.stringify({ text: 'unsolicited' }),
        in_reply_to: null,
      },
      SB,
    );

    // Neither pre-existing session receives an unrelated peer request.
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    const peer = readPeerInbound(A);
    expect(peer).toHaveLength(1);
    expect(getSession(peer[0].sessionId)).toMatchObject({
      messaging_group_id: null,
      thread_id: 'a2a:msg-from-B-fresh:ag-A',
    });
  });

  it('does not infer reply affinity for an unthreaded group-level send', async () => {
    // A.S1 sends to B (establishing affinity: B's last contact from A was via S1).
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1-pre',
        platform_id: B,
        content: JSON.stringify({ text: 'context-establishing' }),
        in_reply_to: null,
      },
      S1,
    );

    // Without an explicit reply reference, the second message is a new
    // group-level delivery. Prior conversation history must not act as an
    // implicit return address.
    await routeAgentMessage(
      {
        id: 'msg-from-B-followup',
        platform_id: A,
        content: JSON.stringify({ text: 'standing by' }),
        in_reply_to: null,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    expect(JSON.parse(readPeerInbound(A)[0].content).text).toBe('standing by');
  });

  it('rejects a reply whose exact origin session is no longer active', async () => {
    // A.S1 sends to B, establishing source_session_id = S1.id on B's inbound.
    await routeAgentMessage(
      { id: 'msg-fwd', platform_id: B, content: JSON.stringify({ text: 'hello' }), in_reply_to: null },
      S1,
    );
    const bRows = readPeerInbound(B);
    const inboundId = bRows[0].id;

    // Close S1 — simulates session cleanup or channel disconnect.
    updateSession(S1.id, { status: 'closed' });

    await expect(
      routeAgentMessage(
        { id: 'msg-reply-stale', platform_id: A, content: JSON.stringify({ text: 'reply' }), in_reply_to: inboundId },
        getSession(bRows[0].sessionId)!,
      ),
    ).rejects.toThrow(`source session ${S1.id} is not active for ${A}`);

    expect(readInbound(A, S1.id)).toHaveLength(0);
    expect(readInbound(A, S2.id)).toHaveLength(0);
  });

  it('rejects a historical reply with no exact source-session provenance', async () => {
    writeSessionMessage(B, SB.id, {
      id: 'legacy-a2a',
      kind: 'chat',
      timestamp: now(),
      platformId: A,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text: 'legacy request' }),
      sourceSessionId: null,
    });

    await expect(
      routeAgentMessage(
        {
          id: 'msg-reply-legacy',
          platform_id: A,
          content: JSON.stringify({ text: 'reply' }),
          in_reply_to: 'legacy-a2a',
        },
        SB,
      ),
    ).rejects.toThrow('has no recorded source session');

    expect(readInbound(A, S1.id)).toHaveLength(0);
    expect(readInbound(A, S2.id)).toHaveLength(0);
  });

  it('rejects a dangling reply reference with unknown provenance', async () => {
    await expect(
      routeAgentMessage(
        {
          id: 'msg-dangling-reply',
          platform_id: A,
          content: JSON.stringify({ text: 'reply' }),
          in_reply_to: 'missing-inbound',
        },
        SB,
      ),
    ).rejects.toThrow('inbound missing-inbound was not found');

    expect(readInbound(A, S1.id)).toHaveLength(0);
    expect(readInbound(A, S2.id)).toHaveLength(0);
  });

  it('treats an inherited reply reference from another origin as a group-level send', async () => {
    // Third agent group C sends to B, stamping source_session_id = SC on B's inbound.
    const C = 'ag-C';
    createAgentGroup({ id: C, name: 'C', folder: 'c', agent_provider: null, created_at: now() });
    const SC: Session = {
      id: 'sess-C',
      agent_group_id: C,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: 1772323200000,
    };
    createSession(SC);
    initSessionFolder(C, SC.id);
    createDestination({
      agent_group_id: C,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
      created_by: null,
    });

    await routeAgentMessage(
      { id: 'msg-from-C', platform_id: B, content: JSON.stringify({ text: 'from C' }), in_reply_to: null },
      SC,
    );
    const bRows = readPeerInbound(B);
    const cInboundId = bRows.find((r) => r.platform_id === C)!.id;

    // B explicitly targets A while the inherited reply reference belongs to
    // C. The reference is unrelated to A, so this is a group-level send.
    await routeAgentMessage(
      {
        id: 'msg-reply-tamper',
        platform_id: A,
        content: JSON.stringify({ text: 'misdirected' }),
        in_reply_to: cInboundId,
      },
      getSession(bRows[0].sessionId)!,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    expect(readPeerInbound(A)).toHaveLength(1);
  });

  it('treats an inherited channel reply reference as a group-level send', async () => {
    // Write a channel message into B's inbound (no source_session_id).
    writeSessionMessage(B, SB.id, {
      id: 'channel-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'user-123',
      channelType: 'slack',
      threadId: null,
      content: 'hello from slack',
    });

    // The MCP tool inherits the current channel message id even though its
    // explicit destination is A. This is a group-level send, not a reply to A.
    await routeAgentMessage(
      {
        id: 'msg-reply-channel',
        platform_id: A,
        content: JSON.stringify({ text: 'response' }),
        in_reply_to: 'channel-msg-1',
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    expect(readPeerInbound(A)).toHaveLength(1);
  });

  it('self-message is allowed without a destination row', async () => {
    // A targets itself — no agent_destinations row exists for A→A.
    await routeAgentMessage(
      { id: 'self-msg', platform_id: A, content: JSON.stringify({ text: 'self-note' }), in_reply_to: null },
      S1,
    );

    // Lands in S2 (newest active session of A via resolveSession fallback).
    const s2Rows = readInbound(A, S2.id);
    expect(s2Rows).toHaveLength(1);
    expect(JSON.parse(s2Rows[0].content).text).toBe('self-note');
  });

  it('byte-identical squelch: drops a verbatim re-send to the same peer', async () => {
    // Seed one outbound a2a row in S1's messages_out targeting B. The
    // squelch reads messages_out (container-side writes) for the prior, so
    // we have to write it directly here — routeAgentMessage only writes to
    // the *target's* messages_in, not the source's messages_out.
    const sameContent = JSON.stringify({ text: '👍' });
    const outDb = new Database(path.join(sessionDir(A, S1.id), 'outbound.db'));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
         VALUES ('prior-ack', 1, 'chat', ?, ?, 'agent', NULL, ?)`,
      )
      .run(now(), B, sameContent);
    outDb.close();

    await routeAgentMessage({ id: 'duplicate-ack', platform_id: B, content: sameContent, in_reply_to: null }, S1);

    // Suppressed — nothing reaches B.
    expect(readPeerInbound(B)).toHaveLength(0);
  });

  it('byte-identical squelch: different content to the same peer goes through', async () => {
    const outDb = new Database(path.join(sessionDir(A, S1.id), 'outbound.db'));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
         VALUES ('prior', 1, 'chat', ?, ?, 'agent', NULL, ?)`,
      )
      .run(now(), B, JSON.stringify({ text: 'first thought' }));
    outDb.close();

    await routeAgentMessage(
      {
        id: 'substantive-followup',
        platform_id: B,
        content: JSON.stringify({ text: 'second thought, refined' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPeerInbound(B);
    expect(bRows).toHaveLength(1);
    expect(JSON.parse(bRows[0].content).text).toBe('second thought, refined');
  });

  it('BUG: no volume cap on a2a routing — unbounded ping-pong is allowed (#2063)', async () => {
    // Two agents can exchange unlimited messages with no rate limit or loop
    // detection. This test documents the gap — it should FAIL once #2063 lands.
    const errors: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        await routeAgentMessage(
          { id: `ping-${i}`, platform_id: B, content: JSON.stringify({ text: `ping ${i}` }), in_reply_to: null },
          S1,
        );
        await routeAgentMessage(
          { id: `pong-${i}`, platform_id: A, content: JSON.stringify({ text: `pong ${i}` }), in_reply_to: null },
          SB,
        );
      } catch (e) {
        errors.push((e as Error).message);
        break;
      }
    }
    // BUG: all 40 messages go through — no cap, no throttle.
    // Once loop prevention lands, this should throw or reject after a threshold.
    const bRows = readPeerInbound(B);
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(errors).toHaveLength(0);
    expect(bRows).toHaveLength(20);
    expect(s1Rows.length + s2Rows.length).toBe(0);
    expect(readPeerInbound(A)).toHaveLength(20);
  }, 20_000);

  it('file forwarding: copies bytes from source outbox to target inbox', async () => {
    // Place a file in S1's outbox for the message.
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-file');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'report.pdf'), 'fake-pdf-bytes');

    await routeAgentMessage(
      {
        id: 'msg-with-file',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['report.pdf'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPeerInbound(B);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('report.pdf');
    expect(parsed.attachments[0].type).toBe('file');

    // Verify actual file bytes were copied to the target inbox.
    const targetPath = path.join(sessionDir(B, bRows[0].sessionId), parsed.attachments[0].localPath);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('fake-pdf-bytes');
  });

  it('file forwarding: skips symlinked source files', async () => {
    const secretPath = path.join(TEST_DIR, 'host-secret.txt');
    fs.writeFileSync(secretPath, 'host-secret-bytes');

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-symlink');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.symlinkSync(secretPath, path.join(outboxDir, 'safe-name.txt'));

    await routeAgentMessage(
      {
        id: 'msg-with-symlink',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['safe-name.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readPeerInbound(B);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(0);
  });
});
