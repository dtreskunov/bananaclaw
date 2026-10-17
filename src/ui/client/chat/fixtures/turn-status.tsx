import { signal } from '@preact/signals';
import { render } from 'preact';
import type { Conversation, ConversationTurn } from '../../../shared/conversation';
import { CONVERSATION_PROTOCOL_VERSION, diffConversation } from '../../../shared/conversation-protocol';
import { conversationTimeline } from '../../../server/chat/conversation-timeline';
import { ChatMain } from '../src/components/ChatMain';
import { ChoiceModal } from '../src/components/PromptModal';
import { publicWebMessageId } from '../src/chat-protocol';
import type { InputHandling } from '../src/types';
import { appearance, initAppearance } from '../src/appearance-state';
import { applyConversationFrame, conversationState, resetConversation } from '../src/conversation-state';
import { toggleActivityTrace } from '../src/activity-trace-state';
import { resetTurnState } from '../src/stop-turn';
import {
  channelType,
  completionSoundMutedSig,
  groupId,
  isMobile,
  pendingWebSends,
  refs,
  stopRequest,
  progressSoundMutedSig,
  threadId,
  threads,
} from '../src/state';
import '../src/styles/global.css';
import './turn-status.css';

const scenes = [
  { id: 'idle-send', label: 'Submit a message (idle)' },
  { id: 'busy-send', label: 'Submit a message (busy)' },
  { id: 'pending-queued', label: 'Queued input controls' },
  { id: 'pending-steering', label: 'Steering input controls' },
  { id: 'initial', label: 'Initial Thinking…' },
  { id: 'running', label: 'Running tool' },
  { id: 'completed', label: 'Completed tool (Thinking…)' },
  { id: 'parallel', label: 'Parallel tools (both running)' },
  { id: 'parallel-completed', label: 'Parallel tools (one completed)' },
  { id: 'chapter-running', label: 'Command chapter (latest running)' },
  { id: 'chapter-completed', label: 'Command chapter (latest completed)' },
  { id: 'chapter-continued', label: 'Command chapter (next related step)' },
  { id: 'chapter-switched', label: 'Command chapter (next unrelated step)' },
  { id: 'long', label: 'Long activity' },
  { id: 'stopping', label: 'Stopping' },
  { id: 'stop-error', label: 'Stop request failure' },
  { id: 'disconnected', label: 'Disconnected' },
  { id: 'settling', label: 'Settling' },
  { id: 'reply', label: 'Settled reply' },
  { id: 'reply-file', label: 'Settled file-only reply' },
  { id: 'warning-reply', label: 'System warning reply' },
  { id: 'stopped-reply', label: 'System stop notice' },
  { id: 'interrupted-reply', label: 'System interruption notice' },
  { id: 'empty-reply', label: 'Settled reply (no recorded steps)' },
  { id: 'outputless', label: 'Settled without reply' },
  { id: 'silent-empty', label: 'No reply (outcome only)' },
  { id: 'stopped-empty', label: 'Stopped (outcome only)' },
  { id: 'stopped-recorded', label: 'Stopped (recorded stop entry)' },
  { id: 'warning-empty', label: 'Warning (outcome only)' },
  { id: 'interrupted-empty', label: 'Interrupted (outcome only)' },
  { id: 'card-warning', label: 'Display card (warning only)' },
  { id: 'technical-summary', label: 'Compact technical summary (41 entries)' },
  { id: 'technical-summary-multiple', label: 'Compact technical summary (two reports)' },
  { id: 'technical-summary-zero-cost', label: 'Elapsed minutes and zero cost' },
  { id: 'failed', label: 'Failed reply' },
  { id: 'failed-model-handled', label: 'Failed request (model explanation)' },
  { id: 'failed-no-usage', label: 'Failed reply (no accounting)' },
  { id: 'failed-timing-only', label: 'Failed reply (timing only)' },
  { id: 'card', label: 'Settled display card' },
] as const;
type Scene = (typeof scenes)[number]['id'];
const terminalScenes: Partial<Record<Scene, ConversationTurn['outcome']>> = {
  'silent-empty': 'silent',
  'stopped-empty': 'stopped',
  'stopped-recorded': 'stopped',
  'warning-empty': 'warning',
  'interrupted-empty': 'interrupted',
  'card-warning': 'warning',
  'warning-reply': 'warning',
  'stopped-reply': 'stopped',
  'interrupted-reply': 'interrupted',
};
const nextChapterScene: Partial<Record<Scene, Scene>> = {
  'chapter-running': 'chapter-completed',
  'chapter-completed': 'chapter-continued',
  'chapter-continued': 'chapter-switched',
};
const scene = signal<Scene>('initial');
const fixtureTurnId = 'fixture-status-turn';
const fixtureThreadId = 'fixture-status-thread';
const fixtureGroupId = 'fixture-status-group';
const requests: { url: string; turnId: string; toolCallId?: string }[] = [];
const stopFailure = 'Simulated Stop failure. Try again.';
let generation = 0;
interface SendRequest {
  url: string;
  /** When the server received it; the server stamps the stored message with this time. */
  receivedAt: number;
  clientMessageId: string;
  messageId: string;
  text: string;
  files: { filename: string; size: number; contentType: string }[];
  inputHandling?: InputHandling;
}
const sendRequests: SendRequest[] = [];
const outstanding: { request: SendRequest; resolve: (response: Response) => void }[] = [];
const outstandingCount = signal(0);

function publish(next: Conversation): void {
  const previous = conversationState.peek();
  if (!previous) throw new Error('Fixture conversation is missing');
  next.timeline = conversationTimeline(next);
  applyConversationFrame({
    kind: 'update', protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    streamId: previous.streamId, baseRevision: previous.revision, revision: previous.revision + 1,
    changes: diffConversation(previous.conversation, next),
  }, fixtureThreadId);
}

function currentConversation(): Conversation {
  const current = conversationState.peek();
  if (!current) throw new Error('Fixture conversation is missing');
  return structuredClone(current.conversation);
}

function latestSend(): SendRequest {
  const request = sendRequests.at(-1);
  if (!request) throw new Error('Fixture has no submitted message');
  return request;
}

function respondToSend(accepted: boolean): void {
  const request = outstanding.shift();
  if (!request) throw new Error('Fixture has no outstanding send');
  outstandingCount.value = outstanding.length;
  request.resolve(new Response(JSON.stringify(accepted ? { ok: true } : { error: 'Simulated send failure. Try again.' }),
    { status: accepted ? 200 : 503, headers: { 'Content-Type': 'application/json' } }));
}

function echoSend(): void {
  const request = latestSend();
  const next = currentConversation();
  if (next.messages.some((message) => message.id === request.messageId)) return;
  next.messages.push({
    id: request.messageId, direction: 'in', text: request.text, files: request.files,
    timestamp: new Date(request.receivedAt).toISOString(), timelinePosition: Date.now() * 1000,
    inputState: {
      messageId: request.messageId,
      status: request.inputHandling?.mode === 'steer' ? 'steering' : 'queued',
      ...(request.inputHandling ? { inputHandling: request.inputHandling } : {}),
      ...(request.inputHandling?.mode === 'queue' ? { queuedForNextTurn: true } : {}),
    },
  });
  publish(next);
}

function startResponse(activate = true): void {
  echoSend();
  const request = latestSend();
  const next = currentConversation();
  let turn = next.turns.find((value) => value.inputIds.includes(request.messageId));
  if (turn && next.connection.activeTurnId === (activate ? turn.id : null)) return;
  if (!turn) {
    const current = next.turns.find((value) => value.id === next.connection.activeTurnId);
    if (request.inputHandling?.mode === 'steer' && current) {
      current.inputIds.push(request.messageId);
      turn = current;
      const input = next.messages.find((message) => message.id === request.messageId);
      if (input) input.inputState = { messageId: request.messageId, status: 'applied', turnId: current.id };
    } else {
      if (current) {
        current.phase = 'settled';
        current.outcome = 'silent';
        current.endedAt = new Date().toISOString();
      }
      turn = makeConversation('initial', new Date().toISOString()).turns[0];
      turn.id = 'fixture-submitted-turn';
      turn.inputIds = [request.messageId];
      // Provider still starting: no model call can run yet.
      turn.activity = [];
      turn.requestedAt = next.messages.find((message) => message.id === request.messageId)?.timestamp ?? null;
      turn.metadata.model = null;
      next.turns.push(turn);
      const input = next.messages.find((message) => message.id === request.messageId);
      if (input?.inputState?.queuedForNextTurn)
        input.inputState = { messageId: request.messageId, status: 'processing', turnId: turn.id };
      // An idle send deliberately retains its generic queued receipt during turn handoff.
    }
  }
  next.connection.activeTurnId = activate ? turn.id : null;
  next.capabilities = { ...next.capabilities, stop: activate, stopTool: activate, steer: activate };
  publish(next);
}

function makeConversation(nextScene: Scene, startedAt = new Date(Date.now() - 7000).toISOString()): Conversation {
  if (nextScene === 'idle-send') {
    const view = { ...makeConversation('initial'), messages: [], turns: [],
      connection: { connected: true, activeTurnId: null },
      capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false } };
    return { ...view, timeline: conversationTimeline(view) };
  }
  const started = Date.parse(startedAt);
  const testing = nextScene === 'running' || nextScene === 'parallel' || nextScene === 'parallel-completed';
  const pendingInput = nextScene === 'pending-queued' || nextScene === 'pending-steering';
  const failed = ['failed', 'failed-model-handled', 'failed-no-usage', 'failed-timing-only'].includes(nextScene);
  const missingAccounting = nextScene === 'failed-no-usage' || nextScene === 'failed-timing-only';
  const terminalOutcome = terminalScenes[nextScene];
  const compactSummary = nextScene.startsWith('technical-summary');
  const elapsedMs = nextScene === 'technical-summary-zero-cost' ? 710_000 : compactSummary ? 15_000 : 12_000;
  const outcomeOnly = nextScene.endsWith('-empty') || nextScene === 'card-warning';
  const noticeReply = ['warning-reply', 'stopped-reply', 'interrupted-reply'].includes(nextScene);
  const settled = compactSummary || !!terminalOutcome || failed || ['reply', 'reply-file', 'empty-reply', 'outputless', 'card'].includes(nextScene);
  const phase = settled
    ? 'settled'
    : nextScene === 'stopping'
      ? 'stopping'
      : nextScene === 'settling'
        ? 'settling'
        : 'running';
  const activity: ConversationTurn['activity'] =
    nextScene === 'initial' || nextScene === 'empty-reply' || missingAccounting || outcomeOnly
      ? []
      : [
          {
            ordinal: 0,
            ts: String(started + 1000),
            timelinePosition: (started + 1000) * 1000,
            text: JSON.stringify({
              kind: 'tool',
              id: 'fixture-test-call',
              tool: 'bash',
              status: testing ? 'running' : 'completed',
              detail: 'pnpm exec vitest run src/ui/client/chat/src/turn-row.test.ts',
              ...(testing ? {} : { durationMs: 2200 }),
            }),
          },
        ];
  if (nextScene === 'reply') [[900, 800], [11_000, 7200]].forEach(([end, durationMs], index) => activity.push({
    ordinal: index + 1, ts: String(started + end), timelinePosition: (started + end) * 1000,
    text: JSON.stringify({ kind: 'model', id: `fixture-model-call-${index}`, durationMs }),
  }));
  if (nextScene === 'stopped-recorded') activity.push({
    ordinal: 1, ts: String(started + 12_000), timelinePosition: (started + 12_000) * 1000,
    text: JSON.stringify({ kind: 'notification', id: `stopped:${fixtureTurnId}`, text: 'Stopped by user.' }),
  });
  if (compactSummary) activity.splice(0, activity.length, ...Array.from({ length: 41 }, (_, ordinal) => ({
    ordinal, ts: String(started + ordinal * 100), timelinePosition: (started + ordinal * 100) * 1000,
    text: JSON.stringify(ordinal < 39
      ? { kind: 'tool', id: `fixture-summary-tool-${ordinal}`, tool: 'bash', status: 'completed', detail: 'echo test' }
      : ordinal === 39
        ? { kind: 'compaction', id: 'fixture-summary-compaction', status: 'completed' }
        : { kind: 'notification', id: 'fixture-summary-notice', text: 'Provider notice' }),
  })));
  if (nextScene.startsWith('chapter-')) {
    const continued = nextScene === 'chapter-continued' || nextScene === 'chapter-switched';
    const commands = continued ? ['pnpm run build', 'git diff --check'] : ['pnpm run build'];
    commands.forEach((detail, index) => {
      const running = nextScene === 'chapter-running' ||
        (nextScene === 'chapter-continued' && index === commands.length - 1);
      activity.push({
        ordinal: index + 1, ts: String(started + 4000 + index * 1000),
        timelinePosition: (started + 4000 + index * 1000) * 1000,
        text: JSON.stringify({ kind: 'tool', id: `fixture-command-${index + 1}`, tool: 'bash',
          status: running ? 'running' : 'completed', detail, ...(running ? {} : { durationMs: 2200 }) }),
      });
    });
    if (nextScene === 'chapter-switched') activity.push({
      ordinal: 3, ts: String(started + 6000), timelinePosition: (started + 6000) * 1000,
      text: JSON.stringify({ kind: 'tool', id: 'fixture-chapter-read', tool: 'read', status: 'running',
        detail: 'src/ui/client/chat/src/components/ChatMain.tsx' }),
    });
  }
  if (nextScene === 'failed-model-handled') {
    [
      { text: 'Provider request failed', detail: 'Output blocked by content filtering policy.' },
      { text: 'Asking model to explain failure', detail: 'Starting a fresh model query to report the error, not retry the original request.' },
      { text: 'Model output recorded after failure', detail: 'The original request remains unsuccessful; this output came from the failure-handling query.' },
    ].forEach((step, index) => {
      activity.push({
        ordinal: index + 1, ts: String(started + 4000 + index * 1000),
        timelinePosition: (started + 4000 + index * 1000) * 1000,
        text: JSON.stringify({ kind: 'notification', id: `fixture-failure-${index}`, ...step }),
      });
    });
  }
  if (nextScene === 'long' || nextScene === 'parallel' || nextScene === 'parallel-completed')
    activity.push({
      ordinal: 1,
      ts: String(started + 4000),
      timelinePosition: (started + 4000) * 1000,
      text: JSON.stringify({
        kind: 'tool',
        id: 'fixture-read-call',
        tool: 'read',
        status: nextScene === 'parallel-completed' ? 'completed' : 'running',
        detail:
          nextScene === 'long'
            ? 'src/ui/client/chat/src/components/a-very-long-directory-name/'.repeat(5) + 'VeryLongComponent.tsx'
            : 'src/ui/client/chat/src/components/ChatMain.tsx',
        ...(nextScene === 'parallel-completed' ? { durationMs: 1200 } : {}),
      }),
    });
  // The runner marks when the first model call can start.
  if (!outcomeOnly) activity.push({
    ordinal: 100, ts: String(started + 100), timelinePosition: (started + 100) * 1000,
    text: JSON.stringify({ kind: 'model', id: `model:ready:${fixtureTurnId}`, durationMs: 0 }),
  });
  const hasReply = settled && nextScene !== 'outputless' && (!terminalOutcome || nextScene === 'card-warning' || noticeReply);
  const turn: ConversationTurn = {
    id: fixtureTurnId,
    phase,
    outcome: compactSummary ? 'warning' : terminalOutcome ?? (!settled ? 'pending' : failed ? 'failed' : hasReply ? 'replied' : 'silent'),
    startedAt: outcomeOnly ? null : startedAt,
    requestedAt: outcomeOnly ? null : new Date(started - 1500).toISOString(),
    endedAt: settled && !outcomeOnly ? new Date(started + elapsedMs).toISOString() : null,
    inputIds: pendingInput ? [] : ['fixture-status-input'],
    outputIds: hasReply ? ['fixture-status-reply'] : [],
    activity,
    usage: nextScene === 'technical-summary-multiple' ? [
      { id: 'fixture-summary-first', value: { cost_usd: 1, model: 'MiniMax-M3', input_tokens: 100,
        output_tokens: 10, context_tokens: 150_000, context_window: 200_000 } },
      { id: 'fixture-summary-second', value: { cost_usd: 1.09, model: 'fixture-model', input_tokens: 200,
        output_tokens: 20, context_tokens: 70_000, context_window: 200_000 } },
    ] : compactSummary ? [{
      id: 'fixture-summary-usage', value: { cost_usd: nextScene === 'technical-summary-zero-cost' ? 0 : 2.09, model: 'MiniMax-M3', input_tokens: 798_800,
        output_tokens: 0, context_tokens: 70_000, context_window: 200_000, num_turns: 5 },
    }] : nextScene === 'failed-no-usage' || outcomeOnly
      ? []
      : nextScene === 'failed-timing-only'
      ? [{ id: 'fixture-timing-usage', value: { duration_api_ms: 8000 } }]
      : settled
      ? [
          {
            id: 'fixture-status-usage',
            value: {
              cost_usd: 0.0123,
              model: 'fixture-model',
              duration_ms: 10_000,
              duration_api_ms: 8000,
              num_turns: 2,
              input_tokens: 2500,
              output_tokens: 350,
              context_tokens: 8000,
              context_window: 200_000,
            },
          },
        ]
      : nextScene === 'initial'
      ? []
      : [{
          id: 'fixture-live-usage',
          value: {
            cost_usd: 0.004,
            duration_api_ms: 3000,
            model: 'fixture-model',
            input_tokens: 2100,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            context_tokens: 7500,
            context_window: 200_000,
          },
        }],
    metadata: {
      status: outcomeOnly ? 'unavailable' : failed ? 'partial' : settled ? 'final' : 'provisional',
      model: missingAccounting || outcomeOnly ? null : 'fixture-model',
      durationMs: settled && !outcomeOnly ? elapsedMs : null,
    },
  };
  const view: Omit<Conversation, 'timeline'> = {
    threadId: fixtureThreadId,
    messages: [
      {
        id: 'fixture-status-input',
        direction: 'in',
        text: 'Validate the turn status layout.',
        timestamp: new Date(started - 1000).toISOString(),
        timelinePosition: (started - 1000) * 1000,
        ...(pendingInput ? {
          canEditPending: true,
          inputState: {
            messageId: 'fixture-status-input',
            status: nextScene === 'pending-steering' ? 'steering' as const : 'queued' as const,
            queuedForNextTurn: nextScene === 'pending-queued',
          },
        } : {}),
      },
      ...(hasReply
        ? [
            {
              id: 'fixture-status-reply',
              direction: 'out' as const,
              turnId: fixtureTurnId,
              deliveryOrigin: 'response' as const,
              text: nextScene === 'failed-model-handled'
                ? 'Your message could not be processed: the provider blocked it with its content filtering policy.'
                : nextScene === 'reply-file' ? ''
                : noticeReply ? 'The runner ended this turn with a system notice.'
                : failed ? 'The fixture response failed.' : 'The **fixture response** is complete.',
              ...((failed && nextScene !== 'failed-model-handled') || noticeReply ? { systemGenerated: true } : {}),
              ...(nextScene === 'reply-file' ? { files: [{ filename: 'report.txt', size: 128 }] } : {}),
              timestamp: new Date(started + elapsedMs).toISOString(),
              timelinePosition: (started + elapsedMs) * 1000,
              ...(nextScene === 'card' || nextScene === 'card-warning'
                ? {
                    card: {
                      title: 'Fixture card',
                      description: 'A settled display-card response.',
                      children: ['Technical information is above this content.'],
                      actions: [],
                    },
                  }
                : {}),
            },
          ]
        : []),
    ],
    turns: [turn],
    questions: [],
    connection: { connected: nextScene !== 'disconnected', activeTurnId: settled ? null : fixtureTurnId },
    capabilities: { canSend: true, stop: !settled, stopTool: !settled, steer: nextScene === 'busy-send',
      editInput: pendingInput, cancelInput: pendingInput },
  };
  return { ...view, timeline: conversationTimeline(view) };
}

function show(nextScene: Scene): void {
  refs.chatGeneration++;
  for (const request of outstanding.splice(0))
    request.resolve(new Response('{"error":"Fixture scenario changed"}', { status: 409 }));
  outstandingCount.value = 0;
  sendRequests.length = 0;
  pendingWebSends.value = [];
  scene.value = nextScene;
  resetConversation();
  resetTurnState();
  applyConversationFrame(
    {
      kind: 'snapshot',
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      streamId: `status-fixture-${++generation}`,
      revision: 0,
      conversation: makeConversation(nextScene),
    },
    fixtureThreadId,
  );
  if (nextScene === 'stop-error')
    stopRequest.value = { turnId: fixtureTurnId, busy: false, error: stopFailure };
}

function advance(nextScene: Scene): void {
  if ((sendRequests.length || currentConversation().turns.length > 1) && nextScene === 'reply') {
    const next = currentConversation();
    const turn = next.turns.find((value) => value.id === next.connection.activeTurnId);
    if (!turn) throw new Error('Fixture response has not started');
    turn.phase = 'settled';
    turn.outcome = 'replied';
    turn.endedAt = new Date().toISOString();
    const settled = makeConversation('reply').turns[0];
    turn.metadata = settled.metadata;
    turn.usage = settled.usage;
    turn.outputIds = [turn.id === 'fixture-submitted-turn' ? 'fixture-submitted-reply' : `${turn.id}:reply`];
    next.messages.push({ id: turn.outputIds[0], direction: 'out', turnId: turn.id,
      text: 'The **submitted response** is complete.', timestamp: turn.endedAt,
      timelinePosition: Date.now() * 1000, deliveryOrigin: 'response' });
    next.connection.activeTurnId = null;
    next.capabilities.stop = false;
    publish(next);
    return;
  }
  const previous = conversationState.peek();
  if (!previous) throw new Error('Fixture conversation is missing');
  if (previous.conversation.turns.length > 1 && nextScene.startsWith('chapter-')) {
    const next = currentConversation();
    const turn = next.turns.find((value) => value.id === next.connection.activeTurnId);
    if (!turn?.startedAt) throw new Error('Fixture has no active chapter turn');
    const position = Math.max(...next.turns.flatMap((value) => value.activity.map((line) => line.timelinePosition))) + 1000;
    const activity = makeConversation(nextScene, turn.startedAt).turns[0].activity;
    turn.activity = activity.map((line) => ({ ...line,
      timelinePosition: turn.activity.find((value) => value.ordinal === line.ordinal)?.timelinePosition ?? position + line.ordinal }));
    scene.value = nextScene;
    publish(next);
    return;
  }
  const startedAt = previous.conversation.turns[0]?.startedAt;
  if (!startedAt) throw new Error('Fixture turn start time is missing');
  const next = makeConversation(nextScene, startedAt);
  if (nextScene === 'stopping' || nextScene === 'reply') {
    next.turns[0] = { ...next.turns[0], activity: previous.conversation.turns[0].activity };
    next.timeline = conversationTimeline(next);
  }
  scene.value = nextScene;
  applyConversationFrame(
    {
      kind: 'update',
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      streamId: previous.streamId,
      baseRevision: previous.revision,
      revision: previous.revision + 1,
      changes: diffConversation(previous.conversation, next),
    },
    fixtureThreadId,
  );
}

function nextTurn(): void {
  const next = currentConversation();
  if (next.connection.activeTurnId) throw new Error('Settle the fixture turn before starting another');
  const position = Math.max(Date.now() * 1000,
    ...next.messages.map((message) => message.timelinePosition ?? 0),
    ...next.turns.flatMap((turn) => turn.activity.map((line) => line.timelinePosition))) + 1000;
  const turn = makeConversation('chapter-running').turns[0];
  turn.id = `fixture-next-turn-${generation}-${next.turns.length}`;
  turn.inputIds = [`${turn.id}:input`];
  turn.activity = turn.activity.map((line, ordinal) => ({ ...line, timelinePosition: position + ordinal + 1 }));
  next.messages.push({ id: turn.inputIds[0], direction: 'in', text: 'Start the next fixture turn.',
    timestamp: new Date().toISOString(), timelinePosition: position });
  next.turns.push(turn);
  next.connection.activeTurnId = turn.id;
  next.capabilities.stop = true;
  scene.value = 'chapter-running';
  publish(next);
}

function tech(enabled: boolean): void {
  appearance.value = {
    ...appearance.peek(),
    preferences: { ...appearance.peek().preferences, showTechnicalStatus: enabled },
  };
}

function fixtureTraceOwner(): string | null {
  const view = conversationState.value?.conversation;
  if (view?.connection.activeTurnId) return `turn:${view.connection.activeTurnId}`;
  const submission = pendingWebSends.value.find((send) => send.startsResponse && send.status !== 'failed');
  if (submission) return `submission:${submission.messageId}`;
  const turn = view?.turns.at(-1);
  return turn ? `turn:${turn.id}` : null;
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `api/groups/${fixtureGroupId}/chat/${fixtureThreadId}/send` && init?.method === 'POST') {
    let body: unknown;
    const files: SendRequest['files'] = [];
    if (init.body instanceof FormData) {
      body = { text: init.body.get('text'), clientMessageId: init.body.get('clientMessageId'),
        inputHandling: init.body.has('inputHandling') ? JSON.parse(String(init.body.get('inputHandling'))) : undefined };
      for (const file of init.body.getAll('file')) {
        if (!(file instanceof File)) throw new Error('Fixture received an invalid attachment');
        files.push({ filename: file.name, size: file.size, contentType: file.type });
      }
    } else if (typeof init.body === 'string') body = JSON.parse(init.body);
    if (!body || typeof body !== 'object' || !('text' in body) || typeof body.text !== 'string' ||
      !('clientMessageId' in body) || typeof body.clientMessageId !== 'string')
      throw new Error('Fixture received an invalid send payload');
    let inputHandling: InputHandling | undefined;
    if ('inputHandling' in body && body.inputHandling !== undefined) {
      const handling = body.inputHandling;
      if (!handling || typeof handling !== 'object' || !('mode' in handling) ||
        (handling.mode !== 'steer' && handling.mode !== 'queue') ||
        !('turnId' in handling) || typeof handling.turnId !== 'string')
        throw new Error('Fixture received invalid input handling');
      inputHandling = { mode: handling.mode, turnId: handling.turnId };
    }
    const request: SendRequest = { url, receivedAt: Date.now(), text: body.text, clientMessageId: body.clientMessageId,
      messageId: publicWebMessageId(body.clientMessageId), files, inputHandling };
    sendRequests.push(request);
    return new Promise<Response>((resolve) => {
      outstanding.push({ request, resolve });
      outstandingCount.value = outstanding.length;
    });
  }
  const toolStop = url === `api/groups/${fixtureGroupId}/chat/${fixtureThreadId}/stop-tool`;
  if ((!toolStop && url !== `api/groups/${fixtureGroupId}/chat/${fixtureThreadId}/stop`) || init?.method !== 'POST')
    throw new Error(`Fixture blocked network request: ${url}`);
  if (typeof init.body !== 'string') throw new Error('Fixture stop request body is missing');
  const body: unknown = JSON.parse(init.body);
  const activeId = conversationState.peek()?.conversation.connection.activeTurnId;
  if (!body || typeof body !== 'object' || !('turnId' in body) || typeof body.turnId !== 'string' || body.turnId !== activeId)
    throw new Error('Fixture received an invalid stop target');
  if (toolStop) {
    if (!('toolCallId' in body) || typeof body.toolCallId !== 'string') throw new Error('Fixture tool call ID is missing');
    const next = currentConversation();
    const turn = next.turns.find((value) => value.id === body.turnId);
    const activity = turn?.activity.find((line) => JSON.parse(line.text).id === body.toolCallId);
    if (!activity || !turn) throw new Error('Fixture tool call is missing');
    const step = JSON.parse(activity.text);
    if (step.kind !== 'tool' || step.status !== 'running') return Response.json({ error: 'not_running' }, { status: 409 });
    requests.push({ url, turnId: body.turnId, toolCallId: body.toolCallId });
    activity.text = JSON.stringify({ ...step, status: 'interrupted',
      durationMs: Math.max(0, Date.now() - Number(activity.ts)),
      error: 'Interrupted; outcome unknown. External side effects may have occurred. Do not retry without checking.' });
    publish(next);
    return Response.json({ accepted: true }, { status: 202 });
  }
  requests.push({ url, turnId: body.turnId });
  if (scene.peek() === 'stop-error')
    return new Response(JSON.stringify({ error: stopFailure }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  if (sendRequests.length) {
    const next = currentConversation();
    const turn = next.turns.find((value) => value.id === activeId);
    if (!turn) throw new Error('Fixture active turn is missing');
    turn.phase = 'stopping';
    publish(next);
  } else advance('stopping');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

interface FixtureApi {
  show: typeof show;
  publish: typeof publish;
  advance: typeof advance;
  nextTurn: typeof nextTurn;
  tech: typeof tech;
  acceptSend: () => void;
  failSend: () => void;
  echoSend: typeof echoSend;
  startResponse: typeof startResponse;
  inspect: () => { scene: Scene; requests: { url: string; turnId: string; toolCallId?: string }[]; sendRequests: SendRequest[];
    submissions: { messageId: string; text: string; status: string }[]; conversation: Conversation };
}
declare global {
  interface Window {
    turnStatusFixture: FixtureApi;
  }
}
window.turnStatusFixture = {
  show,
  publish,
  advance,
  nextTurn,
  tech,
  acceptSend: () => respondToSend(true),
  failSend: () => respondToSend(false),
  echoSend,
  startResponse,
  inspect() {
    const current = conversationState.peek();
    if (!current) throw new Error('Fixture conversation is missing');
    return {
      scene: scene.peek(),
      requests: structuredClone(requests),
      sendRequests: structuredClone(sendRequests),
      submissions: pendingWebSends.peek().map(({ messageId, text, status }) => ({ messageId, text, status })),
      conversation: structuredClone(current.conversation),
    };
  },
};

function Fixture() {
  const nextChapter = nextChapterScene[scene.value];
  return (
    <div class="turn-status-fixture">
      <header class="turn-status-fixture-controls">
        <label>
          Scenario
          <select
            aria-label="Fixture scenario"
            value={scene.value}
            onChange={(event) => show(event.currentTarget.value as Scene)}
          >
            {scenes.map((value) => (
              <option key={value.id} value={value.id}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={appearance.value.preferences.showTechnicalStatus}
            onChange={(event) => tech(event.currentTarget.checked)}
          />
          Show technical information
        </label>
        <button type="button" disabled={!fixtureTraceOwner()} onClick={() => {
          const owner = fixtureTraceOwner();
          if (!owner) throw new Error('Fixture has no activity trace');
          toggleActivityTrace(owner);
        }}>
          Toggle activity
        </button>
        <button type="button" disabled={!conversationState.value?.conversation.connection.activeTurnId} onClick={() => advance('reply')}>
          Settle current turn
        </button>
        <button type="button" disabled={!!conversationState.value?.conversation.connection.activeTurnId} onClick={nextTurn}>
          Start next turn
        </button>
        {scene.value.startsWith('chapter-') ? <button type="button" disabled={!nextChapter} onClick={() => {
          if (!nextChapter) throw new Error('Fixture chapter sequence has ended');
          advance(nextChapter);
        }}>Advance chapter</button> : null}
        <p>
          Isolated production UI fixture. Send and Stop are simulated; all other network actions are blocked. Preferences are not
          saved.
        </p>
        {scene.value === 'idle-send' || scene.value === 'busy-send' ? <>
          <button type="button" disabled={!outstandingCount.value} onClick={() => respondToSend(true)}>Accept send</button>
          <button type="button" disabled={!outstandingCount.value} onClick={() => respondToSend(false)}>Fail send</button>
          <button type="button" disabled={!sendRequests.length} onClick={echoSend}>Echo message</button>
          <button type="button" disabled={!sendRequests.length} onClick={() => startResponse()}>Start response</button>
        </> : null}
      </header>
      <ChatMain />
      <ChoiceModal />
    </div>
  );
}

const disposeAppearance = initAppearance((message) => console.error(message));
window.addEventListener('pagehide', disposeAppearance, { once: true });
groupId.value = fixtureGroupId;
threadId.value = fixtureThreadId;
channelType.value = 'web';
threads.value = [{ threadId: fixtureThreadId, title: 'Status fixture', lastActivityAt: '', channelType: 'web' }];
completionSoundMutedSig.value = true;
progressSoundMutedSig.value = true;
const mobile = window.matchMedia('(max-width: 720px)');
isMobile.value = mobile.matches;
mobile.addEventListener('change', (event) => {
  isMobile.value = event.matches;
});
show('initial');
const root = document.getElementById('fixture-root');
if (!root) throw new Error('Fixture root is missing');
render(<Fixture />, root);
