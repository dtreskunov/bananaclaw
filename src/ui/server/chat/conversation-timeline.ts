import type { Conversation, ConversationTimelineRow, ConversationTrace } from '../../shared/conversation.js';
import { timelineSortKey } from '../../shared/timeline.js';

/** Host-owned presentation order. Activity placement always uses recorded order, never step timestamps. */
export function conversationTimeline(view: Omit<Conversation, 'timeline'>): ConversationTimelineRow[] {
  const messages = view.messages.filter((message) => message.inputState?.status !== 'cancelled');
  const ordered: Array<{ row: ConversationTimelineRow; id: string; position: number | undefined; key: number }> = [
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
        key: timelineSortKey(
          question.status === 'answered' && question.answeredAt ? question.answeredAt : question.createdAt,
          question.timelinePosition,
        ),
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
    const inputs = ordered.filter((entry) => turn.inputIds.includes(entry.id));
    const outputs = ordered.filter((entry) => turn.outputIds.includes(entry.id));
    const replies = outputs.filter((entry) => entry.row.kind === 'message');
    const finalReply = settled ? replies.at(-1) : undefined;
    if (finalReply?.row.kind === 'message') finalReply.row.statsTurnId = turn.id;
    const firstInput = inputs[0];
    const boundaries = ordered.filter(
      (entry) =>
        turn.outputIds.includes(entry.id) ||
        (entry !== firstInput &&
          turn.inputIds.includes(entry.id) &&
          messages.find((message) => message.id === entry.id)?.inputState?.status !== 'steering'),
    );
    const buckets = new Map<number, number[]>();
    const attached = new Map<ConversationTimelineRow, number[]>();
    for (const line of turn.activity) {
      const index = boundaries.filter(
        (entry) => entry.position !== undefined && entry.position <= line.timelinePosition,
      ).length;
      const next = boundaries[index];
      const anchor = next && turn.outputIds.includes(next.id) ? next : !next ? finalReply : undefined;
      if (anchor) {
        const list = attached.get(anchor.row) ?? [];
        list.push(line.ordinal);
        attached.set(anchor.row, list);
      } else {
        const list = buckets.get(index) ?? [];
        list.push(line.ordinal);
        buckets.set(index, list);
      }
    }
    const traces: ConversationTrace[] = [];
    for (const [row, ordinals] of attached) {
      const trace = { turnId: turn.id, ordinals, ownsTurn: false };
      if (row.kind !== 'turn') row.trace = trace;
      traces.push(trace);
    }
    if (finalReply && !attached.has(finalReply.row) && finalReply.row.kind === 'message') {
      finalReply.row.trace = { turnId: turn.id, ordinals: [], ownsTurn: true };
    }
    const hasStatus =
      !settled ||
      turn.activity.length > 0 ||
      turn.usage.length > 0 ||
      !!turn.metadata.model ||
      turn.metadata.durationMs !== null ||
      (!!turn.startedAt && !!turn.endedAt) ||
      ['stopped', 'failed', 'warning', 'interrupted', 'silent'].includes(turn.outcome);
    const statusIndex = finalReply || !hasStatus ? null : boundaries.length;
    if (statusIndex !== null && !buckets.has(statusIndex)) buckets.set(statusIndex, []);
    for (const [index, ordinals] of buckets) {
      const anchor = index ? boundaries[index - 1] : (firstInput ?? ordered.at(-1));
      const trace = { turnId: turn.id, ordinals, ownsTurn: false };
      traces.push(trace);
      appendAfter(anchor?.row ?? null, {
        kind: 'turn',
        turnId: turn.id,
        afterId: anchor?.id ?? null,
        trace,
        status: index === statusIndex,
      });
    }
    const owner =
      finalReply && finalReply.row.kind === 'message'
        ? finalReply.row.trace
        : (traces
            .filter((trace) => trace.ordinals.length)
            .sort((a, b) => Math.max(...a.ordinals) - Math.max(...b.ordinals))
            .at(-1) ?? traces.at(-1));
    if (owner) owner.ownsTurn = true;
  }
  return [...(inserts.get(null) ?? []), ...rows.flatMap((row) => [row, ...(inserts.get(row) ?? [])])];
}
