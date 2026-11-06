/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card and ends its turn.
 * This module records the response, writes a wake-eligible inbound event, and
 * wakes the session so the saved provider continuation resumes with the answer.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { answerQuestion, getQuestion, getSession } from '../../db/sessions.js';
import type { Question } from '../../types.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { startTypingRefresh, stopTypingRefresh } from '../typing/index.js';
import { questionAcceptsResponse } from '../../ui/shared/question.js';
import { isQuestionResponse } from '../../ui/shared/conversation-protocol.js';

export async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  const question = getQuestion(payload.questionId);
  if (!question) return false;
  if (question.status === 'cancelled') return true;
  if (question.status === 'pending') {
    if (
      !isQuestionResponse(payload) ||
      !questionAcceptsResponse(question.input.responseMode, question.input.options, payload)
    ) {
      log.warn('Question response does not match the requested input', { questionId: payload.questionId });
      return true;
    }
    answerQuestion(payload.questionId, {
      ...payload,
      answeredAt: Date.now(),
    });
  }

  // Re-read after the conditional update. This is the canonical winner when
  // two responses race, and lets a retry finish writing the inbound event.
  const resolved = getQuestion(payload.questionId);
  if (resolved?.status === 'answered') await routeQuestionResponse(resolved);
  return true;
}

async function routeQuestionResponse(question: Extract<Question, { status: 'answered' }>): Promise<void> {
  const timestamp = question.responded_at;
  const session = getSession(question.session_id);
  if (!session) {
    throw new Error(`Session not found for question: ${question.id}`);
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `question-response:${question.id}`,
    kind: 'interactive_response',
    timestamp,
    platformId: question.platform_id,
    channelType: question.channel_type,
    threadId: question.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: question.id,
      question: question.input.question,
      ...question.response,
      userId: question.responded_by ?? '',
    }),
    idempotent: true,
  });
  log.info('Question response routed', {
    questionId: question.id,
    responseType: question.response.responseType,
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
