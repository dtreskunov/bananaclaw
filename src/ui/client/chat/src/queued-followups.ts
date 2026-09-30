import type { ChatMessage } from './types';
import { parseTimelinePosition } from '../../../shared/timeline';

export function isQueuedFollowup(message: ChatMessage): boolean {
  const state = message.inputState;
  const positioned =
    parseTimelinePosition(message.timelinePosition) !== undefined ||
    parseTimelinePosition(state?.timelinePosition) !== undefined;
  return (
    message.direction === 'in' &&
    state?.queuedForNextTurn === true &&
    (state.status === 'queued' || (state.status === 'processing' && !positioned))
  );
}

export function splitQueuedFollowups(messages: ChatMessage[]): { transcript: ChatMessage[]; queued: ChatMessage[] } {
  const transcript: ChatMessage[] = [];
  const queued: ChatMessage[] = [];
  for (const message of messages) (isQueuedFollowup(message) ? queued : transcript).push(message);
  return { transcript, queued };
}

/** Waiting steering shares the bottom input bubbles, not a separate queue UI. */
export function splitPendingInputs(messages: ChatMessage[]): { transcript: ChatMessage[]; queued: ChatMessage[] } {
  const transcript: ChatMessage[] = [];
  const queued: ChatMessage[] = [];
  for (const message of messages) {
    const waiting =
      isQueuedFollowup(message) || (message.direction === 'in' && message.inputState?.status === 'steering');
    (waiting ? queued : transcript).push(message);
  }
  return { transcript, queued };
}

/** Positions/status changes can move an existing row without changing its count. */
export function timelineLayoutKey(messages: ChatMessage[]): string {
  return JSON.stringify(
    messages.map((message) => [
      message.id,
      message.direction,
      message.timelinePosition,
      isQueuedFollowup(message),
      message.inputState?.status === 'steering',
      message.turn?.phase,
      message.turn?.activity,
      message.turn?.metadata,
      message.turnStatus,
      message.statsTurn?.id,
    ]),
  );
}
