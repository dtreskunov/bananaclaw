import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { mountInlineReplySuggestions, replySuggestionControls } from './SuggestedResponses';
import { ReplySuggestion } from './ReplySuggestion';
import { sendChat } from '../actions';
import { conversationState } from '../conversation-state';
import { testSnapshot, testTurn } from '../conversation-test-fixtures';
import {
  canSend,
  channelType,
  chatReady,
  groupId,
  messagingGroupId,
  pending,
  pendingWebSends,
  pinnedContext,
  threadId,
  toastMessage,
} from '../state';
import { dismissToast } from './Toast';
import type { ConversationMessage } from '../../../../shared/conversation';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('preact', async (original) => ({
  ...(await original<typeof import('preact')>()),
  render: vi.fn(),
}));
vi.mock('../actions', () => ({ sendChat: vi.fn() }));

class DraftInput extends EventTarget {
  value = '';
  disabled = false;
  readOnly = false;
  override dispatchEvent = vi.fn((event: Event) => super.dispatchEvent(event));
  focus = vi.fn();
  setSelectionRange = vi.fn();
  form = { requestSubmit: vi.fn() };
}
const message: ConversationMessage = {
  id: 'reply',
  direction: 'out',
  timestamp: 1,
  text: 'Choose a next step.',
  turnId: testTurn.id,
  deliveryOrigin: 'response',
};
const turn = { ...testTurn, phase: 'settled' as const, outcome: 'replied' as const, outputIds: ['reply'] };
let input: DraftInput;

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  groupId.value = 'group';
  threadId.value = 'thread';
  channelType.value = 'web';
  messagingGroupId.value = null;
  canSend.value = true;
  chatReady.value = true;
  pending.value = [];
  pinnedContext.value = [];
  pendingWebSends.value = [];
  vi.mocked(sendChat).mockReset().mockResolvedValue(true);
  vi.mocked(render).mockClear();
  conversationState.value = testSnapshot({ messages: [message], turns: [turn] });
  input = new DraftInput();
  vi.stubGlobal('HTMLTextAreaElement', DraftInput);
  vi.stubGlobal('document', { getElementById: () => input });
});
afterEach(() => {
  while (toastMessage.value) dismissToast();
  vi.unstubAllGlobals();
});

describe('shared reply controls', () => {
  it('mounts the shared component inline and cleans it up before replacing Markdown', () => {
    const slot = {
      textContent: 'Fix references',
      innerHTML: '<strong>Fix</strong> references',
      replaceChildren: vi.fn(),
    };
    const root = { querySelectorAll: vi.fn().mockReturnValue([slot]) };
    const controls = replySuggestionControls(message.id);
    const clear = mountInlineReplySuggestions(root, controls);
    expect(slot.replaceChildren).toHaveBeenCalledOnce();
    expect(slot.replaceChildren.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(render).mock.invocationCallOrder[0],
    );
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ReplySuggestion,
        props: expect.objectContaining({
          label: 'Fix references',
          labelHtml: '<strong>Fix</strong> references',
          onChoose: controls.choose,
          onSend: expect.any(Function),
        }),
      }),
      slot,
    );
    controls.choose(slot.textContent);
    expect(input.value).toBe('Fix references');
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
    clear();
    expect(render).toHaveBeenLastCalledWith(null, slot);
  });

  it('sends and edits the rendered label, never a hidden destination payload', async () => {
    const slot = {
      textContent: 'Take the food',
      innerHTML: 'Take the food',
      dataset: { replyDraft: 'take food' },
      replaceChildren: vi.fn(),
    };
    const root = { querySelectorAll: vi.fn().mockReturnValue([slot]) };
    mountInlineReplySuggestions(root, replySuggestionControls(message.id));
    const vnode = vi.mocked(render).mock.calls[0][0];
    if (!vnode || typeof vnode !== 'object' || !('props' in vnode)) throw new Error('Reply control did not mount');
    const props = vnode.props;
    if (
      !('label' in props) ||
      typeof props.label !== 'string' ||
      !('onChoose' in props) ||
      typeof props.onChoose !== 'function' ||
      !('onSend' in props) ||
      typeof props.onSend !== 'function'
    )
      throw new Error('Reply control has no actions');
    expect(props.label).toBe('Take the food');
    expect(props).not.toHaveProperty('draft');
    props.onChoose(props.label);
    expect(input.value).toBe('Take the food');
    props.onSend(props.label);
    await vi.waitFor(() => expect(sendChat).toHaveBeenCalledExactlyOnceWith('Take the food', []));
  });

  it.each(['', '   ', 'x'.repeat(241), 'Hidden\u0000text'])(
    'does not mount an invalid reply label %j',
    (textContent) => {
      const slot = { textContent, innerHTML: textContent, replaceChildren: vi.fn() };
      mountInlineReplySuggestions(
        { querySelectorAll: vi.fn().mockReturnValue([slot]) },
        replySuggestionControls(message.id),
      )();
      expect(render).not.toHaveBeenCalled();
      expect(slot.replaceChildren).not.toHaveBeenCalled();
    },
  );
  it('switches between reply drafts without submitting', () => {
    const controls = replySuggestionControls(message.id);
    controls.choose('Please fix the dangling references first.');
    expect(input.value).toBe('Please fix the dangling references first.');
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
    controls.choose('Explore costs');
    expect(input.value).toBe('Explore costs');
    controls.choose('Another inline suggestion');
    expect(input.value).toBe('Another inline suggestion');
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
    expect(toastMessage.value).toBeNull();
  });

  it('gives a neutral, auto-dismissing notice for an existing or edited draft', () => {
    vi.useFakeTimers();
    try {
      const controls = replySuggestionControls(message.id);
      controls.choose('A suggestion');
      input.value = 'My edited reply';
      input.dispatchEvent(new Event('input'));
      controls.choose('A different suggestion');
      expect(input.value).toBe('My edited reply');
      expect(toastMessage.value?.text).toBe('Finish or clear your draft to try a suggestion.');
      expect(toastMessage.value?.kind).toBe('ok');
      expect(toastMessage.value?.action).toBeUndefined();
      vi.advanceTimersByTime(1800);
      expect(toastMessage.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mount reply controls when a later message is sent', () => {
    expect(replySuggestionControls(message.id).active).toBe(true);
    conversationState.value = testSnapshot({
      messages: [message, { id: 'next', direction: 'in', timestamp: 2, text: 'A new choice' }],
      turns: [turn],
    });
    expect(replySuggestionControls(message.id).active).toBe(false);
    const root = { querySelectorAll: vi.fn() };
    mountInlineReplySuggestions(root, replySuggestionControls(message.id))();
    expect(root.querySelectorAll).not.toHaveBeenCalled();
  });

  it('sends only its suggestion and preserves the draft, attachments and context', async () => {
    input.value = 'An unrelated unsent draft';
    pending.value = [{ name: 'keep.txt', size: 12 }];
    pinnedContext.value = ['keep/context.md'];
    const files = pending.value;
    const pins = pinnedContext.value;
    expect(await replySuggestionControls(message.id).send('Send this suggestion directly')).toBe(true);
    expect(sendChat).toHaveBeenCalledExactlyOnceWith('Send this suggestion directly', []);
    expect(input.value).toBe('An unrelated unsent draft');
    expect(input.dispatchEvent).not.toHaveBeenCalled();
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toBe(pins);
  });

  it('locks all suggestion arrows for a conversation until a send finishes', async () => {
    let finish: ((sent: boolean) => void) | undefined;
    vi.mocked(sendChat).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const first = replySuggestionControls(message.id).send('First');
    expect(replySuggestionControls(message.id).sendDisabled).toBe(true);
    expect(await replySuggestionControls(message.id).send('Second')).toBe(false);
    expect(sendChat).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Send did not start');
    finish(false);
    expect(await first).toBe(false);
    expect(replySuggestionControls(message.id).sendDisabled).toBe(false);
    vi.mocked(sendChat).mockResolvedValue(true);
    expect(await replySuggestionControls(message.id).send('Retry')).toBe(true);
  });

  it('disables direct sends while disconnected but still allows drafting', async () => {
    chatReady.value = false;
    const controls = replySuggestionControls(message.id);
    expect(controls.active).toBe(true);
    expect(controls.sendDisabled).toBe(true);
    expect(await controls.send('Must not send')).toBe(false);
    controls.choose('Keep an editable draft');
    expect(input.value).toBe('Keep an editable draft');
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('surfaces unexpected send errors without changing the draft and releases the lock', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      input.value = 'Keep my draft';
      vi.mocked(sendChat).mockRejectedValue(new Error('Unexpected send failure'));
      expect(await replySuggestionControls(message.id).send('Try sending')).toBe(false);
      expect(log).toHaveBeenCalled();
      expect(toastMessage.value?.kind).toBe('err');
      expect(toastMessage.value?.text).toContain('Could not send');
      expect(input.value).toBe('Keep my draft');
      expect(replySuggestionControls(message.id).sendDisabled).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('rejects stale draft and send clicks after navigation or an accepted follow-up', async () => {
    const controls = replySuggestionControls(message.id);
    threadId.value = 'another-thread';
    controls.choose('Must not replace another conversation draft');
    expect(await controls.send('Must not send in another thread')).toBe(false);
    expect(input.value).toBe('');
    threadId.value = 'thread';
    pendingWebSends.value = [
      {
        groupId: 'group',
        threadId: 'thread',
        messageId: 'pending',
        clientMessageId: 'pending',
        text: 'Something else',
        files: [],
        timestamp: 2,
        startsResponse: true,
        status: 'sending',
      },
    ];
    controls.choose('Expired suggestion');
    expect(await controls.send('Expired send')).toBe(false);
    expect(input.value).toBe('');
    expect(sendChat).not.toHaveBeenCalled();
  });
});
