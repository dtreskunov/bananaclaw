import path from 'path';
import type Database from 'better-sqlite3';
import type { ConversationMessage } from '../../shared/conversation.js';
import type { TaskAttemptDto } from '../../shared/thread.js';
import { isSessionTurnId } from '../../../session-link.js';
import { openInboundDb, openOutboundDb, sessionDir } from '../../../session-manager.js';
import { summarizeTaskPrompt } from '../../../thread-summaries.js';
import { getUser } from '../../../modules/permissions/db/users.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { parsePeerConversationId } from '../../shared/peer-conversation.js';
import { chatSdkHistoryContent } from '../../shared/readable-output.js';
export { chatSdkHistoryContent } from '../../shared/readable-output.js';
import { shortcodeToEmoji } from './emoji.js';
import { WEB_CHANNEL_TYPE } from '../../../channels/web.js';
import { isRepresentedApprovalOutcome } from './approval-transcript.js';
import { extractDisplayQuery, HA_CHANNEL_TYPE } from '../../../channels/homeassistant-text.js';
import fs from 'fs';
import { parseInputState, type InputHandling, type InputState } from '../../shared/input-state.js';
import { parseTimelinePosition, timelineSortKey } from '../../shared/timeline.js';
import { inputStateKey, isCancelledInputContent } from '../../../input-timeline.js';
import {
  conversationRouteFilter,
  isElevated,
  resolveTurnContext,
  viewerHandlesForChannel,
  type TurnContext,
} from './conversation-context.js';
export function parseInputHandling(value: unknown): InputHandling | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input_handling');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => key !== 'mode' && key !== 'turnId') ||
    (v.mode !== 'queue' && v.mode !== 'steer') ||
    (v.turnId !== undefined && !isSessionTurnId(v.turnId)) ||
    (v.mode === 'steer' && !isSessionTurnId(v.turnId))
  )
    throw new Error('invalid_input_handling');
  return { mode: v.mode, ...(typeof v.turnId === 'string' ? { turnId: v.turnId } : {}) };
}

export function publicInboundMessageId(id: string, groupId: string): string {
  const suffix = `:${groupId}`;
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id;
}

/** Only project receipts for inbound rows already authorized by the history query. */
function readVisibleInputStates(
  groupId: string,
  outDb: Database.Database,
  rows: Array<{ id: string; status: string; content: string }>,
  isWeb: boolean,
): { states: Map<string, InputState>; positions: Map<string, number> } {
  const states = new Map<string, InputState>();
  const positions = new Map<string, number>();
  const visible = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (!isWeb || row.status !== 'pending') continue;
    try {
      const handling = parseInputHandling(JSON.parse(row.content).inputHandling);
      states.set(row.id, {
        messageId: publicInboundMessageId(row.id, groupId),
        status: 'queued',
        ...(handling?.turnId ? { turnId: handling.turnId } : {}),
        ...(handling?.mode === 'queue' ? { queuedForNextTurn: true } : {}),
      });
    } catch {
      /* Legacy/non-JSON content has no submission intent. */
    }
  }
  try {
    const acknowledgements = new Map(
      (
        outDb
          .prepare('SELECT message_id, status FROM processing_ack WHERE message_id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify([...visible.keys()])) as Array<{
          message_id: string;
          status: string;
        }>
      ).map((ack) => [ack.message_id, ack.status]),
    );
    const receipts = outDb
      .prepare('SELECT key, value FROM session_state WHERE key IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...visible.keys()].map(inputStateKey))) as Array<{
      key: string;
      value: string;
    }>;
    for (const receipt of receipts) {
      let state: InputState | undefined;
      try {
        state = parseInputState(JSON.parse(receipt.value));
      } catch {
        continue;
      }
      if (!state || receipt.key !== inputStateKey(state.messageId)) continue;
      const row = visible.get(state.messageId);
      if (!row) continue;
      if (state.timelinePosition !== undefined) positions.set(row.id, state.timelinePosition);
      states.set(row.id, { ...state, messageId: publicInboundMessageId(row.id, groupId) });
    }
    for (const [id, state] of states) {
      const status = acknowledgements.get(id) ?? visible.get(id)?.status;
      if (
        state.status !== 'applied' &&
        state.status !== 'cancelled' &&
        (status === 'processing' || status === 'completed' || status === 'failed')
      ) {
        if (status === 'processing' || state.reason) states.set(id, { ...state, status: 'processing' });
        else states.delete(id);
      }
    }
  } catch (err) {
    throw new Error('Unable to read input dispositions', { cause: err });
  }
  return { states, positions };
}

/**
 * Read merged inbound + outbound history for a (user, group, thread) from
 * the session DBs. Returns [] if no session exists yet.
 *
 * `override` lets the caller target a non-web messaging group; without it
 * defaults to the group's shared web messaging group.
 *
 * For elevated users (owner/global admin), the ownership check on the
 * target messaging group is skipped so they can read history of threads
 * they don't participate in. DMs and outputs remain scoped to the selected
 * platform recipient; privileged access never means every DM in a shared session.
 */
type HistoryOptions = { includeCancelled?: boolean; hideApprovalOutcomes?: boolean };

export function readChatHistory(
  userId: string,
  groupId: string,
  threadId: string,
  override?: { channelType: string; messagingGroupId: string },
  options: HistoryOptions = {},
): ConversationMessage[] {
  return readConversationHistory(userId, groupId, threadId, override, options).messages;
}

export function readConversationHistory(
  userId: string,
  groupId: string,
  threadId: string,
  override?: { channelType: string; messagingGroupId: string },
  options: HistoryOptions = {},
): { context: TurnContext; messages: ConversationMessage[] } {
  const context = resolveTurnContext(userId, groupId, threadId, override);
  if (!context) throw new Error('Conversation is not accessible');
  const elevated = isElevated(userId);
  // Synthetic DM IDs resolve to the same route as active-turn controls.
  const isDm = threadId.startsWith('__dm:');
  const sessionId = context.sessionId;
  if (!sessionId) return { context, messages: [] };
  const viewerHandles = isDm && !elevated ? viewerHandlesForChannel(userId, context.channelType) : [];
  if (isDm && !elevated && viewerHandles.length === 0) return { context, messages: [] };

  const messages: ConversationMessage[] = [];
  const peerName = (id: string) => ({ agentGroupId: id, displayName: getAgentGroup(id)?.name?.trim() || id });
  const { sql: route, params: scope } = conversationRouteFilter(context);
  const inDb = openInboundDb(groupId, sessionId);
  try {
    const outDb = openOutboundDb(groupId, sessionId);
    try {
      try {
        const rows = inDb
          .prepare(
            `SELECT id, kind, timestamp, content, status, sender_user_id, channel_type, platform_id FROM messages_in
         WHERE ${route} ORDER BY seq`,
          )
          .all(scope) as Array<{
          id: string;
          kind: string;
          timestamp: number;
          content: string;
          status: string;
          sender_user_id: string | null;
          channel_type: string;
          platform_id: string;
        }>;
        const { states: inputStates, positions: inputPositions } = readVisibleInputStates(
          groupId,
          outDb,
          rows,
          context.channelType === WEB_CHANNEL_TYPE,
        );
        // Router namespaces ids as `<rawId>:<agentGroupId>` when writing
        // into per-agent session DBs (router.ts messageIdForAgent), but the
        // send response from submitWebInbound returns the raw `<rawId>`. If we
        // leak the namespaced form to the client the dedup key (direction:id)
        // mismatches and the user's own message paints twice on visibility
        // resume. Strip the suffix here so history matches the send id.
        for (const r of rows) {
          if (r.channel_type === 'agent' && r.kind !== 'chat' && r.kind !== 'text') continue;
          if (
            options.hideApprovalOutcomes &&
            r.sender_user_id === null &&
            isRepresentedApprovalOutcome(userId, groupId, context, r.content)
          )
            continue;
          const cancelled = inputStates.get(r.id)?.status === 'cancelled' || isCancelledInputContent(r.content);
          if (cancelled) {
            if (options.includeCancelled) {
              const id = publicInboundMessageId(r.id, groupId);
              messages.push({
                direction: 'in',
                id,
                timestamp: r.timestamp,
                text: '',
                inputState: { messageId: id, status: 'cancelled' },
              });
            }
            continue;
          }
          const parsed = parseInboundContent(
            r.content,
            groupId,
            threadId,
            context.channelType === WEB_CHANNEL_TYPE || r.channel_type === 'agent',
            sessionId,
          );
          if (parsed != null) {
            const id = publicInboundMessageId(r.id, groupId);
            // HA replays the full transcript on every turn (see buildTurn);
            // show only the user's actual query in the UI.
            const text = context.channelType === HA_CHANNEL_TYPE ? extractDisplayQuery(parsed.text) : parsed.text;
            const sender = r.sender_user_id ? getUser(r.sender_user_id) : undefined;
            const author =
              r.channel_type === 'agent'
                ? peerName(r.platform_id)
                : r.sender_user_id
                  ? { userId: r.sender_user_id, displayName: sender?.display_name?.trim() || r.sender_user_id }
                  : undefined;
            messages.push({
              direction: 'in',
              id,
              timestamp: r.timestamp,
              text,
              files: parsed.files,
              author,
              canEditPending:
                r.channel_type === WEB_CHANNEL_TYPE &&
                r.sender_user_id === userId &&
                ['queued', 'steering'].includes(inputStates.get(r.id)?.status ?? ''),
              ...(inputStates.has(r.id) ? { inputState: inputStates.get(r.id) } : {}),
              ...(inputPositions.has(r.id) ? { timelinePosition: inputPositions.get(r.id) } : {}),
            });
          }
        }
      } catch (err) {
        throw new Error('Unable to read conversation inputs', { cause: err });
      }

      try {
        const rows = outDb
          .prepare(
            `SELECT message.id, message.timestamp, message.kind, message.content, message.turn_id,
             message.channel_type, message.platform_id FROM messages_out message
         WHERE ${route}
         ORDER BY message.seq`,
          )
          .all(scope) as Array<{
          id: string;
          timestamp: number;
          kind: string;
          content: string;
          turn_id: string | null;
          channel_type: string;
          platform_id: string;
        }>;

        // Reactions are `chat` rows with `operation:'reaction'` targeting a
        // prior message id. Collect them keyed by target so they fold onto the
        // target bubble after the loop instead of rendering as empty bubbles.
        const reactionsByTarget = new Map<string, { emoji: string; ts: number }[]>();
        const editsByTarget = new Map<string, string>();

        for (const r of rows) {
          if (r.kind === 'chat-sdk') {
            const content = chatSdkHistoryContent(r.content);
            if (content) {
              messages.push({
                ...content,
                direction: 'out',
                id: r.id,
                ...(r.turn_id ? { turnId: r.turn_id } : {}),
                timestamp: r.timestamp,
                ...(r.channel_type === 'agent' ? { recipient: peerName(r.platform_id) } : {}),
              });
            }
            continue;
          }
          if (r.kind !== 'chat' && r.kind !== 'text') continue;
          // Fold reaction rows onto their target bubble rather than rendering
          // a standalone (empty-text) message.
          try {
            const c = JSON.parse(r.content) as {
              operation?: string;
              messageId?: string;
              emoji?: string;
              text?: string;
            };
            if (c?.operation === 'edit' && c.messageId && typeof c.text === 'string') {
              editsByTarget.set(publicInboundMessageId(c.messageId, groupId), c.text);
              continue;
            }
            if (c?.operation === 'reaction' && c.messageId && c.emoji) {
              // Inbound ids are de-namespaced for the client (the `:<groupId>`
              // suffix is stripped above); match that so reactions on the
              // user's own messages find their target bubble.
              const target = publicInboundMessageId(c.messageId, groupId);
              const arr = reactionsByTarget.get(target) ?? [];
              arr.push({ emoji: shortcodeToEmoji(c.emoji), ts: r.timestamp });
              reactionsByTarget.set(target, arr);
              continue;
            }
          } catch {
            /* not JSON — treat as a normal text bubble below */
          }
          const parsed = parseOutboundContent(r.content);
          messages.push({
            ...parsed,
            direction: 'out',
            id: r.id,
            timestamp: r.timestamp,
            ...(r.turn_id ? { turnId: r.turn_id } : {}),
            ...(r.channel_type === 'agent' ? { recipient: peerName(r.platform_id) } : {}),
          });
        }

        for (const message of messages) {
          const edit = editsByTarget.get(message.id);
          if (edit !== undefined) message.text = edit;
        }

        // Attach collected reactions to their target messages. Targets may be
        // inbound (user) or outbound (agent) bubbles already pushed above.
        if (reactionsByTarget.size > 0) {
          for (const m of messages) {
            if (!m.id) continue;
            const rx = reactionsByTarget.get(m.id);
            if (rx && rx.length) m.reactions = rx;
          }
        }
      } catch (err) {
        throw new Error('Unable to read conversation outputs', { cause: err });
      }

      // Scheduled-task firings: completed `kind='task'` rows are the record of
      // a schedule waking this session. They carry no chat text (parseInbound
      // skips them), so surface each as a distinct timeline "event" bubble so
      // the user can see why an otherwise-quiet thread keeps looking active.
      try {
        const taskRows = inDb
          .prepare(
            `SELECT id, process_after, content, recurrence, series_id FROM messages_in
         WHERE kind = 'task' AND status = 'completed' AND channel_type = ? AND thread_id IS ?
           AND platform_id IN (${context.platformIds.map(() => '?').join(',')}) ORDER BY seq`,
          )
          .all(context.channelType, context.threadId, ...context.platformIds) as Array<{
          id: string;
          process_after: number;
          content: string;
          recurrence: string | null;
          series_id: string | null;
        }>;
        const attempts = new Map(
          (
            outDb
              .prepare(
                'SELECT task_message_id,status,trigger_source,error FROM task_attempts WHERE task_message_id IN (SELECT value FROM json_each(?))',
              )
              .all(JSON.stringify(taskRows.map((row) => row.id))) as Array<{
              task_message_id: string;
              status: TaskAttemptDto['status'];
              trigger_source: string;
              error: string | null;
            }>
          ).map((row) => [row.task_message_id, row]),
        );
        for (const r of taskRows) {
          const summary = summarizeTaskPrompt(r.content);
          const attempt = attempts.get(r.id);
          const status = attempt?.status ?? 'completed';
          const triggerSource = attempt?.trigger_source === 'manual' ? 'manual' : 'scheduled';
          const subject = triggerSource === 'manual' ? 'Manual task' : 'Scheduled task';
          const verb =
            status === 'timed_out'
              ? 'timed out'
              : status === 'failed'
                ? 'failed'
                : status === 'skipped'
                  ? 'skipped'
                  : 'completed';
          const autoPaused = taskWasAutoPaused(r.content);
          // Place the firing at the time it was actually due to run
          // (`process_after`), not the row's creation `timestamp`. A recurring
          // occurrence is cloned right after the *previous* run, so its
          // `timestamp` can be a full cadence-interval before it fires (e.g. a
          // daily task's row is created ~24h early); a Run-now nudge rewrites
          // `process_after` to now while leaving `timestamp` untouched.
          messages.push({
            direction: 'event',
            id: r.id,
            timestamp: r.process_after,
            text: `${subject} ${verb}${autoPaused ? ' and was auto-paused' : ''}: ${summary}`,
            event: {
              kind: 'task-run',
              ...(r.series_id ? { taskId: r.series_id } : {}),
              summary,
              ...(r.recurrence ? { recurrence: r.recurrence } : {}),
              status,
              triggerSource,
              ...(attempt?.error ? { error: attempt.error } : {}),
              ...(autoPaused ? { autoPaused: true } : {}),
            },
          });
        }
      } catch (err) {
        throw new Error('Unable to read conversation tasks', { cause: err });
      }

      messages.sort(
        (a, b) => timelineSortKey(a.timestamp, a.timelinePosition) - timelineSortKey(b.timestamp, b.timelinePosition),
      );
      return { context, messages };
    } finally {
      outDb.close();
    }
  } finally {
    inDb.close();
  }
}

function taskWasAutoPaused(content: string): boolean {
  try {
    return JSON.parse(content)?.autoPaused === true;
  } catch {
    return false;
  }
}

export function encodedAttachmentUrl(groupId: string, threadId: string, localPath: string): string {
  const encodedPath = localPath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const peer = parsePeerConversationId(threadId);
  const query = peer ? `?${new URLSearchParams({ channel: 'agent', mg: peer.sessionId })}` : '';
  return `api/groups/${encodeURIComponent(groupId)}/chat/${encodeURIComponent(threadId)}/attachments/${encodedPath}${query}`;
}

function parseInboundContent(
  content: string,
  groupId?: string,
  threadId?: string,
  includeAttachmentUrls = false,
  sessionId?: string,
):
  | (Pick<ConversationMessage, 'text' | 'files'> & {
      viaWeb?: boolean;
    })
  | null {
  try {
    const o = JSON.parse(content);
    if (o?.cancelled === true) return null;
    if (typeof o === 'string') return { text: o };
    if (typeof o?.text === 'string' || Array.isArray(o?.attachments) || Array.isArray(o?.files)) {
      const text = typeof o?.text === 'string' ? o.text : '';
      // `attachments` for native inbound (base64 + name/mimeType); `files`
      // for web-relayed sends (filename + size only).
      const filesArr = Array.isArray(o?.attachments) ? o.attachments : Array.isArray(o?.files) ? o.files : undefined;
      const files = filesArr
        ? filesArr
            .map(
              (a: {
                filename?: string;
                name?: string;
                data?: string;
                size?: number;
                localPath?: string;
                mimeType?: string;
                contentType?: string;
              }) => {
                let size =
                  typeof a?.size === 'number'
                    ? a.size
                    : typeof a?.data === 'string'
                      ? Math.floor((a.data.length * 3) / 4)
                      : 0;
                const localPath = typeof a?.localPath === 'string' ? a.localPath : undefined;
                if (size <= 0 && localPath && groupId && sessionId) {
                  try {
                    const root = fs.realpathSync(sessionDir(groupId, sessionId));
                    const absolutePath = fs.realpathSync(path.join(root, localPath));
                    const relativePath = path.relative(root, absolutePath);
                    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
                      const stat = fs.statSync(absolutePath);
                      if (stat.isFile()) size = stat.size;
                    }
                  } catch {
                    // Attachment may have expired or been removed.
                  }
                }
                const contentType =
                  typeof a?.mimeType === 'string'
                    ? a.mimeType
                    : typeof a?.contentType === 'string'
                      ? a.contentType
                      : undefined;
                return {
                  filename: String(a?.name ?? a?.filename ?? ''),
                  size,
                  ...(includeAttachmentUrls && localPath && groupId && threadId
                    ? { url: encodedAttachmentUrl(groupId, threadId, localPath) }
                    : {}),
                  ...(contentType ? { contentType } : {}),
                };
              },
            )
            .filter((f: { filename: string }) => f.filename)
        : undefined;
      return {
        text,
        files: files && files.length > 0 ? files : undefined,
        viaWeb: o?._via === 'web' || undefined,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function parseOutboundContent(
  content: string,
): Pick<
  ConversationMessage,
  'text' | 'files' | 'deliveryOrigin' | 'systemGenerated' | 'suggestedAction' | 'timelinePosition'
> {
  const o = JSON.parse(content);
  const timelinePosition = parseTimelinePosition(o?.timelinePosition);
  const text = typeof o?.text === 'string' ? o.text : '';
  const deliveryOrigin =
    o?.delivery_origin === 'send_message' || o?.delivery_origin === 'send_file' || o?.delivery_origin === 'response'
      ? o.delivery_origin
      : undefined;
  const systemGenerated = o?.system_generated === true;
  const suggestedAction =
    o?.suggested_action === 'continue' || o?.suggested_action === 'retry' || o?.suggested_action === 'report'
      ? o.suggested_action
      : undefined;
  // file_paths is a parallel array to files written by send_file with
  // workspace-relative source paths (or null when the source isn't in
  // /workspace/agent). Lets the chat UI link the chip to the FILES
  // panel without changing the established `files: string[]` contract
  // that delivery / readOutboxFiles depend on.
  const filePaths: (string | null | undefined)[] = Array.isArray(o?.file_paths) ? o.file_paths : [];
  const files = Array.isArray(o?.files)
    ? o.files
        .map((f: { filename?: string; name?: string; size?: number } | string, i: number) => {
          if (typeof f === 'string') {
            const p = filePaths[i];
            return { filename: f, size: 0, path: typeof p === 'string' ? p : undefined };
          }
          const p = filePaths[i];
          return {
            filename: String(f?.filename ?? f?.name ?? ''),
            size: typeof f?.size === 'number' ? f.size : 0,
            path: typeof p === 'string' ? p : undefined,
          };
        })
        .filter((f: { filename: string }) => f.filename)
    : undefined;
  return {
    text,
    files,
    ...(deliveryOrigin ? { deliveryOrigin } : {}),
    ...(systemGenerated ? { systemGenerated: true } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(timelinePosition !== undefined ? { timelinePosition } : {}),
  };
}
