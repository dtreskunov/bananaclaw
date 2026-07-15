import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWriteSessionMessage = vi.fn();
const mockWakeContainer = vi.fn().mockResolvedValue(undefined);

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
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
  mockWakeContainer.mockClear();
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

describe('handleInteractiveResponse', () => {
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
    expect(mockWakeContainer).toHaveBeenCalledOnce();
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
