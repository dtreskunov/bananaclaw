/** Authorized thread-list entry; private routing and ownership checks stay on the host. */
export type ThreadActivityState = 'idle' | 'running';

export interface ActivityStatus {
  activity: ThreadActivityState;
  waiting?: boolean;
  activityStale?: boolean;
}

export interface AgentGroupActivity extends ActivityStatus {
  id: string;
  threadCount?: number;
}

export interface ThreadSummary extends ActivityStatus {
  threadId: string;
  sessionId: string;
  channelType: string;
  messagingGroupId: string;
  platformId: string;
  sessionMode: 'per-thread' | 'shared' | 'agent-shared';
  title: string;
  lastActivityAt: string;
  messageCount: number;
  counterparty?: string;
  /** Presentation hint, not send authorization. */
  canSend?: boolean;
  kind?: 'thread' | 'dm';
  totalCost?: number;
  totalTokens?: number;
  turnCount?: number;
  /** Pending/paused tasks, soonest next run first. */
  liveTasks?: LiveTaskDto[];
  forkedFrom?: {
    threadId: string;
    messageId: string;
    title: string | null;
    fidelity: 'native' | 'transcript';
    deleted: boolean;
  };
  /** Only branches the viewer can open, oldest first. */
  forkChildren?: { threadId: string; messageId: string; title: string }[];
}

export type ChatStartResponse = Pick<ThreadSummary, 'threadId' | 'messagingGroupId' | 'platformId'>;

export interface LiveTaskDto {
  seriesId: string;
  nextRunAt: string | null;
  recurrence: string | null;
  summary: string;
  paused: boolean;
}

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
  /** Recent execution attempts, newest first. */
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
