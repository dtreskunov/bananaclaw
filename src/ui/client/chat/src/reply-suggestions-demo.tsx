import { render } from 'preact';
import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Conversation, ConversationMessage, ConversationTurn } from '../../../shared/conversation';
import { conversationState } from './conversation-state';
import { CONVERSATION_PROTOCOL_VERSION } from '../../../shared/conversation-protocol';
import { canSend, groupId, threadId } from './state';
import { bindInlineReplyControls, replySuggestionControls, SuggestedResponses } from './components/SuggestedResponses';
import { renderMarkdown } from './utils';
import { toastMessage } from './state';
import './reply-suggestions-demo.css';

const completed = signal(false);
const messages = signal<ConversationMessage[]>([]);
const draft = signal('');
const turn: ConversationTurn = {
  id: 'demo-turn',
  phase: 'settled',
  outcome: 'replied',
  startedAt: 1,
  endedAt: 2,
  inputIds: [],
  outputIds: ['demo-response'],
  activity: [],
  usage: [],
  metadata: { status: 'unavailable', model: null, durationMs: null },
};
const response: ConversationMessage = {
  id: 'demo-response',
  direction: 'out',
  timestamp: 2,
  turnId: turn.id,
  deliveryOrigin: 'response',
  text: 'I found three ways to reduce your budget. Start with [subscriptions](reply:Please%20review%20my%20subscriptions%20and%20identify%20unnecessary%20costs.) or [dining out](reply:Please%20suggest%20a%20realistic%20plan%20to%20reduce%20dining-out%20spending.).',
  suggestedResponses: ['Show all three approaches', 'Help me set a savings target'],
};
function sync(): void {
  const conversation: Conversation = {
    threadId: 'demo-thread',
    messages: messages.value,
    turns: completed.value ? [turn] : [],
    interactions: [],
    timeline: [],
    connection: { connected: true, activeTurnId: null },
    capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
  };
  conversationState.value = {
    kind: 'snapshot',
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    streamId: 'isolated-prototype',
    revision: 1,
    conversation,
  };
}
function reset(): void {
  completed.value = false;
  messages.value = [];
  draft.value = '';
  toastMessage.value = null;
  const input = document.getElementById('chat-input');
  if (input instanceof HTMLTextAreaElement) input.value = '';
  sync();
}
groupId.value = 'demo-group';
threadId.value = 'demo-thread';
canSend.value = true;
sync();

function DemoMessage({ message }: { message: ConversationMessage }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const controls = replySuggestionControls(message.id);
  const html = renderMarkdown(message.text, null, controls.active)!;
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = html;
    if (controls.active) bindInlineReplyControls(ref.current, controls);
  }, [html, controls.active, controls.disabled]);
  return (
    <article class={`msg ${message.direction}`}>
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {message.suggestedResponses ? <SuggestedResponses message={message} /> : null}
    </article>
  );
}

function Demo() {
  return (
    <main class="prototype">
      <header>
        <h1>Optional reply drafts</h1>
        <p>Isolated simulation. No service, credentials, agent calls, or live data.</p>
        <div class="demo-controls">
          <button
            type="button"
            onClick={() => {
              completed.value = true;
              messages.value = [response];
              sync();
            }}
            disabled={completed.value}
          >
            Complete agent response
          </button>
          <button type="button" onClick={reset}>
            Reset
          </button>
        </div>
      </header>
      <section class="transcript chat-main" aria-label="Transcript">
        {!completed.value ? (
          <p class="working" role="status">
            Agent is composing its response. The composer stays available.
          </p>
        ) : null}
        {messages.value.map((message) => (
          <DemoMessage key={message.id} message={message} />
        ))}
      </section>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = document.getElementById('chat-input');
          if (!(input instanceof HTMLTextAreaElement) || !input.value.trim()) return;
          messages.value = [
            ...messages.value,
            {
              id: `demo-input-${messages.value.length}`,
              direction: 'in',
              timestamp: Date.now(),
              text: input.value,
            },
          ];
          input.value = '';
          draft.value = '';
          sync();
        }}
      >
        <label for="chat-input">Your message</label>
        <textarea
          id="chat-input"
          rows={3}
          placeholder="Type anything, or choose a suggested draft"
          onInput={(event) => {
            draft.value = event.currentTarget.value;
          }}
        />
        <button type="submit" disabled={!draft.value.trim()}>
          Send in simulation
        </button>
        <p>Choosing a button fills this draft. Edit it before sending, or ignore the buttons.</p>
      </form>
      {toastMessage.value ? (
        <p class="demo-error" role="alert">
          {toastMessage.value.text}
        </p>
      ) : null}
    </main>
  );
}

const root = document.getElementById('prototype');
if (!root) throw new Error('Prototype root missing');
render(<Demo />, root);
