import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindInlineReplyControls, replySuggestionControls, SuggestedResponses } from './SuggestedResponses';
import { conversationState } from '../conversation-state';
import { testSnapshot, testTurn } from '../conversation-test-fixtures';
import { canSend, channelType, groupId, messagingGroupId, pendingWebSends, threadId, toastMessage } from '../state';
import { dismissToast } from './Toast';
import type { ConversationMessage } from '../../../../shared/conversation';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));

class DraftInput {
  value = '';
  disabled = false;
  readOnly = false;
  dispatchEvent = vi.fn();
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
  suggestedResponses: ['Explore costs'],
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
  pendingWebSends.value = [];
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
  it('wires an inline button to its encoded full draft, not its short label', () => {
    const button = {
      textContent: 'Fix references',
      dataset: { replyDraft: 'Please fix the dangling references first.' },
      disabled: true,
      addEventListener: vi.fn(),
    };
    const root = { querySelectorAll: vi.fn().mockReturnValue([button]) };
    bindInlineReplyControls(root, replySuggestionControls(message.id));
    expect(button.disabled).toBe(false);
    expect(button.addEventListener.mock.calls[0][0]).toBe('click');
    button.addEventListener.mock.calls[0][1]();
    expect(input.value).toBe('Please fix the dangling references first.');
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
  });
  it('fills a fuller inline draft without submitting and preserves an occupied draft', () => {
    const controls = replySuggestionControls(message.id);
    controls.choose('Please fix the dangling references first.');
    expect(input.value).toBe('Please fix the dangling references first.');
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
    controls.choose('A different suggestion');
    expect(input.value).toBe('Please fix the dangling references first.');
    expect(toastMessage.value?.text).toContain('Your draft has been kept');
  });

  it('hides separate suggestions when a later message is sent', () => {
    expect(SuggestedResponses({ message })).not.toBeNull();
    conversationState.value = testSnapshot({
      messages: [message, { id: 'next', direction: 'in', timestamp: 2, text: 'A new choice' }],
      turns: [turn],
    });
    expect(SuggestedResponses({ message })).toBeNull();
  });

  it('rejects a stale click after navigation or a newly accepted follow-up', () => {
    const controls = replySuggestionControls(message.id);
    threadId.value = 'another-thread';
    controls.choose('Must not replace another conversation draft');
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
    expect(input.value).toBe('');
  });
});
