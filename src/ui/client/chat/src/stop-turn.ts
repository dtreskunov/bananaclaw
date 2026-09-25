import { batch } from '@preact/signals';
import {
  activeTurn,
  canSend,
  channelType,
  groupId,
  messagingGroupId,
  refs,
  stopRequest,
  threadId,
  turnConnected,
} from './state';
import type { ActiveTurn } from './types';

const STOP_TIMEOUT_MS = 30_000;
let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
let requestController: AbortController | null = null;

function clearPendingStop(): void {
  if (confirmationTimer) clearTimeout(confirmationTimer);
  confirmationTimer = null;
  requestController?.abort();
  requestController = null;
}

function awaitConfirmation(turnId: string): void {
  if (confirmationTimer) return;
  confirmationTimer = setTimeout(() => {
    confirmationTimer = null;
    requestController?.abort();
    requestController = null;
    if (activeTurn.value?.id !== turnId) return;
    stopRequest.value = {
      turnId,
      busy: false,
      error: 'Stopping has not been confirmed. The response may still be running. Retry Stop to check again.',
    };
  }, STOP_TIMEOUT_MS);
}

export function applyTurnState(turn: ActiveTurn | null, connected: boolean): void {
  const changed = activeTurn.value?.id !== turn?.id;
  if (changed) clearPendingStop();
  batch(() => {
    if (changed) stopRequest.value = null;
    activeTurn.value = turn;
    turnConnected.value = connected;
    if (!connected && turn && (stopRequest.value?.busy || turn.status === 'stopping')) {
      clearPendingStop();
      stopRequest.value = {
        turnId: turn.id,
        busy: false,
        error: 'Connection lost before Stop was confirmed. Reconnect to check the response.',
      };
    }
  });
  if (connected && turn?.status === 'stopping' && !stopRequest.value?.error) awaitConfirmation(turn.id);
}

export function resetTurnState(): void {
  clearPendingStop();
  batch(() => {
    activeTurn.value = null;
    turnConnected.value = false;
    stopRequest.value = null;
  });
}

export async function stopActiveTurn(turnId: string): Promise<void> {
  const gid = groupId.value;
  const tid = threadId.value;
  if (
    !gid ||
    !tid ||
    !canSend.value ||
    !turnConnected.value ||
    activeTurn.value?.id !== turnId ||
    stopRequest.value?.busy
  )
    return;
  const generation = refs.chatGeneration;
  const isCurrent = () =>
    generation === refs.chatGeneration &&
    groupId.value === gid &&
    threadId.value === tid &&
    activeTurn.value?.id === turnId;
  clearPendingStop();
  stopRequest.value = { turnId, busy: true, error: '' };
  const controller = new AbortController();
  requestController = controller;
  awaitConfirmation(turnId);
  let url = `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/stop`;
  if (channelType.value !== 'web' && messagingGroupId.value) {
    url += `?channel=${encodeURIComponent(channelType.value)}&mg=${encodeURIComponent(messagingGroupId.value)}`;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
      signal: controller.signal,
    });
    if (!isCurrent()) return;
    if (!response.ok) {
      const detail = await response.text();
      let message = `Stop request failed (HTTP ${response.status}).`;
      try {
        const body: unknown = JSON.parse(detail);
        if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') message = body.error;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Non-JSON error pages are not safe or useful UI messages.
      }
      throw new Error(message);
    }
    // HTTP acceptance is not cancellation acknowledgement; wait for turn state.
  } catch (error) {
    if (!isCurrent() || controller.signal.aborted) return;
    clearPendingStop();
    console.error('Stop request failed', error);
    stopRequest.value = {
      turnId,
      busy: false,
      error: error instanceof Error ? error.message : 'Stop request failed. Try again.',
    };
  } finally {
    if (requestController === controller) requestController = null;
  }
}
