import type { Conversation } from '../../../shared/conversation';
import type { ChatMessage, InputState, PendingWebSend, TranscriptRow, WebSendState } from './types';

export function withWebSendState(submission: PendingWebSend, state: WebSendState): PendingWebSend {
  const { status: _status, error: _error, ...packet } = submission;
  return { ...packet, ...state };
}

function hasFollowupDisposition(input?: InputState): boolean {
  return input?.queuedForNextTurn === true || input?.status === 'steering' || input?.status === 'applied';
}

function submissionContext(view: Conversation | null) {
  return {
    inputs: new Map(
      view?.messages.filter((message) => message.direction === 'in').map((message) => [message.id, message]),
    ),
    ownedIds: new Set(view?.turns.flatMap((turn) => turn.inputIds)),
    active: !!view?.connection.activeTurnId,
  };
}

function classifySubmission(send: PendingWebSend, context: ReturnType<typeof submissionContext>) {
  const input = context.inputs.get(send.messageId);
  const awaitingTurn =
    send.startsResponse &&
    !context.active &&
    !context.ownedIds.has(send.messageId) &&
    !hasFollowupDisposition(input?.inputState) &&
    input?.inputState?.status !== 'cancelled';
  return {
    echoed: !!input,
    retain: !input || awaitingTurn,
    starting: awaitingTurn && send.status !== 'failed',
  };
}

export function reconcileWebSubmissions(
  submissions: readonly PendingWebSend[],
  view: Conversation,
  groupId: string | null,
): PendingWebSend[] {
  const context = submissionContext(view);
  return submissions.flatMap((submission) => {
    if (submission.groupId !== groupId || submission.threadId !== view.threadId) return [submission];
    const disposition = classifySubmission(submission, context);
    if (!disposition.retain) return [];
    return [disposition.echoed ? withWebSendState(submission, { status: 'accepted' }) : submission];
  });
}

/** Local rows never enter the authoritative conversation, its clocks, or its journals. */
export function submissionPresentation(
  transcript: readonly TranscriptRow[],
  submissions: readonly PendingWebSend[],
  view: Conversation | null,
  groupId: string | null,
  threadId: string | null,
): TranscriptRow[] {
  const local = submissions.filter((send) => send.groupId === groupId && send.threadId === threadId);
  const context = submissionContext(view);
  const starts = local.filter((send) => classifySubmission(send, context).starting);
  const startingIds = new Set(starts.map((send) => send.messageId));
  const seen = new Set(context.inputs.keys());
  const rows = transcript.map((row): TranscriptRow => {
    if (row.kind !== 'message') return row;
    if (row.message.id) seen.add(row.message.id);
    const id = row.message.id;
    const owned = !!id && context.ownedIds.has(id);
    const startupReceipt =
      owned && row.message.inputState?.status === 'queued' && !row.message.inputState.queuedForNextTurn;
    if (!row.message.id || (!startingIds.has(row.message.id) && !startupReceipt)) return row;
    return { ...row, message: { ...row.message, hideInitialQueuedCaption: true } };
  });
  for (const submission of local) {
    if (seen.has(submission.messageId)) continue;
    const message: ChatMessage = {
      id: submission.messageId,
      direction: 'in',
      text: submission.text,
      ts: submission.timestamp,
      files: submission.files.map((file) => ({
        filename: file.name,
        size: file.size,
        contentType: file.file?.type,
      })),
      submission,
      hideInitialQueuedCaption: startingIds.has(submission.messageId),
    };
    rows.push({ kind: 'message', message });
  }
  if (starts.length) rows.push({ kind: 'starting', submission: starts[0] });
  return rows;
}
