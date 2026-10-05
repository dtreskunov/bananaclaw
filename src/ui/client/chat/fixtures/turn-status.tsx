import { signal } from '@preact/signals';
import { render } from 'preact';
import type { Conversation, ConversationTurn } from '../../../shared/conversation';
import { CONVERSATION_PROTOCOL_VERSION, diffConversation } from '../../../shared/conversation-protocol';
import { conversationTimeline } from '../../../server/chat/conversation-timeline';
import { ChatMain } from '../src/components/ChatMain';
import { appearance, initAppearance } from '../src/appearance-state';
import { applyConversationFrame, conversationState, resetConversation } from '../src/conversation-state';
import { toggleActivityTrace } from '../src/activity-trace-state';
import { resetTurnState } from '../src/stop-turn';
import {
  channelType,
  completionSoundMutedSig,
  groupId,
  isMobile,
  stopRequest,
  progressSoundMutedSig,
  threadId,
  threads,
} from '../src/state';
import '../src/styles/global.css';
import './turn-status.css';

const scenes = [
  { id: 'initial', label: 'Initial Thinking…' },
  { id: 'running', label: 'Running tool' },
  { id: 'completed', label: 'Completed tool (Thinking…)' },
  { id: 'parallel', label: 'Parallel tools (both running)' },
  { id: 'parallel-completed', label: 'Parallel tools (one completed)' },
  { id: 'long', label: 'Long activity' },
  { id: 'stopping', label: 'Stopping' },
  { id: 'stop-error', label: 'Stop request failure' },
  { id: 'disconnected', label: 'Disconnected' },
  { id: 'settling', label: 'Settling' },
  { id: 'reply', label: 'Settled reply' },
  { id: 'empty-reply', label: 'Settled reply (no recorded steps)' },
  { id: 'outputless', label: 'Settled without reply' },
  { id: 'failed', label: 'Failed reply' },
  { id: 'card', label: 'Settled display card' },
] as const;
type Scene = (typeof scenes)[number]['id'];
const scene = signal<Scene>('initial');
const fixtureTurnId = 'fixture-status-turn';
const fixtureThreadId = 'fixture-status-thread';
const fixtureGroupId = 'fixture-status-group';
const requests: { url: string; turnId: string }[] = [];
const stopFailure = 'Simulated Stop failure. Try again.';
let generation = 0;

function makeConversation(nextScene: Scene, startedAt = new Date(Date.now() - 7000).toISOString()): Conversation {
  const started = Date.parse(startedAt);
  const testing = nextScene === 'running' || nextScene === 'parallel' || nextScene === 'parallel-completed';
  const settled = ['reply', 'empty-reply', 'outputless', 'failed', 'card'].includes(nextScene);
  const phase = settled
    ? 'settled'
    : nextScene === 'stopping'
      ? 'stopping'
      : nextScene === 'settling'
        ? 'settling'
        : 'running';
  const activity: ConversationTurn['activity'] =
    nextScene === 'initial' || nextScene === 'empty-reply'
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
  const hasReply = settled && nextScene !== 'outputless';
  const turn: ConversationTurn = {
    id: fixtureTurnId,
    phase,
    outcome: !settled ? 'pending' : nextScene === 'failed' ? 'failed' : hasReply ? 'replied' : 'silent',
    startedAt,
    endedAt: settled ? new Date(started + 12_000).toISOString() : null,
    inputIds: ['fixture-status-input'],
    outputIds: hasReply ? ['fixture-status-reply'] : [],
    activity,
    usage: settled
      ? [
          {
            id: 'fixture-status-usage',
            value: {
              cost_usd: 0.0123,
              model: 'fixture-model',
              duration_ms: 10_000,
              input_tokens: 2500,
              output_tokens: 350,
              context_tokens: 8000,
              context_window: 200_000,
            },
          },
        ]
      : [],
    liveUsage: settled
      ? null
      : {
          cost_usd: 0.004,
          model: 'fixture-model',
          input_tokens: 2100,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          context_tokens: 7500,
          context_window: 200_000,
        },
    metadata: {
      status: nextScene === 'failed' ? 'partial' : settled ? 'final' : 'provisional',
      model: 'fixture-model',
      durationMs: settled ? 12_000 : null,
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
      },
      ...(hasReply
        ? [
            {
              id: 'fixture-status-reply',
              direction: 'out' as const,
              turnId: fixtureTurnId,
              deliveryOrigin: 'response' as const,
              text: nextScene === 'failed' ? 'The fixture response failed.' : 'The **fixture response** is complete.',
              timestamp: new Date(started + 12_000).toISOString(),
              timelinePosition: (started + 12_000) * 1000,
              ...(nextScene === 'card'
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
    capabilities: { canSend: true, stop: !settled, steer: false, editInput: false, cancelInput: false },
  };
  return { ...view, timeline: conversationTimeline(view) };
}

function show(nextScene: Scene): void {
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
  const previous = conversationState.peek();
  if (!previous) throw new Error('Fixture conversation is missing');
  const startedAt = previous.conversation.turns[0]?.startedAt;
  if (!startedAt) throw new Error('Fixture turn start time is missing');
  const next = makeConversation(nextScene, startedAt);
  if (nextScene === 'stopping') {
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

function tech(enabled: boolean): void {
  appearance.value = {
    ...appearance.peek(),
    preferences: { ...appearance.peek().preferences, showTechnicalStatus: enabled },
  };
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== `api/groups/${fixtureGroupId}/chat/${fixtureThreadId}/stop` || init?.method !== 'POST')
    throw new Error(`Fixture blocked network request: ${url}`);
  if (typeof init.body !== 'string') throw new Error('Fixture stop request body is missing');
  const body: unknown = JSON.parse(init.body);
  if (!body || typeof body !== 'object' || !('turnId' in body) || body.turnId !== fixtureTurnId)
    throw new Error('Fixture received an invalid stop target');
  requests.push({ url, turnId: fixtureTurnId });
  if (scene.peek() === 'stop-error')
    return new Response(JSON.stringify({ error: stopFailure }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  advance('stopping');
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

interface FixtureApi {
  show: typeof show;
  advance: typeof advance;
  tech: typeof tech;
  inspect: () => { scene: Scene; requests: { url: string; turnId: string }[]; conversation: Conversation };
}
declare global {
  interface Window {
    turnStatusFixture: FixtureApi;
  }
}
window.turnStatusFixture = {
  show,
  advance,
  tech,
  inspect() {
    const current = conversationState.peek();
    if (!current) throw new Error('Fixture conversation is missing');
    return {
      scene: scene.peek(),
      requests: structuredClone(requests),
      conversation: structuredClone(current.conversation),
    };
  },
};

function Fixture() {
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
        <button type="button" onClick={() => toggleActivityTrace(`turn:${fixtureTurnId}`, true)}>
          Toggle activity
        </button>
        <button type="button" onClick={() => advance('reply')}>
          Settle current turn
        </button>
        <p>
          Isolated production UI fixture. Stop is simulated; all other network actions are blocked. Preferences are not
          saved.
        </p>
      </header>
      <ChatMain />
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
