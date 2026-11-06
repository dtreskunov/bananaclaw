import type { ReadCursor } from '../../../shared/read-state';
import { dismissToastById, showToast } from './components/Toast';

interface ReadLog extends EventTarget {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  getClientRects(): { length: number };
}
interface ReadTarget {
  groupId: string;
  threadId: string;
  channelType: string;
  messagingGroupId: string | null;
  cursor: ReadCursor;
}
class ReadAckError extends Error {}

// A newer rendered cursor can replace its tracker before the retry succeeds.
const readErrors = new Map<string, number>();

export function attachReadTracking(log: ReadLog, target: ReadTarget): () => void {
  const errorKey = JSON.stringify([target.groupId, target.threadId, target.channelType, target.messagingGroupId]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  let request: AbortController | null = null;
  const eligible = () =>
    document.visibilityState === 'visible' &&
    document.hasFocus() &&
    log.getClientRects().length > 0 &&
    log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const send = async () => {
    if (complete || request || !eligible()) return;
    request = new AbortController();
    const active = request;
    let url = `api/groups/${encodeURIComponent(target.groupId)}/chat/${encodeURIComponent(target.threadId)}/read`;
    if (target.messagingGroupId)
      url += `?channel=${encodeURIComponent(target.channelType)}&mg=${encodeURIComponent(target.messagingGroupId)}`;
    const timeout = setTimeout(() => active.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.cursor),
        signal: active.signal,
      });
      if (request !== active) return;
      if (!response.ok) throw new ReadAckError(`Read acknowledgement failed: HTTP ${response.status}`);
      complete = true;
      const errorId = readErrors.get(errorKey);
      if (errorId !== undefined) {
        dismissToastById(errorId);
        readErrors.delete(errorKey);
      }
    } catch (error) {
      if (request === null) return;
      if (
        !(error instanceof ReadAckError) &&
        !(error instanceof TypeError) &&
        !(error instanceof Error && error.name === 'AbortError')
      )
        throw error;
      console.warn('Read acknowledgement failed', error);
      const previousError = readErrors.get(errorKey);
      if (previousError !== undefined) dismissToastById(previousError);
      readErrors.set(errorKey, showToast('Could not mark this conversation read. Refocus or scroll to retry.', 'err'));
    } finally {
      clearTimeout(timeout);
      if (request === active) request = null;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (eligible() && !complete)
      timer = setTimeout(() => {
        void send();
      }, 150);
  };
  log.addEventListener('scroll', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('focus', schedule);
  schedule();
  return () => {
    clearTimeout(timer);
    const active = request;
    request = null;
    active?.abort();
    log.removeEventListener('scroll', schedule);
    document.removeEventListener('visibilitychange', schedule);
    window.removeEventListener('focus', schedule);
  };
}
