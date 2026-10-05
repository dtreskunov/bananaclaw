import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn().mockResolvedValue(true);
const mockStartTypingRefresh = vi.fn();
const mockStopTypingRefresh = vi.fn();

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
}));

vi.mock('../typing/index.js', () => ({
  startTypingRefresh: (...args: unknown[]) => mockStartTypingRefresh(...args),
  stopTypingRefresh: (...args: unknown[]) => mockStopTypingRefresh(...args),
}));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createQuestion,
  createSession,
  getQuestion,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { handleInteractiveResponse } from './index.js';
import type { ResponsePayload } from '../../response-registry.js';
import { getDb } from '../../db/connection.js';

const QUESTION_ID = 'question-1';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'group-1',
    name: 'Group',
    folder: 'group',
    agent_provider: null,
    created_at: '2026-01-01T00:00:00Z',
  });
  createMessagingGroup({
    id: 'messaging-1',
    channel_type: 'web',
    platform_id: 'user-1',
    name: 'Web',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-01-01T00:00:00Z',
  });
  createSession({
    id: 'session-1',
    agent_group_id: 'group-1',
    messaging_group_id: 'messaging-1',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-01-01T00:00:00Z',
  });
  mockWriteSessionMessage.mockClear();
  mockWakeContainer.mockReset().mockResolvedValue(true);
  mockStartTypingRefresh.mockClear();
  mockStopTypingRefresh.mockClear();
});

afterEach(() => closeDb());

function seedQuestion(responseMode: 'choice' | 'text' | 'choice_or_text'): void {
  createQuestion({
    question_id: QUESTION_ID,
    session_id: 'session-1',
    message_out_id: 'message-out-1',
    in_reply_to: 'message-in-1',
    platform_id: 'user-1',
    channel_type: 'web',
    thread_id: 'thread-1',
    title: 'Environment',
    question_text: 'Which environment?',
    response_mode: responseMode,
    options: [{ label: 'Production', selectedLabel: 'Production', value: 'prod' }],
    status: 'pending',
    answer_value: null,
    answer_type: null,
    answered_by: null,
    answered_at: null,
    cancelled_at: null,
    created_at: '2026-01-01T00:00:00Z',
  });
}

function response(value: string) {
  return {
    questionId: QUESTION_ID,
    value,
    userId: null,
    channelType: 'web',
    platformId: 'user-1',
    threadId: 'thread-1',
  };
}

function skip(userId = 'skipper'): ResponsePayload {
  return {
    questionId: QUESTION_ID,
    responseType: 'skipped',
    userId,
    channelType: 'web',
    platformId: 'user-1',
    threadId: 'thread-1',
  };
}

describe('handleInteractiveResponse', () => {
  it.each(['choice', 'text', 'choice_or_text'] as const)(
    'records and routes a typed skip for a %s question without an answer value',
    async (mode) => {
      seedQuestion(mode);
      expect(await handleInteractiveResponse(skip())).toBe(true);
      const question = getQuestion(QUESTION_ID)!;
      expect(question).toMatchObject({
        status: 'answered',
        answer_type: 'skipped',
        answer_value: null,
        answered_by: 'skipper',
        cancelled_at: null,
      });
      expect(question.answered_at).toBeTruthy();
      const message = mockWriteSessionMessage.mock.calls[0][2];
      expect(message).toMatchObject({
        id: `question-response:${QUESTION_ID}`,
        kind: 'interactive_response',
        timestamp: question.answered_at,
        idempotent: true,
        platformId: 'user-1',
        channelType: 'web',
        threadId: 'thread-1',
      });
      expect(JSON.parse(message.content)).toEqual({
        type: 'question_response',
        questionId: QUESTION_ID,
        title: 'Environment',
        question: 'Which environment?',
        responseType: 'skipped',
        userId: 'skipper',
      });
      expect(mockWakeContainer).toHaveBeenCalledOnce();
    },
  );

  it.each(['answer', 'skip'] as const)('keeps the first %s when an answer and skip race', async (first) => {
    seedQuestion('text');
    const requests = first === 'answer' ? [response('First'), skip()] : [skip(), response('Later')];
    await Promise.all(requests.map(handleInteractiveResponse));
    expect(getQuestion(QUESTION_ID)).toMatchObject({
      answer_type: first === 'answer' ? 'text' : 'skipped',
      answer_value: first === 'answer' ? 'First' : null,
    });
    expect(mockWriteSessionMessage.mock.calls[0][2]).toEqual(mockWriteSessionMessage.mock.calls[1][2]);
  });

  it('retries interrupted journaling using the original skip actor, time and input identity', async () => {
    seedQuestion('text');
    mockWriteSessionMessage.mockImplementationOnce(() => {
      throw new Error('journal unavailable');
    });
    await expect(handleInteractiveResponse(skip())).rejects.toThrow('journal unavailable');
    expect(mockWakeContainer).not.toHaveBeenCalled();
    const saved = getQuestion(QUESTION_ID);
    await handleInteractiveResponse(skip('second-user'));
    expect(getQuestion(QUESTION_ID)).toEqual(saved);
    expect(mockWriteSessionMessage.mock.calls[1][2]).toEqual(mockWriteSessionMessage.mock.calls[0][2]);
    expect(mockWakeContainer).toHaveBeenCalledOnce();
  });

  it('does not route unknown or cancelled questions as skips', async () => {
    expect(await handleInteractiveResponse(skip())).toBe(false);
    seedQuestion('text');
    getDb().prepare("UPDATE questions SET status = 'cancelled' WHERE question_id = ?").run(QUESTION_ID);
    expect(await handleInteractiveResponse(skip())).toBe(true);
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('rejects a value outside a choice-only question', async () => {
    seedQuestion('choice');
    expect(await handleInteractiveResponse(response('staging'))).toBe(true);
    expect(getQuestion(QUESTION_ID)?.status).toBe('pending');
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('persists free text and writes a wake-eligible response', async () => {
    seedQuestion('text');
    expect(await handleInteractiveResponse(response('Staging'))).toBe(true);
    expect(getQuestion(QUESTION_ID)).toMatchObject({
      status: 'answered',
      answer_value: 'Staging',
      answer_type: 'text',
    });
    expect(mockWriteSessionMessage).toHaveBeenCalledWith(
      'group-1',
      'session-1',
      expect.objectContaining({
        id: `question-response:${QUESTION_ID}`,
        kind: 'interactive_response',
        idempotent: true,
      }),
    );
    expect(mockStartTypingRefresh).toHaveBeenCalledWith('session-1', 'group-1', 'web', 'user-1', 'thread-1', 'web');
    expect(mockWakeContainer).toHaveBeenCalledOnce();
    expect(mockStartTypingRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      mockWakeContainer.mock.invocationCallOrder[0],
    );
  });

  it('stops typing when the session cannot be woken', async () => {
    seedQuestion('text');
    mockWakeContainer.mockResolvedValue(false);

    await handleInteractiveResponse(response('Staging'));

    expect(mockStartTypingRefresh).toHaveBeenCalledOnce();
    expect(mockStopTypingRefresh).toHaveBeenCalledWith('session-1');
  });

  it('replays the canonical first answer when a duplicate differs', async () => {
    seedQuestion('choice_or_text');
    await handleInteractiveResponse(response('First'));
    await handleInteractiveResponse(response('Second'));

    expect(getQuestion(QUESTION_ID)?.answer_value).toBe('First');
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    const replay = mockWriteSessionMessage.mock.calls[1][2] as { content: string };
    expect(JSON.parse(replay.content).value).toBe('First');
  });
});
