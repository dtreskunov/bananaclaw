// Shared types used across the chat UI client.

export type ChannelType =
  | 'web'
  | 'resend'
  | 'discord'
  | 'telegram'
  | 'whatsapp'
  | 'imessage'
  | 'signal'
  | 'slack'
  | 'matrix'
  | 'gchat'
  | 'cli'
  | string;

export interface ChannelMetaEntry {
  label: string;
  icon: string;
}

export interface Group {
  id: string;
  name: string;
  isAdmin?: boolean;
  /**
   * Whether the viewer has any messaging-group context (web mg, or a
   * non-web mg matching one of their identities) in this group. The
   * dropdown hides groups with `hasContent=false` by default — toggle
   * "Show all" to override.
   */
  hasContent?: boolean;
  lastActivityAt?: string;
}

export interface Thread {
  threadId: string;
  sessionId?: string | null;
  channelType?: ChannelType;
  messagingGroupId?: string | null;
  sessionMode?: string;
  title: string;
  lastActivityAt: string;
  messageCount?: number;
  kind?: 'dm' | 'thread';
  counterparty?: string;
  canSend?: boolean;
  totalCost?: number;
  totalTokens?: number;
  turnCount?: number;
  liveTasks?: LiveTaskDto[];
}

/** One live (pending/paused) scheduled task keeping a thread active. */
export interface LiveTaskDto {
  seriesId: string;
  nextRunAt: string | null;
  recurrence: string | null;
  summary: string;
  paused: boolean;
}

/** Full per-series detail for the scheduled-tasks management panel. */
export interface TaskDetailDto {
  seriesId: string;
  status: 'pending' | 'paused';
  nextRunAt: string | null;
  recurrence: string | null;
  summary: string;
  prompt: string;
  hasScript: boolean;
  script: string;
}

/** Open-request for the task panel: which thread's tasks to manage. */
export interface TaskPanelRequest {
  gid: string;
  tid: string;
  /** When set, the panel scrolls to and highlights this task series. */
  focusSeriesId?: string;
}

export interface ThreadCtx {
  channelType: ChannelType;
  messagingGroupId: string | null;
  canSend: boolean;
}

export type Direction = 'in' | 'out' | 'internal' | 'event';

export interface ChatMessageFile {
  filename: string;
  size?: number;
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
}

export interface TurnUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens?: number;
  model: string;
  context_window?: number;
  max_output_tokens?: number;
  duration_ms?: number;
}

export interface ChatMessage {
  id?: string;
  direction: Direction;
  text: string;
  files: ChatMessageFile[] | null;
  ts: string;
  usage?: TurnUsage;
  /** Persisted activity trace for an outbound turn, in emit order. */
  activity?: ActivityLine[];
  /** Timeline event payload; present when direction === 'event'. */
  event?: TimelineEvent;
}

/** Non-chat timeline marker (e.g. a scheduled task firing). */
export interface TimelineEvent {
  kind: 'task-run';
  taskId?: string;
  summary: string;
  recurrence?: string | null;
}

/** One step of a turn's activity trace: emit-time timestamp (epoch ms as a
 *  string) plus the whole progress text. */
export interface ActivityLine {
  ts: string;
  text: string;
}

export interface SearchResult {
  messageId: string;
  sessionId: string;
  threadId: string | null;
  channelType: string | null;
  messagingGroupId: string | null;
  direction: string;
  timestamp: string;
  snippet: string;
  rank: number;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  size?: number;
  mtime?: string;
  tier?: number;
}

export type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'text' | 'binary' | 'error';

export interface PreviewBlock {
  kind: PreviewKind;
  url?: string;
  html?: string;
  text?: string;
  mime?: string;
  ext?: string;
  name?: string;
  size?: number | null;
  mtime?: string | null;
  path?: string;
  // Version token for the currently-loaded file. Sent as `ifMatch` on save
  // so an in-browser edit only lands if the file hasn't changed underneath.
  // Absent when the version isn't known (non-file previews, load errors).
  etag?: string;
  tags?: Record<string, unknown> | null;
  lyrics?: string | null;
}

export interface UploadItem {
  file: File;
  name: string;
  size: number;
  status: 'uploading' | 'ok' | 'error' | 'conflict';
  pct?: number;
  statusText?: string;
  path?: string | null;
}

export interface Identity {
  channel: string;
  handle: string;
  primary?: boolean;
}

export interface ShareModalRequest {
  groupId: string;
  entry: { path: string; name: string; type?: string };
}

export interface ToastMessage {
  id: number;
  text: string;
  kind?: 'ok' | 'err';
  // When set, the toast is sticky (no auto-hide) and renders a button.
  action?: { label: string; onClick: () => void };
}

export interface PendingFile {
  name: string;
  size: number;
  // Backed by a real File when picked from the composer; the chat send
  // uses it via FormData.
  // eslint-disable-next-line @typescript-eslint/ban-types
  file?: File;
}

export interface PendingApprovalDto {
  approvalId: string;
  action: string;
  title: string;
  details: string | null;
  options: { label: string; value: string }[];
  agentGroupId: string | null;
  agentGroupName: string | null;
  createdAt: string;
}

export interface PendingQuestionDto {
  questionId: string;
  title: string;
  question: string;
  options: { label: string; value: string }[];
  threadId: string | null;
  agentGroupId: string;
  createdAt: string;
}

export interface RouterApi {
  selectGroup: (gid: string) => Promise<void>;
  loadThreads: (gid: string) => Promise<void>;
  openChat: (gid: string, tid: string | null, opts: ThreadCtx | null) => Promise<void>;
  clearChat: () => void;
  loadTree: (p: string) => Promise<void>;
  selectFile: (entry: Pick<TreeEntry, 'path' | 'name'> & Partial<TreeEntry>) => Promise<void>;
  notFound: (msg: string) => void;
}

// Value sent by the chat WS.
export interface WsPayload {
  kind: 'ready' | 'typing' | 'inbound' | 'outbound' | 'usage' | 'activity' | 'task-run';
  on?: boolean;
  hint?: string;
  /** Complete host-reduced activity snapshot for the current turn. */
  items?: ActivityLine[] | null;
  text?: string;
  content?: string | { text?: string; markdown?: string };
  files?: ChatMessageFile[] | null;
  timestamp?: string;
  id?: string;
  messageKind?: 'internal' | 'final' | string;
  usage?: TurnUsage;
  question?: { questionId: string; title: string; options: { label: string; value: string }[] };
  /** task-run frame fields. */
  summary?: string;
  taskId?: string;
  recurrence?: string | null;
}
