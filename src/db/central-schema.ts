import { EPOCH_NOW_SQL } from './storage-lifecycle.js';

/** Applied-name identities covered by the baseline, without replaying their implementations. */
export const CENTRAL_BASELINE_MIGRATION_NAMES = [
  'initial-v2-schema',
  'chat-sdk-state',
  'agent-destinations',
  'agent-destinations-created-by',
  'dropped-messages',
  'drop-pending-credentials',
  'engage-modes',
  'pending-sender-approvals',
  'channel-registration',
  'approval-render-metadata',
  'container-configs',
  'cli-scope',
  'ui',
  'ui-download-tokens',
  'identities',
  'web-identities',
  'oidc-and-approvals',
  'identity-link-challenges',
  'push-subscriptions',
  'unregistered-senders-uuid',
  'pending-user-approvals-partial-unique',
  'site-website',
  'user-onboarded',
  'messaging-group-instance',
  'shared-web-chats',
  'shared-web-destinations',
  'ui-private-web-sessions',
  'agent-email',
  'thread-forks',
  'resend-thread-roots',
  'container-configs-pip',
  'container-configs-voice-mode',
  'container-configs-transcription-model',
  'container-configs-model-params',
  'container-configs-small-model',
  'container-configs-upstream-provider',
  'container-configs-disabled-skills',
  'voice-input-backend',
  'drop-legacy-transcription-config',
  'container-configs-credential-backend',
  'credential-connections-identity',
  'agent-vault-new-group-default',
  'agent-vault-only',
  'current-state-interactions',
  'maintained-thread-summaries',
  'durable-conversation-reads',
  'central-integrity',
  'query-and-foreign-key-indexes',
  'domain-integrity',
] as const;

const synchronizationTriggers = (table: string, column: string): string =>
  ['INSERT', 'UPDATE', 'DELETE']
    .map(
      (operation) => `
CREATE TRIGGER credential_sync_${table}_${operation.toLowerCase()}
AFTER ${operation} ON ${table} BEGIN
  INSERT INTO credential_gateway_sync(user_id) VALUES(${operation === 'DELETE' ? 'OLD' : 'NEW'}.${column})
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;`,
    )
    .join('\n');

const counter = (column: string, minimum = 0): string =>
  `(typeof(NEW.${column})='integer' AND NEW.${column}>=${minimum} AND NEW.${column}<=9007199254740991)`;

const domains: Record<string, string> = {
  container_configs: [
    "(NEW.cli_scope IN ('disabled','group','global'))",
    `(NEW.skills='"all"' OR (json_valid(NEW.skills) AND json_type(NEW.skills)='array'))`,
    ...['mcp_servers', 'model_params'].map(
      (column) => `(json_valid(NEW.${column}) AND json_type(NEW.${column})='object')`,
    ),
    ...['packages_apt', 'packages_npm', 'packages_pip', 'disabled_skills', 'additional_mounts'].map(
      (column) => `(json_valid(NEW.${column}) AND json_type(NEW.${column})='array')`,
    ),
    "(NEW.max_messages_per_prompt IS NULL OR (typeof(NEW.max_messages_per_prompt)='integer' AND NEW.max_messages_per_prompt>0))",
  ].join(' AND '),
  messaging_groups: "(NEW.is_group IN (0,1)) AND (NEW.unknown_sender_policy IN ('strict','request_approval','public'))",
  messaging_group_agents: [
    "(NEW.session_mode IN ('shared','per-thread','agent-shared'))",
    "(NEW.engage_mode IN ('pattern','mention','mention-sticky'))",
    "(NEW.engage_mode!='pattern' OR (NEW.engage_pattern IS NOT NULL AND length(trim(NEW.engage_pattern))>0))",
    "(NEW.sender_scope IN ('all','known'))",
    "(NEW.ignored_message_policy IN ('drop','accumulate'))",
  ].join(' AND '),
  sessions: "(NEW.status IN ('active','closed')) AND (NEW.container_status IN ('running','idle','stopped'))",
  identities:
    "(NEW.metadata_json IS NULL OR (json_valid(NEW.metadata_json) AND json_type(NEW.metadata_json)='object'))",
  users: counter('unread_baseline'),
  conversation_reads: counter('position'),
  credential_gateway_sync: counter('revision', 1),
  push_subscriptions: counter('fail_count'),
  identity_link_challenges: counter('attempts'),
  unregistered_senders: counter('message_count', 1),
  chat_sdk_lists: counter('idx'),
};

/** Canonical central storage-v2 schema, including installed module tables. */
export const CENTRAL_SCHEMA_SQL = `
CREATE TABLE credential_gateway_identity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  installation_id TEXT NOT NULL UNIQUE
);

CREATE TABLE thread_summaries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('inbound', 'outbound')),
  kind TEXT NOT NULL CHECK (kind IN ('route', 'usage', 'turn')),
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (session_id, source, kind, channel_type, platform_id, thread_id)
);

CREATE TABLE conversation_publications (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('message','approval')),
  item_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  UNIQUE(session_id,kind,item_id,channel_type,platform_id,thread_id)
);

CREATE INDEX conversation_publications_route
  ON conversation_publications(session_id,channel_type,thread_id,platform_id,visible,position);

CREATE TABLE conversation_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0),
  PRIMARY KEY(user_id,session_id,channel_type,platform_id,thread_id)
);

CREATE TABLE credential_gateway_sync (
  user_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE interaction_progress (
  id TEXT PRIMARY KEY NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL DEFAULT '{}',
  submission_ids_json TEXT NOT NULL DEFAULT '[]',
  restart INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  CHECK(json_valid(data_json) AND json_type(data_json)='object'),
  CHECK(json_valid(submission_ids_json) AND json_type(submission_ids_json)='array'),
  CHECK(restart IN (0,1)),
  CHECK(notified IN (0,1))
);

CREATE TABLE thread_summary_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  unread_ready INTEGER NOT NULL DEFAULT 0,
  CHECK(unread_ready IN (0,1))
);

CREATE INDEX conversation_reads_session ON conversation_reads(session_id);

CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  created_by TEXT REFERENCES users(id),
  PRIMARY KEY (agent_group_id, local_name)
);

CREATE TABLE agent_group_members (
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by TEXT REFERENCES users(id),
  added_at INTEGER CHECK (added_at IS NULL OR typeof(added_at)='integer') NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

CREATE TABLE agent_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  agent_provider TEXT,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  site_slug TEXT,
  site_enabled INTEGER NOT NULL DEFAULT 0,
  email_slug TEXT,
  email_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chat_sdk_kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer')
);

CREATE TABLE chat_sdk_lists (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer'),
  PRIMARY KEY (key, idx)
);

CREATE TABLE chat_sdk_locks (
  thread_id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer') NOT NULL
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id TEXT PRIMARY KEY NOT NULL,
  subscribed_at INTEGER CHECK (subscribed_at IS NULL OR typeof(subscribed_at)='integer') NOT NULL
    DEFAULT (${EPOCH_NOW_SQL})
);

CREATE TABLE container_configs (
  agent_group_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider TEXT,
  model TEXT,
  effort TEXT,
  image_tag TEXT,
  assistant_name TEXT,
  max_messages_per_prompt INTEGER,
  soft_turn_token_budget INTEGER CHECK (soft_turn_token_budget IS NULL OR
    (typeof(soft_turn_token_budget)='integer' AND soft_turn_token_budget>0 AND soft_turn_token_budget<=9007199254740991)),
  skills TEXT NOT NULL DEFAULT '"all"',
  mcp_servers TEXT NOT NULL DEFAULT '{}',
  packages_apt TEXT NOT NULL DEFAULT '[]',
  packages_npm TEXT NOT NULL DEFAULT '[]',
  additional_mounts TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER CHECK (updated_at IS NULL OR typeof(updated_at)='integer') NOT NULL,
  cli_scope TEXT NOT NULL DEFAULT 'group',
  packages_pip TEXT NOT NULL DEFAULT '[]',
  model_params TEXT NOT NULL DEFAULT '{}',
  small_model TEXT,
  upstream_provider TEXT,
  disabled_skills TEXT NOT NULL DEFAULT '[]',
  voice_input_backend TEXT,
  voice_input_enabled INTEGER NOT NULL DEFAULT 1 CHECK (voice_input_enabled IN (0, 1)),
  credential_backend TEXT NOT NULL DEFAULT 'agent-vault' CHECK(credential_backend='agent-vault')
);

CREATE TABLE identities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  handle TEXT NOT NULL,
  verified_at INTEGER CHECK (verified_at IS NULL OR typeof(verified_at)='integer') NOT NULL,
  primary_for_channel INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  PRIMARY KEY (channel, handle),
  CHECK(primary_for_channel IN (0,1))
);

CREATE TABLE identity_link_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  handle TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer') NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL DEFAULT (${EPOCH_NOW_SQL}),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR typeof(consumed_at)='integer')
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','account_setup','access_grant')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  agent_group_id TEXT REFERENCES agent_groups(id),
  origin_message_id TEXT,
  request_id TEXT,
  platform_id TEXT,
  channel_type TEXT,
  thread_id TEXT,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  status TEXT NOT NULL DEFAULT 'pending',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  updated_at INTEGER CHECK (updated_at IS NULL OR typeof(updated_at)='integer') NOT NULL,
  dedupe_key TEXT,
  responded_by TEXT,
  responded_at INTEGER CHECK (responded_at IS NULL OR typeof(responded_at)='integer'),
  outcome_message TEXT,
  resolved_at INTEGER CHECK (resolved_at IS NULL OR typeof(resolved_at)='integer'),
  route_origin_id TEXT,
  CHECK(COALESCE((
    (request_id IS NOT NULL AND response_json IS NOT NULL
      AND status IN ('pending','applying','approved','completed','rejected','failed','cancelled','expired')
      AND ((kind='confirmation' AND status!='completed') OR (kind!='confirmation' AND status!='approved')))
  ),0))
);

CREATE TABLE messaging_group_agents (
  id TEXT PRIMARY KEY NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  session_mode TEXT DEFAULT 'shared',
  priority INTEGER DEFAULT 0,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  engage_mode TEXT NOT NULL DEFAULT 'mention',
  engage_pattern TEXT,
  sender_scope TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  UNIQUE(messaging_group_id, agent_group_id)
);

CREATE TABLE messaging_groups (
  id TEXT PRIMARY KEY NOT NULL,
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  instance TEXT NOT NULL,
  name TEXT,
  is_group INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  denied_at INTEGER CHECK (denied_at IS NULL OR typeof(denied_at)='integer'),
  UNIQUE(channel_type, platform_id, instance)
);

CREATE TABLE oidc_links (
  provider TEXT NOT NULL,
  sub TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  claims_json TEXT,
  linked_at INTEGER CHECK (linked_at IS NULL OR typeof(linked_at)='integer') NOT NULL DEFAULT (${EPOCH_NOW_SQL}),
  last_seen_at INTEGER CHECK (last_seen_at IS NULL OR typeof(last_seen_at)='integer'),
  PRIMARY KEY (provider, sub)
);

CREATE TABLE pending_channel_approvals (
  messaging_group_id TEXT PRIMARY KEY NOT NULL REFERENCES messaging_groups(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  original_message TEXT NOT NULL,
  approver_user_id TEXT NOT NULL,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE pending_sender_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity TEXT NOT NULL,
  sender_name TEXT,
  original_message TEXT NOT NULL,
  approver_user_id TEXT NOT NULL,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(messaging_group_id, sender_identity)
);

CREATE TABLE pending_user_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  sub TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  claims_json TEXT,
  approver_user_id TEXT,
  approver_channel_type TEXT,
  approver_platform_id TEXT,
  approver_message_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL DEFAULT (${EPOCH_NOW_SQL}),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR typeof(resolved_at)='integer'),
  resolved_by_user_id TEXT,
  resolution_note TEXT,
  granted_agent_group_id TEXT
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  last_used_at INTEGER CHECK (last_used_at IS NULL OR typeof(last_used_at)='integer'),
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE resend_outbound_correlations (
  correlation_token TEXT PRIMARY KEY NOT NULL,
  origin_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  email_thread_id TEXT NOT NULL,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL
);

CREATE TABLE resend_thread_roots (
  thread_id TEXT PRIMARY KEY NOT NULL,
  root_message_id TEXT NOT NULL,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL
);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied INTEGER CHECK (applied IS NULL OR typeof(applied)='integer') NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id TEXT,
  agent_provider TEXT,
  status TEXT DEFAULT 'active',
  container_status TEXT DEFAULT 'stopped',
  last_active INTEGER CHECK (last_active IS NULL OR typeof(last_active)='integer'),
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL
);

CREATE TABLE thread_forks (
  agent_group_id TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  parent_thread_id TEXT NOT NULL,
  parent_message_id TEXT NOT NULL,
  parent_message_ts INTEGER CHECK (parent_message_ts IS NULL OR typeof(parent_message_ts)='integer') NOT NULL,
  parent_title TEXT,
  fidelity TEXT NOT NULL DEFAULT 'transcript',
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  PRIMARY KEY (agent_group_id, messaging_group_id, thread_id)
);

CREATE TABLE ui_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  group_id TEXT,
  path TEXT,
  action TEXT NOT NULL,
  ip TEXT,
  ts INTEGER CHECK (ts IS NULL OR typeof(ts)='integer') NOT NULL
);

CREATE TABLE ui_download_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  issuer_user_id TEXT NOT NULL REFERENCES users(id),
  recipient_user_id TEXT REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES agent_groups(id),
  rel_path TEXT NOT NULL,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer') NOT NULL,
  uses_left INTEGER NOT NULL,
  first_redeemed_at INTEGER CHECK (first_redeemed_at IS NULL OR typeof(first_redeemed_at)='integer'),
  first_redeemed_ip TEXT,
  first_redeemed_ua TEXT
);

CREATE TABLE ui_magic_links (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer') NOT NULL,
  redeemed_at INTEGER CHECK (redeemed_at IS NULL OR typeof(redeemed_at)='integer')
);

CREATE TABLE ui_private_web_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  handoff_token_hash TEXT NOT NULL UNIQUE,
  secure_token_hash TEXT UNIQUE,
  parent_ui_session_hash TEXT NOT NULL REFERENCES ui_sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer') NOT NULL,
  last_used INTEGER CHECK (last_used IS NULL OR typeof(last_used)='integer'),
  redeemed_at INTEGER CHECK (redeemed_at IS NULL OR typeof(redeemed_at)='integer')
);

CREATE TABLE ui_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR typeof(expires_at)='integer') NOT NULL,
  last_used INTEGER CHECK (last_used IS NULL OR typeof(last_used)='integer')
);

CREATE TABLE unregistered_senders (
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    CHECK (user_id IS NULL OR (
      length(user_id) = 36
      AND substr(user_id, 9, 1) = '-'
      AND substr(user_id, 14, 1) = '-'
      AND substr(user_id, 19, 1) = '-'
      AND substr(user_id, 24, 1) = '-'
    )),
  sender_name TEXT,
  reason TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER CHECK (first_seen IS NULL OR typeof(first_seen)='integer') NOT NULL,
  last_seen INTEGER CHECK (last_seen IS NULL OR typeof(last_seen)='integer') NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);

CREATE TABLE user_dms (
  user_id TEXT NOT NULL REFERENCES users(id),
  channel_type TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR typeof(resolved_at)='integer') NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by TEXT REFERENCES users(id),
  granted_at INTEGER CHECK (granted_at IS NULL OR typeof(granted_at)='integer') NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id),
  CHECK(role IN ('owner','admin')),
  CHECK(role != 'owner' OR agent_group_id IS NULL)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL,
  onboarded_at INTEGER CHECK (onboarded_at IS NULL OR typeof(onboarded_at)='integer'),
  unread_baseline INTEGER NOT NULL DEFAULT 0,
  CHECK(unread_baseline >= 0)
);

CREATE UNIQUE INDEX idx_schema_version_name ON schema_version(name);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
CREATE INDEX idx_ui_access_log_ts ON ui_access_log(ts);
CREATE INDEX oidc_links_by_user ON oidc_links(user_id);
CREATE INDEX oidc_links_by_email ON oidc_links(email);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
CREATE INDEX idx_thread_forks_parent ON thread_forks(agent_group_id, messaging_group_id, parent_thread_id);

${synchronizationTriggers('agent_group_members', 'user_id')}

CREATE UNIQUE INDEX idx_agent_groups_site_slug ON agent_groups(site_slug) WHERE site_slug IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_groups_email_slug ON agent_groups(email_slug) WHERE email_slug IS NOT NULL;

${['INSERT', 'DELETE']
  .map(
    (operation) => `
CREATE TRIGGER credential_sync_groups_${operation.toLowerCase()}
AFTER ${operation} ON agent_groups BEGIN
  INSERT INTO credential_gateway_sync(user_id)
  SELECT id FROM users WHERE 1
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;`,
  )
  .join('\n')}

${synchronizationTriggers('users', 'id')}

CREATE TRIGGER users_unread_baseline AFTER INSERT ON users BEGIN
  UPDATE users SET unread_baseline=(SELECT COALESCE(MAX(position),0) FROM conversation_publications)
    WHERE id=NEW.id;
END;

CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

${synchronizationTriggers('user_roles', 'user_id')}

CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
CREATE INDEX idx_pending_sender_approvals_mg ON pending_sender_approvals(messaging_group_id);
CREATE INDEX idx_ui_sessions_user ON ui_sessions(user_id);
CREATE INDEX idx_ui_download_tokens_expires ON ui_download_tokens(expires_at);
CREATE INDEX idx_ui_download_tokens_issuer ON ui_download_tokens(issuer_user_id);
CREATE INDEX idx_identities_user ON identities(user_id);
CREATE INDEX identity_link_challenges_by_user ON identity_link_challenges(user_id);
CREATE INDEX identity_link_challenges_active ON identity_link_challenges(user_id, expires_at) WHERE consumed_at IS NULL;
CREATE INDEX push_subscriptions_by_user ON push_subscriptions(user_id);
CREATE INDEX pending_user_approvals_by_status ON pending_user_approvals(status);
CREATE UNIQUE INDEX pending_user_approvals_one_pending_per_sub ON pending_user_approvals(provider, sub)
  WHERE status = 'pending';
CREATE INDEX idx_ui_private_web_sessions_expires ON ui_private_web_sessions(expires_at);
CREATE INDEX interactions_session ON interactions(session_id,created_at,id);
CREATE UNIQUE INDEX interactions_pending_key ON interactions(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','applying');
CREATE UNIQUE INDEX user_roles_global_unique ON user_roles(user_id,role) WHERE agent_group_id IS NULL;
CREATE UNIQUE INDEX identities_primary_unique ON identities(user_id,channel) WHERE primary_for_channel=1;
CREATE UNIQUE INDEX sessions_active_thread_unique ON sessions(agent_group_id,messaging_group_id,thread_id)
  WHERE status='active' AND messaging_group_id IS NOT NULL AND thread_id IS NOT NULL;
CREATE UNIQUE INDEX sessions_active_shared_unique ON sessions(agent_group_id,messaging_group_id)
  WHERE status='active' AND messaging_group_id IS NOT NULL AND thread_id IS NULL;
CREATE INDEX agent_group_members_group ON agent_group_members(agent_group_id);
CREATE INDEX interactions_group ON interactions(agent_group_id);
CREATE INDEX ui_private_web_sessions_parent ON ui_private_web_sessions(parent_ui_session_hash);
CREATE INDEX ui_sessions_expires ON ui_sessions(expires_at);
CREATE INDEX ui_magic_links_expires ON ui_magic_links(expires_at);
CREATE INDEX chat_sdk_kv_expires ON chat_sdk_kv(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX chat_sdk_locks_expires ON chat_sdk_locks(expires_at);
CREATE INDEX chat_sdk_lists_expires ON chat_sdk_lists(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX messaging_group_agents_group ON messaging_group_agents(agent_group_id);

${Object.entries(domains)
  .flatMap(([table, rule]) =>
    ['INSERT', 'UPDATE'].map(
      (operation) => `
CREATE TRIGGER domain_${table}_${operation.toLowerCase()}
BEFORE ${operation} ON ${table} WHEN NOT COALESCE(${rule},0) BEGIN
  SELECT RAISE(ABORT,'invalid ${table} domain values');
END;`,
    ),
  )
  .join('\n')}
`;
