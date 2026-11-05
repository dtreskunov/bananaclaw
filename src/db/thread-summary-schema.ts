const dirtySchema = `
CREATE TABLE IF NOT EXISTS thread_summary_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO thread_summary_clock VALUES (1, 0);
CREATE TABLE IF NOT EXISTS thread_summary_dirty (
  kind TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (kind, channel_type, platform_id, thread_id)
);
`;

function mark(kind: string, channel: string, platform: string, thread: string): string {
  return `
    UPDATE thread_summary_clock SET revision = revision + 1 WHERE id = 1;
    INSERT INTO thread_summary_dirty
      SELECT '${kind}', COALESCE(${channel}, ''), COALESCE(${platform}, ''), COALESCE(${thread}, ''), revision
      FROM thread_summary_clock WHERE id = 1
      ON CONFLICT(kind, channel_type, platform_id, thread_id) DO UPDATE SET revision=excluded.revision;
  `;
}

function track(table: string, kind: string, columns: string[], route: string[]): string {
  const key = (prefix: string) => route.map((column) => `${prefix}.${column}`);
  const notice = (prefix: string) => {
    const [channel, platform, thread] = key(prefix);
    return mark(kind, channel ?? "''", platform ?? "''", thread ?? "''");
  };
  return `
    CREATE TRIGGER IF NOT EXISTS thread_summary_${table}_insert AFTER INSERT ON ${table} BEGIN ${notice('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS thread_summary_${table}_delete AFTER DELETE ON ${table} BEGIN ${notice('OLD')} END;
    CREATE TRIGGER IF NOT EXISTS thread_summary_${table}_update AFTER UPDATE OF ${columns.join(', ')} ON ${table}
    WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}
    BEGIN ${notice('OLD')} ${notice('NEW')} END;
  `;
}

const route = ['channel_type', 'platform_id', 'thread_id'];
export const DROP_THREAD_SUMMARY_TRACKING =
  ['messages_in', 'thread_titles', 'messages_out', 'turn_usage', 'turns']
    .flatMap((table) =>
      ['insert', 'update', 'delete'].map((event) => `DROP TRIGGER IF EXISTS thread_summary_${table}_${event};`),
    )
    .join('\n') + 'DROP TABLE IF EXISTS thread_summary_dirty; DROP TABLE IF EXISTS thread_summary_clock;';
export const INBOUND_THREAD_SUMMARY_SCHEMA =
  dirtySchema +
  `CREATE INDEX IF NOT EXISTS idx_messages_in_summary ON messages_in(channel_type, COALESCE(platform_id,''), COALESCE(thread_id,''), seq, timestamp);` +
  track(
    'messages_in',
    'route',
    [...route, 'seq', 'timestamp', 'content', 'kind', 'status', 'process_after', 'recurrence', 'series_id', 'trigger'],
    route,
  ) +
  track('thread_titles', 'route', [...route, 'title'], route);

export const OUTBOUND_THREAD_SUMMARY_SCHEMA =
  dirtySchema +
  `CREATE INDEX IF NOT EXISTS idx_messages_out_summary ON messages_out(COALESCE(channel_type,''), COALESCE(platform_id,''), COALESCE(thread_id,''), kind, timestamp);
   CREATE INDEX IF NOT EXISTS idx_turns_summary ON turns(COALESCE(origin_channel_type,''), COALESCE(origin_platform_id,''), COALESCE(origin_thread_id,''), started_at);` +
  track('messages_out', 'route', [...route, 'kind', 'timestamp'], route) +
  track('turn_usage', 'usage', ['cost_usd', 'input_tokens', 'output_tokens'], []) +
  track(
    'turns',
    'turn',
    ['id', 'origin_channel_type', 'origin_platform_id', 'origin_thread_id', 'phase', 'started_at'],
    ['origin_channel_type', 'origin_platform_id', 'origin_thread_id'],
  );
