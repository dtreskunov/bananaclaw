import { signal } from '@preact/signals';
import { patchJson } from './api';
import { chatMessages, groupId, threadId, channelType, messagingGroupId, activeTurn, turnConnected } from './state';
import type { ActiveTurn, ChatMessage, Thread } from './types';

interface PendingEditorSession {
  draft: PendingEditDraft;
  open: boolean;
  gid: string;
  thread: Thread;
  messageId: string;
}

// Consumption may reposition or unmount a bubble. Keep its editor state keyed
// by conversation/message rather than by its current mounted position.
export const pendingEditorSessions = signal(new Map<string, PendingEditorSession>());
export const composerSendInFlight = signal(false);

export function pendingEditorKey(gid: string | null, thread: Thread | null, messageId?: string): string {
  return JSON.stringify([
    gid,
    thread?.channelType || 'web',
    thread?.messagingGroupId ?? null,
    thread?.threadId,
    messageId,
  ]);
}

export function setPendingEditorSession(key: string, session: PendingEditorSession | null): void {
  const next = new Map(pendingEditorSessions.value);
  if (session) next.set(key, session);
  else next.delete(key);
  pendingEditorSessions.value = next;
}

export function currentPendingEditor(): [string, PendingEditorSession] | undefined {
  return [...pendingEditorSessions.value].find(
    ([, session]) => session.open && isCurrentConversation(session.gid, session.thread),
  );
}

export function isCurrentConversation(gid: string, thread: Thread): boolean {
  return (
    groupId.value === gid &&
    threadId.value === thread.threadId &&
    channelType.value === (thread.channelType || 'web') &&
    messagingGroupId.value === (thread.messagingGroupId ?? null)
  );
}

export function openPendingEditor(gid: string, thread: Thread, message: ChatMessage): void {
  if (composerSendInFlight.value) return;
  const key = pendingEditorKey(gid, thread, message.id);
  const previous = pendingEditorSessions.value.get(key);
  if (!previous && !canEditPendingMessage(message, thread, activeTurn.value, turnConnected.value)) return;
  const next = new Map(pendingEditorSessions.value);
  for (const [otherKey, session] of next) {
    if (isCurrentConversation(session.gid, session.thread)) next.set(otherKey, { ...session, open: false });
  }
  next.set(
    key,
    previous
      ? { ...previous, open: true }
      : {
          gid,
          thread: { ...thread },
          messageId: message.id!,
          open: true,
          draft: new PendingEditDraft(message.text, (body) => savePendingMessage(gid, thread, message.id!, body)),
        },
  );
  pendingEditorSessions.value = next;
}

export function exitPendingEditor(key: string): void {
  const session = pendingEditorSessions.value.get(key);
  if (session) setPendingEditorSession(key, { ...session, open: false });
}

export function canEditPendingMessage(
  message: ChatMessage,
  thread: Thread | null,
  turn: ActiveTurn | null,
  connected: boolean,
): boolean {
  return (
    !!thread &&
    (thread.channelType || 'web') === 'web' &&
    message.direction === 'in' &&
    !!message.id &&
    message.canEditPending === true &&
    (message.inputState?.status === 'queued' || message.inputState?.status === 'steering') &&
    connected &&
    turn?.status === 'running' &&
    turn?.supportsInputEditing === true
  );
}

export function canEditMessageInBranch(message: ChatMessage): boolean {
  return message.direction === 'in' && !!message.id && !!message.text.trim() && !message.inputState;
}

export interface PendingEditBody {
  requestId: string;
  expectedText: string;
  text: string;
}

export interface PendingEditResult {
  ok: boolean;
  status: number;
  data: { ok?: boolean; id?: string; text?: string; error?: string };
}

export async function savePendingMessage(
  gid: string,
  thread: Thread,
  messageId: string,
  body: PendingEditBody,
): Promise<PendingEditResult> {
  const result = await patchJson<PendingEditResult['data']>(pendingMessageUrl(gid, thread, messageId), body);
  if (result.ok && (result.data.ok !== true || result.data.id !== messageId || typeof result.data.text !== 'string')) {
    return { ok: false, status: 502, data: { error: 'invalid_confirmation' } };
  }
  if (result.ok && isCurrentConversation(gid, thread)) {
    chatMessages.value = chatMessages.value.map((message) =>
      message.direction === 'in' && message.id === messageId ? { ...message, text: result.data.text! } : message,
    );
  }
  return result;
}

export function pendingMessageUrl(gid: string, thread: Thread, messageId: string): string {
  let url = `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(thread.threadId)}/messages/${encodeURIComponent(messageId)}`;
  const params = new URLSearchParams();
  if (thread.messagingGroupId) {
    params.set('channel', thread.channelType || 'web');
    params.set('mg', thread.messagingGroupId);
  }
  if (params.size) url += `?${params}`;
  return url;
}

const ERRORS: Record<string, string> = {
  input_not_pending: 'This message is no longer pending. Your draft has been kept.',
  text_changed: 'The saved text changed elsewhere. Your draft has been kept.',
  steering_consumed: 'This steering message has already been consumed. Your draft has been kept.',
  runner_disconnected: 'The runner is disconnected. Your draft has been kept. Retry when connected.',
  editing_unsupported: 'The running agent does not support pending edits. Your draft has been kept.',
  edit_pending: 'Save is still awaiting confirmation. Retry save to check the same request.',
  edit_in_progress:
    'Another edit is still awaiting confirmation. Your draft has been kept. Retry after that edit finishes.',
};

/** A draft and its retry identity outlive incoming transcript/status updates. */
export class PendingEditDraft {
  readonly state;
  private request: PendingEditBody | null = null;

  constructor(
    readonly originalText: string,
    private readonly submit: (body: PendingEditBody) => Promise<PendingEditResult>,
  ) {
    this.state = signal({ text: originalText, busy: false, error: '', unresolved: false, retry: false });
  }

  setText(text: string): void {
    if (this.state.value.busy || this.state.value.unresolved) return;
    if (text !== this.state.value.text) this.request = null;
    this.state.value = { ...this.state.value, text, error: '', retry: !!this.request };
  }

  async save(): Promise<boolean> {
    if (this.state.value.busy) return false;
    const body = (this.request ??= {
      requestId: crypto.randomUUID(),
      expectedText: this.originalText,
      text: this.state.value.text,
    });
    this.state.value = { ...this.state.value, busy: true, error: '' };
    try {
      const result = await this.submit(body);
      if (result.ok && result.data.ok === true && typeof result.data.text === 'string') {
        this.state.value = { ...this.state.value, busy: false, unresolved: false, retry: false };
        return true;
      }
      const code = result.data.error || `HTTP ${result.status}`;
      this.state.value = {
        ...this.state.value,
        busy: false,
        retry: true,
        unresolved:
          code === 'edit_pending' ||
          (result.status >= 500 && !['runner_disconnected', 'editing_unsupported'].includes(code)),
        error: ERRORS[code] || `Could not save (${code}). Your draft has been kept.`,
      };
    } catch {
      this.state.value = {
        ...this.state.value,
        busy: false,
        unresolved: true,
        retry: true,
        error: 'Save could not be confirmed. Your draft has been kept. Retry save to check the same request.',
      };
    }
    return false;
  }
}
