import { signal } from '@preact/signals';
import type { Conversation } from '../../../shared/conversation';
import { parseStep } from '../../../shared/activity-presentation';
import { activeTurn, canSend, groupId, refs, threadId, turnConnected } from './state';
import { sendStopRequest } from './stop-request';

interface ToolStopRequest {
  busy: boolean;
  error: string;
}
const requests = signal<Record<string, ToolStopRequest>>({});
const pending = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
let runningTools = new Set<string>();
const keyFor = (turnId: string, toolCallId: string) => JSON.stringify([turnId, toolCallId]);

export function toolStopRequest(turnId: string, toolCallId: string): ToolStopRequest | undefined {
  return requests.value[keyFor(turnId, toolCallId)];
}

function clearPending(key: string): void {
  const request = pending.get(key);
  if (request) {
    clearTimeout(request.timer);
    request.controller.abort();
    pending.delete(key);
  }
}

export function resetToolStops(): void {
  for (const key of pending.keys()) clearPending(key);
  requests.value = {};
  runningTools.clear();
}

export function applyToolStopState(view: Conversation): void {
  const current = view.turns.find((turn) => turn.id === view.connection.activeTurnId && turn.phase === 'running');
  runningTools = new Set(
    current?.activity.flatMap((line) => {
      const step = parseStep(line.text);
      return step.kind === 'tool' && step.status === 'running' && step.id ? [keyFor(current.id, step.id)] : [];
    }) ?? [],
  );
  const next: Record<string, ToolStopRequest> = {};
  for (const [key, request] of Object.entries(requests.peek())) {
    if (!runningTools.has(key)) clearPending(key);
    else if (!view.connection.connected && request.busy) {
      clearPending(key);
      next[key] = {
        busy: false,
        error: 'Connection lost before tool cancellation was confirmed. Reconnect to check this tool.',
      };
    } else next[key] = request;
  }
  requests.value = next;
}

export async function stopActiveTool(turnId: string, toolCallId: string): Promise<void> {
  const gid = groupId.value;
  const tid = threadId.value;
  const key = keyFor(turnId, toolCallId);
  if (
    !gid ||
    !tid ||
    !canSend.value ||
    !turnConnected.value ||
    activeTurn.value?.id !== turnId ||
    activeTurn.value.status !== 'running' ||
    activeTurn.value.supportsToolCancellation !== true ||
    !runningTools.has(key) ||
    requests.peek()[key]?.busy
  )
    return;
  const generation = refs.chatGeneration;
  const isCurrent = () =>
    generation === refs.chatGeneration &&
    groupId.value === gid &&
    threadId.value === tid &&
    activeTurn.value?.id === turnId &&
    runningTools.has(key);
  clearPending(key);
  requests.value = { ...requests.peek(), [key]: { busy: true, error: '' } };
  const controller = new AbortController();
  const fail = (message: string): void => {
    clearPending(key);
    if (isCurrent()) requests.value = { ...requests.peek(), [key]: { busy: false, error: message } };
  };
  const timer = setTimeout(() => fail('Tool cancellation was not confirmed. Check its state or try again.'), 30_000);
  pending.set(key, { controller, timer });
  try {
    await sendStopRequest(gid, tid, { turnId, toolCallId }, controller.signal);
    // Query acceptance is not tool settlement. Await authoritative activity.
  } catch (error) {
    if (!isCurrent() || controller.signal.aborted) return;
    console.error('Tool stop request failed', error);
    fail(error instanceof Error ? error.message : 'Tool stop request failed. Try again.');
  }
}
