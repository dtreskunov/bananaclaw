/**
 * Response handler + shutdown callback registries.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * or `onShutdown()` at import time don't hit a TDZ error on the const-array
 * declarations. index.ts imports src/modules/index.js for its side effects,
 * which triggers module registrations that would otherwise happen before
 * index.ts's own const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

import { log } from './log.js';
import type { QuestionResponse } from './ui/shared/question-response.js';

export type ResponsePayload = QuestionResponse & {
  questionId: string;
  message?: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
};

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

type ShutdownCallback = () => void | Promise<void>;
const shutdownCallbacks: ShutdownCallback[] = [];

export function onShutdown(cb: ShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

export function getShutdownCallbacks(): readonly ShutdownCallback[] {
  return shutdownCallbacks;
}

/**
 * Dispatch a response (button click, email reply, etc.) through the registered
 * handler chain. Returns true if a handler claimed it. Logs an unclaimed
 * warning when none did. Errors thrown by a handler are logged but don't stop
 * subsequent handlers from trying.
 */
export async function dispatchResponse(payload: ResponsePayload): Promise<boolean> {
  for (const handler of responseHandlers) {
    try {
      if (await handler(payload)) return true;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
  return false;
}
