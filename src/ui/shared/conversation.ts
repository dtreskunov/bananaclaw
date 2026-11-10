import type { InputState } from './input-state.js';
import type { ConversationApproval } from './approval.js';
import type { ReadCursor } from './read-state.js';
import type { EpochMs } from './time.js';
import { integer, object } from './validation.js';

/** Browser-safe, route-scoped host projection. No runner journal or routing IDs. */
export interface ConversationUsage {
  /** Cumulative reported processing, not context occupancy or remaining plan quota. */
  reported_tokens?: number | null;
  cost_source?: 'reported' | 'estimated' | 'unavailable' | 'mixed' | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model: string;
  reasoning_tokens?: number;
  num_turns?: number;
  context_window?: number;
  max_output_tokens?: number;
  context_tokens?: number;
  duration_ms?: number;
  duration_api_ms?: number;
}

export interface TurnUsageAdvisory {
  threshold: number;
  reportedTokens: number;
  triggeredAt: number;
  status: 'queued' | 'applied' | 'skipped';
  appliedAt: number | null;
  finishedAt: number | null;
}

export function isTurnUsageAdvisory(value: unknown): value is TurnUsageAdvisory {
  if (!object(value) ||
      Object.keys(value).length !== 6 ||
      !integer(value.threshold) || value.threshold === 0 ||
      !integer(value.reportedTokens) || Number(value.reportedTokens) < Number(value.threshold) ||
      !integer(value.triggeredAt) ||
      !(value.appliedAt === null || integer(value.appliedAt)) ||
      !(value.finishedAt === null || integer(value.finishedAt))) return false;
  switch (value.status) {
    case 'queued': return value.appliedAt === null && value.finishedAt === null;
    case 'applied': return value.appliedAt !== null && value.finishedAt === null;
    case 'skipped': return value.appliedAt === null && value.finishedAt !== null;
    default: return false;
  }
}

export type ConversationAuthor =
  | { userId: string; displayName: string }
  | { agentGroupId: string; displayName: string };

export function otherAuthorName(
  author: ConversationAuthor | null | undefined,
  userId: string | null,
  agentGroupId: string | null,
): string | undefined {
  if (!author) return undefined;
  const own = 'userId' in author ? author.userId === userId : author.agentGroupId === agentGroupId;
  return own ? undefined : author.displayName;
}

export function messageAttribution(
  message: Pick<ConversationMessage, 'author' | 'recipient'>,
  userId: string | null,
  agentGroupId: string | null,
): string | undefined {
  return (
    otherAuthorName(message.author, userId, agentGroupId) ??
    (message.recipient ? `To ${message.recipient.displayName}` : undefined)
  );
}

export interface ConversationMessage {
  id: string;
  direction: 'in' | 'out' | 'event';
  timestamp: EpochMs;
  text: string;
  turnId?: string;
  timelinePosition?: number;
  inputState?: InputState;
  canEditPending?: boolean;
  author?: ConversationAuthor;
  recipient?: { agentGroupId: string; displayName: string };
  deliveryOrigin?: 'send_message' | 'send_file' | 'response';
  systemGenerated?: boolean;
  suggestedAction?: 'continue' | 'retry' | 'report';
  files?: { filename: string; size: number; path?: string; url?: string; contentType?: string }[];
  card?: {
    title: string;
    description: string;
    children: string[];
    actions: { label: string; url: string; style?: 'primary' | 'danger' | 'default' }[];
  };
  reactions?: { emoji: string; ts: EpochMs }[];
  event?: {
    kind: 'task-run';
    taskId?: string;
    summary: string;
    recurrence?: string | null;
    status?: 'running' | 'ready' | 'skipped' | 'failed' | 'timed_out' | 'completed';
    triggerSource?: 'scheduled' | 'manual';
    error?: string | null;
    autoPaused?: boolean;
  };
}

export type ConversationInteraction = ConversationApproval;

export type InteractionResponse = {
  value: string;
  message?: string;
};

export interface ConversationActivity {
  ordinal: number;
  ts: EpochMs;
  text: string;
  timelinePosition: number;
}

export interface ConversationTrace {
  turnId: string;
  ordinals: number[];
  ownsTurn: boolean;
}

export type ConversationTimelineRow =
  | { kind: 'message'; messageId: string; trace?: ConversationTrace; statsTurnId?: string }
  | { kind: 'interaction'; interactionId: string; trace?: ConversationTrace }
  | { kind: 'turn'; turnId: string; afterId: string | null; trace: ConversationTrace; status: boolean };

export interface ConversationTurn {
  id: string;
  phase: 'running' | 'stopping' | 'settling' | 'settled';
  outcome: 'pending' | 'replied' | 'warning' | 'silent' | 'stopped' | 'failed' | 'unknown' | 'interrupted';
  startedAt: EpochMs | null;
  /** When the earliest input answered by this turn was submitted; falls back to startedAt. */
  requestedAt?: EpochMs | null;
  endedAt: EpochMs | null;
  inputIds: string[];
  outputIds: string[];
  activity: ConversationActivity[];
  /** Accounting records remain keyed by their original usage IDs, never by response count. */
  usage: { id: string; value: Partial<ConversationUsage> }[];
  metadata: {
    status: 'provisional' | 'partial' | 'final' | 'unavailable';
    model: string | null;
    durationMs: number | null;
    usageAdvisory?: TurnUsageAdvisory | null;
  };
}

export interface ConversationCapabilities {
  canSend: boolean;
  stop: boolean;
  stopTool?: boolean;
  steer: boolean;
  editInput: boolean;
  cancelInput: boolean;
}

export interface Conversation {
  readCursor?: ReadCursor;
  threadId: string;
  messages: ConversationMessage[];
  turns: ConversationTurn[];
  interactions: ConversationInteraction[];
  timeline: ConversationTimelineRow[];
  connection: { connected: boolean; activeTurnId: string | null };
  capabilities: ConversationCapabilities;
}
