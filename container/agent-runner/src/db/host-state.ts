import { getOutboundDb } from './connection.js';

const MAX_ID_CHARS = 256;
const MAX_OUTPUT_BYTES = Number.parseInt(process.env.NANOCLAW_MAX_OUTPUT_BYTES || '10485760', 10);
const MAX_DESTINATIONS = 512;

export interface HostEventFrame {
  eventId: string;
  sequence: number;
  event: { type: string; payload: unknown };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function text(value: unknown, max = MAX_ID_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function nullableText(value: unknown, max = MAX_ID_CHARS): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function decodeContent(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid host message content');
  }
  const content = Buffer.from(value, 'base64');
  if (content.length > MAX_OUTPUT_BYTES || content.toString('base64') !== value) {
    throw new Error('invalid host message content');
  }
  return content.toString('utf8');
}

function applyMessage(payload: Record<string, unknown>): void {
  const keys = [
    'id',
    'seq',
    'kind',
    'timestamp',
    'status',
    'process_after',
    'recurrence',
    'series_id',
    'tries',
    'trigger',
    'platform_id',
    'channel_type',
    'thread_id',
    'content_base64',
    'source_session_id',
    'on_wake',
    'sender_user_id',
    'sender_identity',
  ];
  if (
    !exactKeys(payload, keys) ||
    !text(payload.id) ||
    !Number.isSafeInteger(payload.seq) ||
    Number(payload.seq) <= 0 ||
    Number(payload.seq) % 2 !== 0 ||
    !text(payload.kind, 64) ||
    !text(payload.timestamp, 128) ||
    !['pending', 'processing', 'processed', 'completed', 'failed', 'paused'].includes(String(payload.status)) ||
    !nullableText(payload.process_after, 128) ||
    !nullableText(payload.recurrence, 1024) ||
    !nullableText(payload.series_id) ||
    !Number.isSafeInteger(payload.tries) ||
    Number(payload.tries) < 0 ||
    !(payload.trigger === 0 || payload.trigger === 1) ||
    !nullableText(payload.platform_id, 1024) ||
    !nullableText(payload.channel_type, 64) ||
    !nullableText(payload.thread_id, 1024) ||
    !nullableText(payload.source_session_id) ||
    !(payload.on_wake === 0 || payload.on_wake === 1) ||
    !nullableText(payload.sender_user_id) ||
    !nullableText(payload.sender_identity, 1024)
  ) {
    throw new Error('invalid host message payload');
  }
  const content = decodeContent(payload.content_base64);
  getOutboundDb()
    .prepare(
      `INSERT INTO messages_in
        (id, seq, kind, timestamp, status, process_after, recurrence, series_id,
         tries, trigger, platform_id, channel_type, thread_id, content,
         source_session_id, on_wake, sender_user_id, sender_identity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, kind=excluded.kind,
         timestamp=excluded.timestamp, status=excluded.status,
         process_after=excluded.process_after, recurrence=excluded.recurrence,
         series_id=excluded.series_id, tries=excluded.tries, trigger=excluded.trigger,
         platform_id=excluded.platform_id, channel_type=excluded.channel_type,
         thread_id=excluded.thread_id, content=excluded.content,
         source_session_id=excluded.source_session_id, on_wake=excluded.on_wake,
         sender_user_id=excluded.sender_user_id, sender_identity=excluded.sender_identity`,
    )
    .run(
      payload.id as string,
      Number(payload.seq),
      payload.kind as string,
      payload.timestamp as string,
      payload.status as string,
      payload.process_after as string | null,
      payload.recurrence as string | null,
      payload.series_id as string | null,
      Number(payload.tries),
      Number(payload.trigger),
      payload.platform_id as string | null,
      payload.channel_type as string | null,
      payload.thread_id as string | null,
      content,
      payload.source_session_id as string | null,
      Number(payload.on_wake),
      payload.sender_user_id as string | null,
      payload.sender_identity as string | null,
    );
}

function applyDestinations(payload: Record<string, unknown>): void {
  if (!exactKeys(payload, ['entries']) || !Array.isArray(payload.entries) || payload.entries.length > MAX_DESTINATIONS) {
    throw new Error('invalid destinations payload');
  }
  const rows = payload.entries.map((value): {
    name: string;
    display_name: string | null;
    type: string;
    channel_type: string | null;
    platform_id: string | null;
    agent_group_id: string | null;
  } => {
    const row = record(value);
    if (
      !row ||
      !exactKeys(row, ['name', 'display_name', 'type', 'channel_type', 'platform_id', 'agent_group_id']) ||
      !text(row.name) ||
      !nullableText(row.display_name) ||
      !['channel', 'agent'].includes(String(row.type)) ||
      !nullableText(row.channel_type, 64) ||
      !nullableText(row.platform_id, 1024) ||
      !nullableText(row.agent_group_id)
    ) {
      throw new Error('invalid destination row');
    }
    return {
      name: row.name as string,
      display_name: row.display_name as string | null,
      type: row.type as string,
      channel_type: row.channel_type as string | null,
      platform_id: row.platform_id as string | null,
      agent_group_id: row.agent_group_id as string | null,
    };
  });
  const db = getOutboundDb();
  db.prepare('DELETE FROM destinations').run();
  const insert = db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.name, row.display_name, row.type, row.channel_type, row.platform_id, row.agent_group_id);
  }
}

function applyRouting(payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['channel_type', 'platform_id', 'thread_id']) ||
    !nullableText(payload.channel_type, 64) ||
    !nullableText(payload.platform_id, 1024) ||
    !nullableText(payload.thread_id, 1024)
  ) {
    throw new Error('invalid routing payload');
  }
  getOutboundDb()
    .prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET channel_type=excluded.channel_type,
         platform_id=excluded.platform_id, thread_id=excluded.thread_id`,
    )
    .run(payload.channel_type, payload.platform_id, payload.thread_id);
}

function applyFork(payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['id', 'parent_session_id', 'parent_continuation', 'provider', 'anchor_ref', 'digest', 'created_at']) ||
    payload.id !== 1 ||
    !text(payload.parent_session_id) ||
    !nullableText(payload.parent_continuation, MAX_OUTPUT_BYTES) ||
    !text(payload.provider) ||
    !nullableText(payload.anchor_ref, MAX_OUTPUT_BYTES) ||
    !text(payload.digest, MAX_OUTPUT_BYTES) ||
    !text(payload.created_at, 128)
  ) {
    throw new Error('invalid fork payload');
  }
  getOutboundDb()
    .prepare(
      `INSERT INTO fork_origin
        (id, parent_session_id, parent_continuation, provider, anchor_ref, digest, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET parent_session_id=excluded.parent_session_id,
         parent_continuation=excluded.parent_continuation, provider=excluded.provider,
         anchor_ref=excluded.anchor_ref, digest=excluded.digest, created_at=excluded.created_at`,
    )
    .run(
      payload.parent_session_id,
      payload.parent_continuation,
      payload.provider,
      payload.anchor_ref,
      payload.digest,
      payload.created_at,
    );
}

function applyThreadTitle(payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, [
      'channel_type',
      'platform_id',
      'thread_id',
      'title',
      'source',
      'request_message_id',
      'published',
      'updated_at',
    ]) ||
    !text(payload.channel_type, 64) ||
    typeof payload.platform_id !== 'string' ||
    payload.platform_id.length > 1024 ||
    typeof payload.thread_id !== 'string' ||
    payload.thread_id.length > 1024 ||
    !text(payload.title, 60) ||
    !text(payload.source, 64) ||
    !text(payload.request_message_id) ||
    !(payload.published === 0 || payload.published === 1) ||
    !text(payload.updated_at, 128)
  ) {
    throw new Error('invalid thread title payload');
  }
  getOutboundDb()
    .prepare(
      `INSERT INTO thread_titles
        (channel_type, platform_id, thread_id, title, source, request_message_id, published, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_type, platform_id, thread_id) DO UPDATE SET
         title=excluded.title, source=excluded.source,
         request_message_id=excluded.request_message_id,
         published=excluded.published, updated_at=excluded.updated_at`,
    )
    .run(
      payload.channel_type as string,
      payload.platform_id as string,
      payload.thread_id as string,
      payload.title as string,
      payload.source as string,
      payload.request_message_id as string,
      Number(payload.published),
      payload.updated_at as string,
    );
}

export function applyHostEvent(frame: HostEventFrame): boolean {
  if (!text(frame.eventId) || !Number.isSafeInteger(frame.sequence) || frame.sequence <= 0) {
    throw new Error('invalid host event envelope');
  }
  const payload = record(frame.event.payload);
  if (!payload || !text(frame.event.type, 64)) throw new Error('invalid host event');

  const db = getOutboundDb();
  return db.transaction(() => {
    const lastSequence = (
      db.prepare('SELECT last_sequence FROM applied_host_events WHERE id = 1').get() as { last_sequence: number }
    ).last_sequence;
    if (frame.sequence <= lastSequence) return false;
    if (frame.sequence !== lastSequence + 1) throw new Error('out-of-order host event');

    switch (frame.event.type) {
      case 'message.upsert':
        applyMessage(payload);
        break;
      case 'message.delete':
        if (!exactKeys(payload, ['id']) || !text(payload.id)) throw new Error('invalid message delete payload');
        db.prepare('DELETE FROM messages_in WHERE id = ?').run(payload.id);
        break;
      case 'destinations.replace':
        applyDestinations(payload);
        break;
      case 'routing.upsert':
        applyRouting(payload);
        break;
      case 'fork.upsert':
        applyFork(payload);
        break;
      case 'thread-title.upsert':
        applyThreadTitle(payload);
        break;
      case 'thread-title.delete':
        if (
          !exactKeys(payload, ['channel_type', 'platform_id', 'thread_id']) ||
          !text(payload.channel_type, 64) ||
          typeof payload.platform_id !== 'string' ||
          payload.platform_id.length > 1024 ||
          typeof payload.thread_id !== 'string' ||
          payload.thread_id.length > 1024
        ) {
          throw new Error('invalid thread title delete payload');
        }
        db.prepare('DELETE FROM thread_titles WHERE channel_type = ? AND platform_id = ? AND thread_id = ?').run(
          payload.channel_type as string,
          payload.platform_id as string,
          payload.thread_id as string,
        );
        break;
      case 'sequence.floor':
        if (!exactKeys(payload, ['seq']) || !Number.isSafeInteger(payload.seq) || Number(payload.seq) < 0) {
          throw new Error('invalid sequence floor payload');
        }
        db.prepare(
          `INSERT INTO host_state (key, value) VALUES ('sequence_floor', ?)
           ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
        ).run(String(payload.seq));
        break;
      default:
        throw new Error(`unknown host event type: ${frame.event.type}`);
    }
    db.prepare('UPDATE applied_host_events SET last_sequence = ? WHERE id = 1').run(frame.sequence);
    return true;
  })();
}
