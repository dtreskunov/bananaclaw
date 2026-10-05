import type { Conversation, ConversationTimelineRow, ConversationTrace } from '../../shared/conversation.js';
import { timelineSortKey } from '../../shared/timeline.js';

type ContentRow = Extract<ConversationTimelineRow, { kind: 'message' | 'question' }>;

/** Host-owned conversation order with one trace host per logical turn. */
export function conversationTimeline(view: Omit<Conversation, 'timeline'>): ConversationTimelineRow[] {
  const messages = view.messages.filter((message) => message.inputState?.status !== 'cancelled');
  const ordered: Array<{ row: ContentRow; id: string; position: number | undefined; key: number }> = [
    ...messages.map((message) => ({
      row: { kind: 'message' as const, messageId: message.id },
      id: message.id,
      position: message.timelinePosition,
      key: timelineSortKey(message.timestamp, message.timelinePosition),
    })),
    ...view.questions
      .filter((question) => !question.threadId || question.threadId === view.threadId)
      .map((question) => ({
        row: { kind: 'question' as const, questionId: question.questionId },
        id: question.messageId ?? question.questionId,
        position: question.timelinePosition,
        key: timelineSortKey(question.createdAt, question.timelinePosition),
      })),
  ].sort((a, b) => {
    const bucket = Math.floor(a.key / 1000) - Math.floor(b.key / 1000);
    if (bucket) return bucket;
    return (
      Number(a.row.kind === 'question' && a.position === undefined) -
        Number(b.row.kind === 'question' && b.position === undefined) || a.key - b.key
    );
  });
  const rows: ConversationTimelineRow[] = ordered.map(({ row }) => row);
  const inserts = new Map<ConversationTimelineRow | null, ConversationTimelineRow[]>();
  const appendAfter = (anchor: ConversationTimelineRow | null, row: ConversationTimelineRow) => {
    const list = inserts.get(anchor) ?? [];
    list.push(row);
    inserts.set(anchor, list);
  };
  for (const turn of view.turns) {
    const settled = turn.phase === 'settled';
    const trace: ConversationTrace = {
      turnId: turn.id,
      ordinals: turn.activity.map((line) => line.ordinal),
      ownsTurn: true,
    };
    const content = ordered.filter((entry) => {
      if (turn.outputIds.includes(entry.id)) return true;
      if (entry.row.kind === 'question') {
        const { questionId } = entry.row;
        return view.questions.some((question) => question.questionId === questionId && question.turnId === turn.id);
      }
      return (
        turn.inputIds.includes(entry.id) &&
        messages.find((message) => message.id === entry.id)?.inputState?.status !== 'steering'
      );
    });
    const finalReply = settled
      ? content
          .filter((entry) => {
            if (entry.row.kind !== 'message' || !turn.outputIds.includes(entry.id)) return false;
            const message = messages.find((message) => message.id === entry.id);
            return (
              message?.direction === 'out' &&
              !message.systemGenerated &&
              message.deliveryOrigin !== 'send_message' &&
              message.deliveryOrigin !== 'send_file'
            );
          })
          .at(-1)
      : undefined;
    if (finalReply?.row.kind === 'message') {
      finalReply.row.trace = trace;
      finalReply.row.statsTurnId = turn.id;
    } else {
      const anchor = content.at(-1);
      appendAfter(anchor?.row ?? null, {
        kind: 'turn',
        turnId: turn.id,
        afterId: anchor?.id ?? null,
        trace,
        status: true,
      });
    }
  }
  return [...(inserts.get(null) ?? []), ...rows.flatMap((row) => [row, ...(inserts.get(row) ?? [])])];
}
