/**
 * Thread forking: branch a conversation at a chosen message into a new
 * per-thread session that inherits the history up to that point.
 *
 * Ordering is load-bearing. The session directory and both DBs are created,
 * fully populated, and only *then* is the `sessions` row inserted. Nothing can
 * spawn a container for a session that has no row, which makes the host the
 * provably-sole writer of the new outbound.db during the copy — the
 * one-writer-per-file invariant holds without locking against the container
 * side. See the header of session-manager.ts.
 *
 * The parent's DBs are only ever read, so forking a thread whose container is
 * mid-turn is safe.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { resolveProviderName } from './container-runner.js';
import { getContainerConfig } from './db/container-configs.js';
import { createSession } from './db/sessions.js';
import { createThreadFork } from './db/thread-forks.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { extractInboundText, extractOutboundText } from './search-index.js';
import {
  initSessionFolder,
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { Session } from './types.js';

/** Message kinds that must never be inherited — a copied task would double-fire. */
const EXCLUDED_INBOUND_KINDS = new Set(['task']);

/** Outbound kinds that carry displayable conversation text. */
const CHAT_OUT_KINDS = new Set(['chat', 'text', 'chat-sdk']);

/** Character budget for the digest handed to a cold provider session. */
const DIGEST_MAX_CHARS = 24_000;

export interface ForkThreadInput {
  agentGroupId: string;
  messagingGroupId: string;
  channelType: string;
  /** Session backing the thread being forked. */
  parentSession: Session;
  parentThreadId: string;
  /** Public message id as rendered in the UI (inbound ids are un-namespaced there). */
  anchorMessageId: string;
  /** Thread id for the fork. Caller generates it so it can route the client immediately. */
  newThreadId: string;
  parentTitle: string | null;
}

export interface ForkThreadResult {
  sessionId: string;
  threadId: string;
  copiedIn: number;
  copiedOut: number;
  /** Fidelity the fork is *expected* to reach; the container reports what it actually got. */
  fidelity: 'native' | 'transcript';
}

export class ForkError extends Error {}

type Row = Record<string, unknown>;

/**
 * Milliseconds for a session-DB timestamp. The two DBs are written by
 * different processes in different formats — the host stores ISO
 * (`2026-01-01T00:00:00.000Z`), the container stores SQLite's `datetime('now')`
 * (`2026-01-01 00:00:00`, UTC, whole seconds). Comparing those as strings is
 * wrong in both directions ('T' sorts after ' '), so every cut goes through
 * here. Same normalization the chat history reader uses to interleave them.
 */
function tsMs(s: string): number {
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}

/**
 * Locate the anchor and return its timestamp. History is merged from both DBs
 * and ordered by timestamp (readChatHistory), so timestamp — not seq — is the
 * cut that matches what the user saw when they picked the message.
 */
function findAnchor(
  inDb: Database.Database,
  outDb: Database.Database,
  agentGroupId: string,
  channelType: string,
  threadId: string,
  anchorMessageId: string,
): { timestamp: string; direction: 'in' | 'out' } {
  // The router namespaces inbound ids as `<rawId>:<agentGroupId>`; the UI
  // renders the raw form. Accept either.
  const namespaced = `${anchorMessageId}:${agentGroupId}`;
  const inRow = inDb
    .prepare(
      'SELECT timestamp FROM messages_in WHERE (id = ? OR id = ?) AND channel_type = ? AND thread_id = ? LIMIT 1',
    )
    .get(anchorMessageId, namespaced, channelType, threadId) as { timestamp: string } | undefined;
  if (inRow) return { timestamp: inRow.timestamp, direction: 'in' };

  const outRow = outDb
    .prepare('SELECT timestamp FROM messages_out WHERE id = ? AND channel_type = ? AND thread_id = ? LIMIT 1')
    .get(anchorMessageId, channelType, threadId) as { timestamp: string } | undefined;
  if (outRow) return { timestamp: outRow.timestamp, direction: 'out' };

  throw new ForkError('anchor_not_found');
}

/** Copy a per-message attachment directory (`inbox/<id>` or `outbox/<id>`). */
function copyMessageDir(srcDir: string, dstDir: string, kind: 'inbox' | 'outbox', messageId: string): void {
  const src = path.join(srcDir, kind, messageId);
  if (!fs.existsSync(src)) return;
  try {
    // Skip symlinks rather than following them: attachment dirs are
    // agent-writable, and a fork must not become a way to pull files in from
    // outside the session tree.
    fs.cpSync(src, path.join(dstDir, kind, messageId), {
      recursive: true,
      filter: (s) => !fs.lstatSync(s).isSymbolicLink(),
    });
  } catch (err) {
    log.warn('Fork: failed to copy attachment dir', { kind, messageId, err });
  }
}

function insertRows(db: Database.Database, table: string, rows: Row[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  );
  const run = db.transaction((batch: Row[]) => {
    for (const row of batch) stmt.run(row);
  });
  run(rows);
}

/** Best-effort copy of rows keyed by `message_out_id` from a table that may not exist. */
function copyOutboundSidecar(src: Database.Database, dst: Database.Database, table: string, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const rows = src
      .prepare(`SELECT * FROM ${table} WHERE message_out_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Row[];
    insertRows(dst, table, rows);
  } catch (err) {
    log.debug('Fork: sidecar table not copied', { table, err });
  }
}

/**
 * Render the inherited conversation as markdown. Always produced, even when a
 * native provider fork is expected — it is what the container falls back to
 * whenever the native path turns out to be unavailable at boot.
 */
function buildDigest(parts: { direction: 'in' | 'out'; text: string }[], parentTitle: string | null): string {
  const header = parentTitle
    ? `# Earlier conversation (branched from "${parentTitle}")`
    : '# Earlier conversation (branched from another thread)';
  const lines: string[] = [];
  let budget = DIGEST_MAX_CHARS;
  // Walk newest-first so the tail — the part the branch actually depends on —
  // is what survives truncation.
  for (let i = parts.length - 1; i >= 0; i--) {
    const text = parts[i].text.trim();
    if (!text) continue;
    const line = `**${parts[i].direction === 'in' ? 'User' : 'Assistant'}:** ${text}`;
    if (line.length > budget) {
      lines.push('_(earlier messages omitted)_');
      break;
    }
    budget -= line.length;
    lines.push(line);
  }
  lines.reverse();
  return `${header}\n\n${lines.join('\n\n')}\n`;
}

/**
 * Fork `parentSession`'s thread at `anchorMessageId` into a fresh session.
 * Throws `ForkError` with a caller-mappable code.
 */
export function forkThread(input: ForkThreadInput): ForkThreadResult {
  const {
    agentGroupId,
    messagingGroupId,
    channelType,
    parentSession,
    parentThreadId,
    anchorMessageId,
    newThreadId,
    parentTitle,
  } = input;

  // The service unit doesn't load .env, so the env default has to be read
  // from the file the way the container runner reads it — otherwise a group
  // that inherits its provider from DEFAULT_PROVIDER forks as 'claude' and
  // finds no continuation to branch from.
  const provider = resolveProviderName(
    parentSession.agent_provider,
    getContainerConfig(agentGroupId)?.provider,
    process.env.DEFAULT_PROVIDER ?? readEnvFile(['DEFAULT_PROVIDER']).DEFAULT_PROVIDER,
  );

  let inRows: Row[] = [];
  let outRows: Row[] = [];
  let titleRow: Row | undefined;
  let parentContinuation: string | null = null;
  let anchorRef: string | null = null;
  let cutTs = '';
  const digestParts: { direction: 'in' | 'out'; timestamp: string; text: string }[] = [];

  const srcIn = openInboundDb(agentGroupId, parentSession.id);
  const srcOut = openOutboundDb(agentGroupId, parentSession.id);
  try {
    const anchor = findAnchor(srcIn, srcOut, agentGroupId, channelType, parentThreadId, anchorMessageId);
    cutTs = anchor.timestamp;
    const cutMs = tsMs(cutTs);
    // Outbound timestamps have whole-second resolution, so a reply written in
    // the same second as the inbound message it answers looks simultaneous.
    // When the user branches at their own message, resolve that ambiguity the
    // only way that can be right: the reply came after.
    const keepOut = (r: Row): boolean => {
      const ms = tsMs(String(r.timestamp));
      return anchor.direction === 'in' && Math.floor(cutMs / 1000) === Math.floor(ms / 1000) ? false : ms <= cutMs;
    };

    inRows = (
      srcIn
        .prepare(
          `SELECT * FROM messages_in
            WHERE channel_type = ? AND thread_id = ?
            ORDER BY seq`,
        )
        .all(channelType, parentThreadId) as Row[]
    ).filter((r) => !EXCLUDED_INBOUND_KINDS.has(String(r.kind)) && tsMs(String(r.timestamp)) <= cutMs);

    outRows = (
      srcOut
        .prepare(
          `SELECT * FROM messages_out
          WHERE channel_type = ? AND thread_id = ?
          ORDER BY seq`,
        )
        .all(channelType, parentThreadId) as Row[]
    ).filter(keepOut);

    if (inRows.length === 0 && outRows.length === 0) throw new ForkError('nothing_to_fork');

    for (const r of inRows) {
      digestParts.push({
        direction: 'in',
        timestamp: String(r.timestamp),
        text: extractInboundText(String(r.content)),
      });
    }
    for (const r of outRows) {
      if (!CHAT_OUT_KINDS.has(String(r.kind))) continue;
      digestParts.push({
        direction: 'out',
        timestamp: String(r.timestamp),
        text: extractOutboundText(String(r.content)),
      });
    }
    digestParts.sort((a, b) => tsMs(a.timestamp) - tsMs(b.timestamp));

    // A fork inherits the parent's title. The container only requests a title
    // when the thread's first chat message is in the batch it is processing,
    // and a fork's first message is inherited (already acked) — so without
    // this the branch would stay permanently untitled in the rail.
    titleRow = srcIn
      .prepare('SELECT * FROM thread_titles WHERE channel_type = ? AND thread_id = ? LIMIT 1')
      .get(channelType, parentThreadId) as Row | undefined;

    try {
      const row = srcOut.prepare('SELECT value FROM session_state WHERE key = ?').get(`continuation:${provider}`) as
        | { value: string }
        | undefined;
      parentContinuation = row?.value ?? null;
    } catch {
      // No continuation recorded for this provider — digest path.
    }

    // Provider-native anchor for the branch point, written per turn by the
    // container. Absent for providers that don't checkpoint, and absent on
    // sessions predating the table — both degrade to the digest.
    if (parentContinuation && outRows.length > 0) {
      try {
        const ids = outRows.map((r) => String(r.id));
        const row = srcOut
          .prepare(
            `SELECT provider_turn_ref FROM turn_checkpoints
              WHERE message_out_id IN (${ids.map(() => '?').join(',')}) AND continuation = ?
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get(...ids, parentContinuation) as { provider_turn_ref: string } | undefined;
        anchorRef = row?.provider_turn_ref ?? null;
      } catch {
        // turn_checkpoints not present on this outbound.db.
      }
    }
  } finally {
    srcIn.close();
    srcOut.close();
  }

  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  initSessionFolder(agentGroupId, sessionId);

  const fidelity: 'native' | 'transcript' = parentContinuation && anchorRef ? 'native' : 'transcript';
  const digest = buildDigest(digestParts, parentTitle);
  const now = new Date().toISOString();

  try {
    populateForkSession({
      agentGroupId,
      sessionId,
      parentSessionId: parentSession.id,
      newThreadId,
      inRows,
      outRows,
      titleRow,
      digest,
      provider,
      parentContinuation,
      anchorRef,
      createdAt: now,
    });
  } catch (err) {
    // Nothing references the half-built session yet (no `sessions` row), so
    // the directory is safe to remove outright.
    fs.rmSync(sessionDir(agentGroupId, sessionId), { recursive: true, force: true });
    throw err;
  }

  const session: Session = {
    id: sessionId,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: newThreadId,
    agent_provider: parentSession.agent_provider,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now,
  };
  createSession(session);
  writeSessionRouting(agentGroupId, sessionId);

  createThreadFork({
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: newThreadId,
    parent_thread_id: parentThreadId,
    parent_message_id: anchorMessageId,
    parent_message_ts: cutTs,
    parent_title: parentTitle,
    fidelity,
    created_at: now,
  });

  log.info('Thread forked', {
    agentGroupId,
    parentSessionId: parentSession.id,
    sessionId,
    threadId: newThreadId,
    copiedIn: inRows.length,
    copiedOut: outRows.length,
    fidelity,
  });

  return { sessionId, threadId: newThreadId, copiedIn: inRows.length, copiedOut: outRows.length, fidelity };
}

function populateForkSession(args: {
  agentGroupId: string;
  sessionId: string;
  parentSessionId: string;
  newThreadId: string;
  inRows: Row[];
  outRows: Row[];
  titleRow: Row | undefined;
  digest: string;
  provider: string;
  parentContinuation: string | null;
  anchorRef: string | null;
  createdAt: string;
}): void {
  const { agentGroupId, sessionId, parentSessionId, newThreadId, inRows, outRows, digest } = args;

  // Inherited rows keep their original ids: ids are unique within a session
  // file, and keeping them lets `[[msg:id|thread]]` references resolve the
  // same way in both threads. Only thread_id is rewritten.
  const rethread = (rows: Row[]): Row[] => rows.map((r) => ({ ...r, thread_id: newThreadId }));

  const dstIn = openInboundDb(agentGroupId, sessionId);
  try {
    // trigger=0 so inherited history is never counted as work waiting to wake
    // a container.
    insertRows(
      dstIn,
      'messages_in',
      rethread(inRows).map((r) => ({ ...r, trigger: 0 })),
    );

    // Without a `delivered` row per inherited outbound message the delivery
    // poller would re-send the entire copied history to the channel.
    insertRows(
      dstIn,
      'delivered',
      outRows.map((r) => ({
        message_out_id: String(r.id),
        platform_message_id: null,
        status: 'inherited',
        delivered_at: args.createdAt,
      })),
    );

    if (args.titleRow) {
      insertRows(dstIn, 'thread_titles', [
        { ...args.titleRow, thread_id: newThreadId, source: 'fork', published: 1, updated_at: args.createdAt },
      ]);
    }

    dstIn
      .prepare(
        `INSERT INTO fork_origin
           (id, parent_session_id, parent_continuation, provider, anchor_ref, digest, created_at)
         VALUES (1, @parent_session_id, @parent_continuation, @provider, @anchor_ref, @digest, @created_at)`,
      )
      .run({
        parent_session_id: parentSessionId,
        parent_continuation: args.parentContinuation,
        provider: args.provider,
        anchor_ref: args.anchorRef,
        digest,
        created_at: args.createdAt,
      });
  } finally {
    dstIn.close();
  }

  const srcOut = openOutboundDb(agentGroupId, parentSessionId);
  const dstOut = openOutboundDbRw(agentGroupId, sessionId);
  try {
    insertRows(dstOut, 'messages_out', rethread(outRows));

    // Mark inherited inbound rows as already handled so the fork's first
    // container doesn't replay the whole history as fresh work.
    insertRows(
      dstOut,
      'processing_ack',
      inRows.map((r) => ({ message_id: String(r.id), status: 'completed', status_changed: args.createdAt })),
    );

    const outIds = outRows.map((r) => String(r.id));
    copyOutboundSidecar(srcOut, dstOut, 'turn_usage', outIds);
    copyOutboundSidecar(srcOut, dstOut, 'turn_activity', outIds);
  } finally {
    srcOut.close();
    dstOut.close();
  }

  const srcDir = sessionDir(agentGroupId, parentSessionId);
  const dstDir = sessionDir(agentGroupId, sessionId);
  for (const r of inRows) copyMessageDir(srcDir, dstDir, 'inbox', String(r.id));
  for (const r of outRows) copyMessageDir(srcDir, dstDir, 'outbox', String(r.id));
}
