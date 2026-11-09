import { describe, expect, it, vi } from 'vitest';
import { fillSuggestedDraft, inlineReplyDraft, suggestionsActive } from './reply-suggestions';
import { testTurn } from './conversation-test-fixtures';
import type { ConversationMessage } from '../../../shared/conversation';

const response: ConversationMessage = {
  id: 'reply',
  direction: 'out',
  timestamp: 1,
  text: 'Here are your options.',
  deliveryOrigin: 'response',
  turnId: testTurn.id,
  suggestedResponses: ['Explore costs', 'Show alternatives'],
};
const turn = { ...testTurn, phase: 'settled' as const, outcome: 'replied' as const, outputIds: [response.id] };

describe('reply draft suggestions', () => {
  it('decodes an inline draft independently of its link label', () => {
    expect(inlineReplyDraft('reply:Please%20fix%20the%20references.')).toBe('Please fix the references.');
    expect(inlineReplyDraft('reply:Use%20A%20%26%20B%20%28not%20C%29')).toBe('Use A & B (not C)');
    expect(inlineReplyDraft('reply:Discuss%20%E6%97%A5%E6%9C%AC')).toBe('Discuss 日本');
    expect(inlineReplyDraft('reply:Keep%20%2520%20literal')).toBe('Keep %20 literal');
    for (const href of [
      'https://example.test',
      'reply:',
      'reply:%20',
      'reply:%ZZ',
      'reply:%00',
      `reply:${'x'.repeat(241)}`,
      'reply:%0DHidden',
    ]) {
      expect(inlineReplyDraft(href)).toBeNull();
    }
  });

  it('allows inline-only replies and expires both presentations after a follow-up', () => {
    const inline = {
      ...response,
      suggestedResponses: undefined,
      text: '[Fix references](reply:Please%20fix%20references)',
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
      value: '',
      disabled: false,
      readOnly: false,
      dispatchEvent: vi.fn(),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
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
    return {
      value,
      disabled: false,
      readOnly: false,
      dispatchEvent: vi.fn(),
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };
  }
});
