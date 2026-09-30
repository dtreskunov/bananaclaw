import { batch } from '@preact/signals';
import {
  activityLog,
  isTyping,
  refs,
  responseReceived,
  typingEndedAt,
  typingHint,
  typingModel,
  typingStartedAt,
  typingUsage,
} from './state';
import type { ProvisionalTurnMetadata } from './types';

export function clearTypingPresentation(): void {
  batch(() => {
    isTyping.value = false;
    typingHint.value = '';
    typingStartedAt.value = null;
    typingModel.value = '';
    typingUsage.value = null;
    typingEndedAt.value = null;
    activityLog.value = [];
  });
}

export function resetTurnPresentation(): void {
  batch(() => {
    clearTypingPresentation();
    responseReceived.value = false;
    refs.carryActivity = [];
  });
}

export function finishTypingPresentation(): void {
  if (responseReceived.value) return;
  batch(() => {
    if (isTyping.value || typingStartedAt.value !== null || activityLog.value.length || typingUsage.value) {
      typingEndedAt.value ??= Date.now();
    }
    isTyping.value = false;
    if (activityLog.value.length) refs.carryActivity = activityLog.value.slice();
  });
}

export function provisionalTurnMetadata(): ProvisionalTurnMetadata | undefined {
  const model = typingUsage.value?.model || typingModel.value;
  const durationMs =
    typingStartedAt.value === null
      ? undefined
      : Math.max(0, (typingEndedAt.value ?? Date.now()) - typingStartedAt.value);
  const usage = typingUsage.value
    ? { ...typingUsage.value, ...(durationMs !== undefined ? { duration_ms: durationMs } : {}) }
    : undefined;
  return usage || model || durationMs !== undefined
    ? { ...(usage ? { usage } : {}), ...(model ? { model } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }
    : undefined;
}

export function completeTurnPresentation(): void {
  batch(() => {
    responseReceived.value = true;
    clearTypingPresentation();
    refs.carryActivity = [];
  });
}
