import type { ChatMessage, PendingQuestionDto } from '../types';
import { RelativeTime } from './RelativeTime';

export function QuestionAnswerBubble({ question, answer }: { question: PendingQuestionDto; answer: ChatMessage }) {
  return (
    <div class="msg in question-card question-card-answered" data-msg-id={answer.id}>
      <div class="question-card-heading">{question.title}</div>
      <div class="question-card-title">{question.question}</div>
      <div class="question-card-answer">
        {question.options.find((option) => option.value === answer.text)?.selectedLabel ?? answer.text}
      </div>
      <div class="meta question-card-meta">
        <RelativeTime ts={answer.ts} />
      </div>
    </div>
  );
}
