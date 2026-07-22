/**
 * Backfill the search index from existing per-session DBs.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-search-index.ts
 *
 * Rebuilds data/search.db from the authoritative central and per-session DBs.
 * Existing rows are cleared first so migrated session metadata is refreshed.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import {
  initSearchDb,
  closeSearchDb,
  clearSearchIndex,
  indexMessage,
  extractInboundText,
  extractOutboundText,
} from '../src/search-index.js';

const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
if (!fs.existsSync(sessionsDir)) {
  console.log('No sessions directory found — nothing to backfill.');
  process.exit(0);
}

const centralDbPath = path.join(DATA_DIR, 'v2.db');
if (!fs.existsSync(centralDbPath)) {
  console.error('Central DB not found at', centralDbPath);
  process.exit(1);
}
const centralDb = new Database(centralDbPath, { readonly: true });

initSearchDb();
clearSearchIndex();

let totalMessages = 0;
let totalSessions = 0;
let skippedSessions = 0;

for (const agentGroupId of fs.readdirSync(sessionsDir)) {
  const groupDir = path.join(sessionsDir, agentGroupId);
  if (!fs.statSync(groupDir).isDirectory()) continue;

  for (const sessionId of fs.readdirSync(groupDir)) {
    const sessionDir = path.join(groupDir, sessionId);
    if (!fs.statSync(sessionDir).isDirectory()) continue;

    const session = centralDb
      .prepare('SELECT agent_group_id, messaging_group_id, thread_id FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { agent_group_id: string; messaging_group_id: string | null; thread_id: string | null }
      | undefined;
    if (!session || session.agent_group_id !== agentGroupId) {
      skippedSessions++;
      continue;
    }
    const messagingGroupId = session.messaging_group_id;

    let sessionMsgCount = 0;

    // Index inbound messages.
    const inboundPath = path.join(sessionDir, 'inbound.db');
    if (fs.existsSync(inboundPath)) {
      try {
        const inDb = new Database(inboundPath, { readonly: true });
        inDb.pragma('busy_timeout = 5000');
        const rows = inDb
          .prepare(
            `SELECT id, kind, timestamp, channel_type, thread_id, content, sender_user_id
             FROM messages_in
             WHERE kind IN ('chat', 'chat-sdk')`,
          )
          .all() as Array<{
          id: string;
          kind: string;
          timestamp: string;
          channel_type: string | null;
          thread_id: string | null;
          content: string;
          sender_user_id: string | null;
        }>;
        for (const row of rows) {
          const text = extractInboundText(row.content);
          if (!text.trim()) continue;
          indexMessage({
            id: row.id,
            sessionId,
            agentGroupId,
            messagingGroupId,
            channelType: row.channel_type,
            threadId: row.thread_id ?? session?.thread_id ?? null,
            direction: 'in',
            timestamp: row.timestamp,
            text,
            senderUserId: row.sender_user_id ?? null,
          });
          sessionMsgCount++;
        }
        inDb.close();
      } catch (err) {
        console.error(`  Error reading inbound.db for session ${sessionId}:`, err);
      }
    }

    // Index outbound messages.
    const outboundPath = path.join(sessionDir, 'outbound.db');
    if (fs.existsSync(outboundPath)) {
      try {
        const outDb = new Database(outboundPath, { readonly: true });
        outDb.pragma('busy_timeout = 5000');
        const rows = outDb
          .prepare(
            `SELECT id, kind, timestamp, channel_type, thread_id, content
             FROM messages_out
             WHERE kind IN ('chat', 'text')`,
          )
          .all() as Array<{
          id: string;
          kind: string;
          timestamp: string;
          channel_type: string | null;
          thread_id: string | null;
          content: string;
        }>;
        for (const row of rows) {
          const text = extractOutboundText(row.content);
          if (!text.trim()) continue;
          indexMessage({
            id: row.id,
            sessionId,
            agentGroupId,
            messagingGroupId,
            channelType: row.channel_type,
            threadId: row.thread_id ?? session?.thread_id ?? null,
            direction: 'out',
            timestamp: row.timestamp,
            text,
          });
          sessionMsgCount++;
        }
        outDb.close();
      } catch (err) {
        console.error(`  Error reading outbound.db for session ${sessionId}:`, err);
      }
    }

    if (sessionMsgCount > 0) {
      totalSessions++;
      totalMessages += sessionMsgCount;
    }
  }
}

closeSearchDb();
centralDb.close();

console.log(`Backfill complete: indexed ${totalMessages} messages from ${totalSessions} sessions.`);
if (skippedSessions > 0) console.log(`Skipped ${skippedSessions} session directories absent from the central DB.`);
