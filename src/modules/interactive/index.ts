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
import { answerQuestion, getQuestion, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

export async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'questions')) return false;

  const question = getQuestion(payload.questionId);
  if (!question) return false;
  if (question.status === 'cancelled') return true;

  if (question.status === 'pending') {
    const matchingOption = question.options.find((option) => option.value === payload.value);
    if (question.response_mode === 'choice' && !matchingOption) {
      log.warn('Question response is not one of the allowed choices', { questionId: payload.questionId });
      return true;
    }
    if (!payload.value.trim()) return true;
    answerQuestion(payload.questionId, {
      value: payload.value,
      type: matchingOption ? 'choice' : 'text',
      userId: payload.userId,
      answeredAt: new Date().toISOString(),
    });
  }

  // Re-read after the conditional update. This is the canonical winner when
  // two responses race, and lets a retry finish writing the inbound event.
  const answered = getQuestion(payload.questionId);
  if (!answered || answered.status !== 'answered' || !answered.answer_value || !answered.answer_type) return true;

  const session = getSession(answered.session_id);
  if (!session) {
    log.warn('Session not found for question', { questionId: payload.questionId, sessionId: answered.session_id });
    return true; // claimed — we owned this questionId even though the session is gone
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `question-response:${payload.questionId}`,
    kind: 'interactive_response',
    timestamp: answered.answered_at ?? new Date().toISOString(),
    platformId: answered.platform_id,
    channelType: answered.channel_type,
    threadId: answered.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      title: answered.title,
      question: answered.question_text,
      responseType: answered.answer_type,
      value: answered.answer_value,
      userId: answered.answered_by ?? '',
    }),
    idempotent: true,
  });
  log.info('Question response routed', {
    questionId: payload.questionId,
    value: answered.answer_value,
    sessionId: session.id,
  });

  await wakeContainer(session);
  return true;
}

registerResponseHandler(handleInteractiveResponse);
