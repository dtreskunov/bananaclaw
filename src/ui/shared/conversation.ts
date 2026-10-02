import type { InputState } from './input-state.js';

/** Browser-safe, route-scoped host projection. No runner journal or routing IDs. */
export interface ConversationUsage {
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
}

export interface ConversationMessage {
  id: string;
  direction: 'in' | 'out' | 'internal' | 'event';
  timestamp: string;
  text: string;
  turnId?: string;
  timelinePosition?: number;
  inputState?: InputState;
  canEditPending?: boolean;
  author?: { userId: string; displayName: string };
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
  reactions?: { emoji: string; ts: string }[];
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

export interface ConversationQuestion {
  questionId: string;
  title: string;
  question: string;
  responseMode: 'choice' | 'text' | 'choice_or_text';
  options: { label: string; selectedLabel: string; value: string }[];
  status: 'pending' | 'answered' | 'cancelled';
  answerValue: string | null;
  answerType: 'choice' | 'text' | null;
  answeredAt: string | null;
  activity?: { ts: string; text: string }[];
  turnId?: string;
  threadId: string | null;
  agentGroupId: string;
  createdAt: string;
}

export interface ConversationTurn {
  id: string;
  phase: 'running' | 'stopping' | 'settling' | 'settled';
  outcome: 'pending' | 'replied' | 'warning' | 'silent' | 'stopped' | 'failed' | 'unknown' | 'interrupted';
  startedAt: string | null;
  endedAt: string | null;
  inputIds: string[];
  outputIds: string[];
  activity: { ordinal: number; ts: string; text: string }[];
  /** Accounting records remain keyed by their original usage IDs, never by response count. */
  usage: { id: string; value: Partial<ConversationUsage> }[];
  metadata: {
    status: 'provisional' | 'partial' | 'final' | 'unavailable';
    model: string | null;
    durationMs: number | null;
  };
  liveUsage: ConversationUsage | null;
}

export interface ConversationCapabilities {
  canSend: boolean;
  stop: boolean;
  steer: boolean;
  editInput: boolean;
  cancelInput: boolean;
}

export interface Conversation {
  threadId: string;
  messages: ConversationMessage[];
  turns: ConversationTurn[];
  questions: ConversationQuestion[];
  connection: { connected: boolean; activeTurnId: string | null };
  capabilities: ConversationCapabilities;
}
