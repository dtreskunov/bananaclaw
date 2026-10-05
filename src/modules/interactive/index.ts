/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card and ends its turn.
 * This module records the response, writes a wake-eligible inbound event, and
 * wakes the session so the saved provider continuation resumes with the answer.
 *
 * The `createQuestion` call in `deliverMessage` (delivery.ts) stays inline in
 * core and is guarded by `hasTable('questions')`.
 * modularizing it adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { answerQuestion, getQuestion, getSession } from '../../db/sessions.js';
import type { Question } from '../../types.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { startTypingRefresh, stopTypingRefresh } from '../typing/index.js';

export async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'questions')) return false;

  const question = getQuestion(payload.questionId);
  if (!question) return false;
  if (question.status === 'cancelled') return true;

  if (question.status === 'pending') {
    const response =
      payload.responseType === 'skipped'
        ? { type: 'skipped' as const, value: null }
        : answerValue(question, payload.value);
    if (!response) return true;
    answerQuestion(payload.questionId, {
      ...response,
      userId: payload.userId,
      answeredAt: new Date().toISOString(),
    });
  }

  // Re-read after the conditional update. This is the canonical winner when
  // two responses race, and lets a retry finish writing the inbound event.
  const resolved = getQuestion(payload.questionId);
  if (resolved?.status === 'answered') await routeQuestionResponse(resolved);
  return true;
}

function answerValue(question: Question, value: string): { type: 'choice' | 'text'; value: string } | null {
  const matchingOption = question.options.find((option) => option.value === value);
  if (question.response_mode === 'choice' && !matchingOption) {
    log.warn('Question response is not one of the allowed choices', { questionId: question.question_id });
    return null;
  }
  if (!value.trim()) return null;
  return { type: matchingOption ? 'choice' : 'text', value };
}

async function routeQuestionResponse(question: Question): Promise<void> {
  const skipped = question.answer_type === 'skipped';
  const timestamp = question.answered_at;
  if (!timestamp || (!skipped && (!question.answer_value || !question.answer_type)))
    throw new Error(`Incomplete question response: ${question.question_id}`);
  const session = getSession(question.session_id);
  if (!session) {
    throw new Error(`Session not found for question: ${question.question_id}`);
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `question-response:${question.question_id}`,
    kind: 'interactive_response',
    timestamp,
    platformId: question.platform_id,
    channelType: question.channel_type,
    threadId: question.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: question.question_id,
      question: question.question_text,
      responseType: skipped ? 'skipped' : question.answer_type,
      ...(!skipped ? { value: question.answer_value } : {}),
      userId: question.answered_by ?? '',
    }),
    idempotent: true,
  });
  log.info('Question response routed', {
    questionId: question.question_id,
    responseType: skipped ? 'skipped' : question.answer_type,
    sessionId: session.id,
  });

  const messagingGroup = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (messagingGroup) {
    startTypingRefresh(
      session.id,
      session.agent_group_id,
      messagingGroup.channel_type,
      messagingGroup.platform_id,
      session.thread_id,
      messagingGroup.instance,
    );
  }
  const woke = await wakeContainer(session);
  if (!woke && messagingGroup) stopTypingRefresh(session.id);
}

registerResponseHandler(handleInteractiveResponse);
