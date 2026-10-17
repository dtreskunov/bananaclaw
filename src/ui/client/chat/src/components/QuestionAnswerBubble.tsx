import { formatQuestionResponse } from '../../../../../channels/ask-question';
import { groupId, highlightMessageId, searchQuery } from '../state';
import type { ChatMessage, PendingQuestionDto } from '../types';
import { renderMarkdown } from '../utils';
import { RelativeTime } from './RelativeTime';
import { MessagePreview } from './MessagePreview';

export function QuestionAnswerBubble({ question, answer }: { question: PendingQuestionDto; answer: ChatMessage }) {
  const response = answer.questionResponseType === 'skipped'
    ? 'Question skipped'
    : (question.options.find((option) => option.value === answer.text)?.selectedLabel ?? answer.text);
  const text = formatQuestionResponse(question.question, response);
  const md = renderMarkdown(text, groupId.value);
  return (
    <div class={`msg in${md != null ? ' markdown' : ''}`} data-msg-id={answer.id}>
      <MessagePreview reveal={highlightMessageId.value === answer.id && !!searchQuery.value}>
      {md != null
        ? <div class="transcript-copy-content" dangerouslySetInnerHTML={{ __html: md }} />
        : <div class="transcript-copy-content">{text}</div>}
      </MessagePreview>
      <div class="meta">
        <RelativeTime ts={answer.ts} />
      </div>
    </div>
  );
}
