import { describe, expect, it, vi } from 'vitest';
import { fillSuggestedDraft, isReplyLabel, suggestionsActive } from './reply-suggestions';
import { testTurn } from './conversation-test-fixtures';
import type { ConversationMessage } from '../../../shared/conversation';

const response: ConversationMessage = {
  id: 'reply',
  direction: 'out',
  timestamp: 1,
  text: 'Here are your options.',
  deliveryOrigin: 'response',
  turnId: testTurn.id,
};
const turn = { ...testTurn, phase: 'settled' as const, outcome: 'replied' as const, outputIds: [response.id] };

describe('reply draft suggestions', () => {
  it('does not turn a response sent to another agent into reply suggestions for the human', () => {
    expect(
      suggestionsActive(
        'reply',
        [
          {
            ...response,
            recipient: { agentGroupId: 'peer', displayName: 'Peer' },
          },
        ],
        [turn],
        false,
      ),
    ).toBe(false);
  });
  it('validates rendered labels without URL decoding', () => {
    for (const label of ['Take food', 'Use A & B (not C)', 'Keep %20 literal', 'Discuss 日本', 'x'.repeat(240)])
      expect(isReplyLabel(label)).toBe(true);
    for (const label of ['', ' ', 'x'.repeat(241), '\u0000Hidden', '\rHidden', 'Hidden\u007f'])
      expect(isReplyLabel(label)).toBe(false);
  });

  it('expires reply links after a follow-up', () => {
    const inline = {
      ...response,
      text: '[Fix references](reply:)',
    };
    expect(suggestionsActive('reply', [inline], [turn], false)).toBe(true);
    const followup: ConversationMessage = { id: 'later', direction: 'in', timestamp: 2, text: 'Something else' };
    expect(suggestionsActive('reply', [inline, followup], [turn], false)).toBe(false);
    const newer = { ...inline, id: 'newer', timestamp: 3 };
    expect(suggestionsActive('reply', [inline, newer], [turn], false)).toBe(false);
    expect(suggestionsActive('newer', [inline, newer], [turn], false)).toBe(true);
  });
  it('is active only for a completed final response without a follow-up', () => {
    expect(suggestionsActive('reply', [response], [turn], false)).toBe(true);
    expect(suggestionsActive('reply', [response], [{ ...turn, phase: 'running' }], false)).toBe(false);
    expect(suggestionsActive('reply', [response], [{ ...turn, outcome: 'failed' }], false)).toBe(false);
    expect(suggestionsActive('reply', [response], [turn], true)).toBe(false);
    const followup: ConversationMessage = { id: 'input', direction: 'in', timestamp: 2, text: 'Something else' };
    expect(suggestionsActive('reply', [response, followup], [turn], false)).toBe(false);
    expect(suggestionsActive('reply', [], [turn], false)).toBe(false);
    expect(suggestionsActive('reply', [{ ...response, deliveryOrigin: 'send_message' }], [turn], false)).toBe(false);
  });

  it('fills exactly the visible message, emits input, and never submits', () => {
    const input = {
      ...draftInput(''),
      form: { requestSubmit: vi.fn() },
    };
    expect(fillSuggestedDraft(input, 'Explore costs')).toEqual({ filled: true });
    expect(input.value).toBe('Explore costs');
    expect(input.dispatchEvent).toHaveBeenCalledOnce();
    expect(input.dispatchEvent.mock.calls[0][0]).toMatchObject({ type: 'input', bubbles: true });
    expect(input.focus).toHaveBeenCalledOnce();
    expect(input.setSelectionRange).toHaveBeenCalledWith(13, 13);
    expect(input.form.requestSubmit).not.toHaveBeenCalled();
  });

  it('replaces an unedited suggestion and installs only one listener per composer', () => {
    const input = draftInput('');
    expect(fillSuggestedDraft(input, 'Explore costs', 'thread')).toEqual({ filled: true });
    expect(fillSuggestedDraft(input, 'Show alternatives', 'thread')).toEqual({ filled: true });
    expect(input.value).toBe('Show alternatives');
    expect(input.addEventListener).toHaveBeenCalledOnce();
    expect(input.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('protects edited suggestions even after undoing back to the original text', () => {
    const input = draftInput('');
    fillSuggestedDraft(input, 'Explore costs');
    input.value = 'Explore costs for next year';
    input.dispatchEvent(new Event('input'));
    expect(fillSuggestedDraft(input, 'Show alternatives')).toMatchObject({ filled: false });
    expect(input.value).toBe('Explore costs for next year');
    input.value = 'Explore costs';
    input.dispatchEvent(new Event('input'));
    expect(fillSuggestedDraft(input, 'Show alternatives')).toMatchObject({ filled: false });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(fillSuggestedDraft(input, 'Show alternatives')).toEqual({ filled: true });
  });

  it('does not infer suggestion ownership from text or leak it across conversations and inputs', () => {
    const input = draftInput('');
    fillSuggestedDraft(input, 'Explore costs', 'first-thread');
    expect(fillSuggestedDraft(input, 'Show alternatives', 'second-thread')).toMatchObject({ filled: false });
    expect(fillSuggestedDraft(draftInput('Explore costs'), 'Show alternatives', 'first-thread')).toMatchObject({
      filled: false,
    });
    input.value = '';
    input.value = 'Explore costs';
    input.dispatchEvent(new Event('input'));
    expect(fillSuggestedDraft(input, 'Show alternatives', 'first-thread')).toMatchObject({ filled: false });
  });

  it('keeps existing drafts, including whitespace, and refuses locked input', () => {
    for (const value of ['My own message', ' ']) {
      const input = draftInput(value);
      expect(fillSuggestedDraft(input, 'Suggested text')).toMatchObject({ filled: false });
      expect(input.value).toBe(value);
    }
    expect(fillSuggestedDraft(null, 'Draft')).toMatchObject({ filled: false });
    expect(fillSuggestedDraft({ ...draftInput(''), disabled: true }, 'Draft')).toMatchObject({ filled: false });
    expect(fillSuggestedDraft({ ...draftInput(''), readOnly: true }, 'Draft')).toMatchObject({ filled: false });
  });

  function draftInput(value: string) {
    const events = new EventTarget();
    return {
      value,
      disabled: false,
      readOnly: false,
      addEventListener: vi.fn(events.addEventListener.bind(events)),
      dispatchEvent: vi.fn(events.dispatchEvent.bind(events)),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };
  }
});
