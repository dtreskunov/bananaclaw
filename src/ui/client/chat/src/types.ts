// Shared types used across the chat UI client.
import type { InputHandling } from '../../../shared/input-state';
import type { ModelTime } from '../../../shared/activity-presentation';
import type {
  ConversationMessage,
  ConversationQuestion,
  ConversationUsage,
  ConversationTurn,
} from '../../../shared/conversation';
export type { InputHandling, InputState } from '../../../shared/input-state';

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
  siteUrl?: string | null;
  isAdmin?: boolean;
  /** True when access depends solely on owner/global-admin privileges. */
  elevatedOnly?: boolean;
  /**
   * Whether the viewer has any messaging-group context (web mg, or a
   * non-web mg matching one of their identities) in this group.
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
  /** Set when this thread was branched off another one. */
  forkedFrom?: ForkOrigin;
  /** Branches taken out of this thread, oldest first. */
  forkChildren?: ForkChild[];
}

export interface ForkChild {
  threadId: string;
  /** The message in *this* thread the branch was cut at. */
  messageId: string;
  title: string;
}

export interface ForkOrigin {
  threadId: string;
  /** The message the branch was cut at; everything up to it was inherited. */
  messageId: string;
  title: string | null;
  /** 'native' kept the agent's real context; 'transcript' replayed a digest. */
  fidelity: 'native' | 'transcript';
  /** The parent is gone, so the origin is a label rather than a link. */
  deleted: boolean;
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
  scriptTimeoutMs: number;
  consecutiveFailures: number;
  attempts: TaskAttemptDto[];
}

export interface TaskAttemptDto {
  taskMessageId: string;
  triggerSource: 'scheduled' | 'manual';
  status: 'running' | 'ready' | 'skipped' | 'failed' | 'timed_out' | 'completed';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  wakeAgent: boolean | null;
  providerInvoked: boolean;
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

export type Direction = ConversationMessage['direction'];
export type ChatMessageFile = NonNullable<ConversationMessage['files']>[number];
export type TurnUsage = ConversationUsage;
export type DisplayCard = NonNullable<ConversationMessage['card']>;
export type DisplayCardAction = DisplayCard['actions'][number];
export type SuggestedAction = NonNullable<ConversationMessage['suggestedAction']>;
export type ChatMessage = ConversationMessage & MessagePresentation;

export interface MessagePresentation {
  /** Replies only: the settled turn whose accounting renders in this bubble's meta line. */
  statsTurn?: ConversationTurn;
  submission?: PendingWebSend;
  /** Suppress a generic queued receipt while a response starts or already owns this input. */
  hideInitialQueuedCaption?: boolean;
  /** Persisted activity trace for an outbound turn, in emit order. */
  activity?: ActivityLine[];
  /** This row currently owns the active/final trace state for its turn. */
  turnTraceOwner?: boolean;
  /** The owning turn trace is still receiving activity. */
  turnTraceLive?: boolean;
}

export type TranscriptRow =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'starting'; submission: PendingWebSend }
  | {
      kind: 'question-answer';
      question: PendingQuestionDto;
      answer: ChatMessage;
    }
  | {
      kind: 'turn';
      turn: import('../../../shared/conversation').ConversationTurn;
      afterId: string | null;
      activity: ActivityLine[];
      status: boolean;
      traceOwner: string;
    };

/** One emoji reaction attached to a message. */
export type MessageReaction = NonNullable<ConversationMessage['reactions']>[number];

/** Non-chat timeline marker (e.g. a scheduled task firing). */
export type TimelineEvent = NonNullable<ConversationMessage['event']>;

/** One step of a turn's activity trace: emit-time timestamp (epoch ms as a
 *  string) plus the whole progress text. */
export interface ActivityLine {
  ordinal?: number;
  ts: string;
  text: string;
  modelTime?: ModelTime;
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
  tier?: 'member' | 'admin';
}

export type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'html' | 'markdown' | 'text' | 'binary' | 'error';

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
  // When set, the toast is sticky (no auto-hide) and invokes this action.
  action?: () => void;
  actionLabel?: string;
}

export interface PendingFile {
  name: string;
  size: number;
  // Backed by a real File when picked from the composer; the chat send
  // uses it via FormData.
  file?: File;
}

export interface ChatSendPacket {
  readonly clientMessageId: string;
  readonly text: string;
  readonly files: readonly PendingFile[];
  readonly timestamp: string;
  readonly inputHandling?: InputHandling;
  readonly startsResponse: boolean;
}

export type WebSendState = { status: 'sending' | 'accepted'; error?: never } | { status: 'failed'; error: string };

export type PendingWebSend = ChatSendPacket & {
  readonly groupId: string;
  readonly threadId: string;
  readonly messageId: string;
} & WebSendState;

export type PendingApprovalDto = import('../../../shared/approval').ConversationApproval;

export type PendingQuestionDto = ConversationQuestion;

export interface RouterApi {
  selectGroup: (gid: string, options?: { newConversation?: boolean }) => Promise<void>;
  loadThreads: (gid: string) => Promise<boolean>;
  openChat: (gid: string, tid: string | null, opts: ThreadCtx | null) => Promise<void>;
  clearChat: () => void;
  loadTree: (p: string) => Promise<void>;
  selectFile: (entry: Pick<TreeEntry, 'path' | 'name'> & Partial<TreeEntry>) => Promise<void>;
  restoreFileSearch: (open: boolean, root: string, query: string) => Promise<void>;
  notFound: (msg: string) => void;
}

export interface ActiveTurn {
  id: string;
  status: 'running' | 'stopping';
  supportsSteering?: boolean;
  supportsInputEditing?: boolean;
  supportsInputCancellation?: boolean;
  supportsToolCancellation?: boolean;
}

export interface VoiceInputCapability {
  backend: 'elevenlabs' | 'disabled';
  ready: boolean;
  reason?: string;
}
