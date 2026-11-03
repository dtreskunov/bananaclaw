import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, PendingQuestionDto } from '../types';
import * as utils from '../utils';
import { QuestionAnswerBubble } from './QuestionAnswerBubble';

vi.mock('../state', () => ({
  groupId: { value: 'group' },
  nowTick: { value: 0 },
  highlightMessageId: { value: null },
  searchQuery: { value: '' },
  currentUserId: { value: 'viewer' },
}));

const question: PendingQuestionDto = {
  kind: 'question',
  id: 'q',
  question: 'Which **day**?',
  responseMode: 'choice_or_text',
  options: [{ label: 'Monday', selectedLabel: 'Monday selected', value: 'monday' }],
  status: 'answered',
  answeredAt: null,
  threadId: 'thread',
  agentGroupId: 'group',
  createdAt: '2026-10-05T17:00:00Z',
  response: null,
};
const answer: ChatMessage = {
  id: 'question-response:q',
  questionId: 'q',
  questionResponseType: 'text',
  direction: 'in',
  text: '**Tuesday**',
  timestamp: '2026-10-05T17:01:00Z',
};

afterEach(() => vi.restoreAllMocks());

describe('answered question markdown', () => {
  it('renders the quoted question and response together using the existing renderer', () => {
    const renderMarkdown = vi.spyOn(utils, 'renderMarkdown');
    const bubble = QuestionAnswerBubble({ question, answer });
    expect(renderMarkdown).toHaveBeenCalledWith('> Which **day**?\n\n**Tuesday**', 'group');
    expect(bubble.props.class).toBe('msg in markdown');
    expect(bubble.props.children.props.dangerouslySetInnerHTML.__html).toBe(
      '<blockquote>\n<p>Which <strong>day</strong>?</p>\n</blockquote>\n<p><strong>Tuesday</strong></p>\n',
    );
    expect(bubble.props['data-msg-id']).toBe(answer.id);
    expect(bubble.props.timestamp).toBe(answer.timestamp);
  });

  it('quotes every question line, including blank lines, without quoting the answer', () => {
    const renderMarkdown = vi.spyOn(utils, 'renderMarkdown');
    const bubble = QuestionAnswerBubble({
      question: { ...question, question: 'First line\r\n\r\nSecond line\n- Third line' },
      answer: { ...answer, text: 'Answer\n\n- One\n- Two' },
    });
    expect(renderMarkdown).toHaveBeenCalledWith(
      '> First line\n> \n> Second line\n> - Third line\n\nAnswer\n\n- One\n- Two',
      'group',
    );
    const html = bubble.props.children.props.dangerouslySetInnerHTML.__html;
    expect(html).toContain('<blockquote>\n<p>First line</p>');
    expect(html).toContain('</blockquote>\n<p>Answer</p>\n<ul>\n<li>One</li>');
  });

  it('preserves Markdown links and code in the response', () => {
    const bubble = QuestionAnswerBubble({
      question,
      answer: { ...answer, text: '[Reference](https://example.com)\n\n```js\nconst day = "Tuesday";\n```' },
    });
    const html = bubble.props.children.props.dangerouslySetInnerHTML.__html;
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">Reference</a>');
    expect(html).toContain('<pre><code class="language-js">');
  });

  it('uses the selected option label rather than its stored value', () => {
    const bubble = QuestionAnswerBubble({
      question,
      answer: { ...answer, text: 'monday', questionResponseType: 'choice' },
    });
    expect(bubble.props.children.props.dangerouslySetInnerHTML.__html).toContain('<p>Monday selected</p>');
  });

  it('retains the answer text when it is not a stored choice', () => {
    const bubble = QuestionAnswerBubble({
      question,
      answer: { ...answer, text: 'Wednesday' },
    });

    expect(bubble.props.children.props.dangerouslySetInnerHTML.__html).toContain('<p>Wednesday</p>');
  });

  it('keeps literal text even when it equals an option value', () => {
    const bubble = QuestionAnswerBubble({ question, answer: { ...answer, text: 'monday' } });
    const html = bubble.props.children.props.dangerouslySetInnerHTML.__html;
    expect(html).toContain('<p>monday</p>');
    expect(html).not.toContain('Monday selected');
  });

  it('renders an explicit skip independently of choice labels', () => {
    const bubble = QuestionAnswerBubble({
      question: { ...question, options: [{ label: 'Fake', selectedLabel: 'Not skipped', value: 'Question skipped' }] },
      answer: { ...answer, questionResponseType: 'skipped', text: 'Question skipped' },
    });
    expect(bubble.props.children.props.dangerouslySetInnerHTML.__html).toContain(
      '</blockquote>\n<p>Question skipped</p>',
    );
  });

  it('retains the full quoted question and response if Markdown rendering is unavailable', () => {
    vi.spyOn(utils, 'renderMarkdown').mockReturnValue(null);
    const bubble = QuestionAnswerBubble({ question, answer });
    expect(bubble.props.class).toBe('msg in');
    expect(bubble.props.children.props.children).toBe('> Which **day**?\n\n**Tuesday**');
  });
  it("uses the shared sender label for another participant and omits the viewer's own label", () => {
    expect(
      QuestionAnswerBubble({
        question,
        answer: { ...answer, author: { userId: 'other', displayName: 'Alex' } },
      }).props.from,
    ).toBe('Alex');
    expect(
      QuestionAnswerBubble({
        question,
        answer: { ...answer, author: { userId: 'viewer', displayName: 'Me' } },
      }).props.from,
    ).toBeUndefined();
  });
});
