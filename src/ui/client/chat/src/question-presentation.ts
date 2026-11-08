import { formatQuestionResponse } from '../../../../channels/ask-question';
import type { ChatMessage, PendingQuestionDto } from './types';

export function questionAnswerText(question: PendingQuestionDto, answer: ChatMessage): string {
  const response =
    answer.questionResponseType === 'skipped'
      ? 'Question skipped'
      : answer.questionResponseType === 'choice'
        ? (question.options.find((option) => option.value === answer.text)?.selectedLabel ?? answer.text)
        : answer.text;
  return formatQuestionResponse(question.question, response);
}
