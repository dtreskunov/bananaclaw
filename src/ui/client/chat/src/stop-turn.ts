import { batch } from '@preact/signals';
import { activeTurn, canSend, groupId, refs, stopRequest, threadId, turnConnected } from './state';
import type { ActiveTurn } from './types';
import { resetToolStops } from './stop-tool';
import { sendStopRequest } from './stop-request';

const STOP_REQUEST_TIMEOUT_MS = 30_000;
let requestTimer: ReturnType<typeof setTimeout> | null = null;
let requestController: AbortController | null = null;

function clearPendingStop(): void {
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = null;
  requestController?.abort();
  requestController = null;
}

function boundRequest(turnId: string): void {
  requestTimer = setTimeout(() => {
    requestTimer = null;
    requestController?.abort();
    requestController = null;
    if (activeTurn.value?.id !== turnId) return;
    stopRequest.value = {
      turnId,
      busy: false,
      error: 'Stop request timed out. Reconnect to check the authoritative turn state.',
    };
  }, STOP_REQUEST_TIMEOUT_MS);
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
}

export function resetTurnState(): void {
  resetToolStops();
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
  boundRequest(turnId);
  try {
    await sendStopRequest(gid, tid, { turnId }, controller.signal);
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
    if (requestController === controller) {
      requestController = null;
      if (requestTimer) clearTimeout(requestTimer);
      requestTimer = null;
    }
  }
}
