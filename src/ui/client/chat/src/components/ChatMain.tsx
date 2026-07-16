// Chat main: message log, status, context chip, pending tray, readonly
// banner, composer.
import './ChatMain.css';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import {
  chatMessages, chatStatus, chatLoading, isTyping, typingHint, typingStartedAt, typingModel, activityLog, threadId, channelType, canSend, pending,
  threads, groupId, channelMeta, pinnedContext, pendingApprovals, respondingApprovalIds,
  pendingQuestions, respondingQuestionIds,
  highlightMessageId, searchQuery, voiceMode, isMobile, scrollToBottomTick,
  UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE, UPLOAD_MAX_FILES,
} from '../state';
import { renderMarkdown, rewriteFileLinks, highlightTextNodes, fmtBytesShort } from '../utils';
import {
  sendChat, addPendingFiles, removePending, clearPending,
  navFile, removePinnedPath, clearPinnedContext, respondApproval, respondQuestion,
  openChat, openTaskPanel,
} from '../actions';
import { isRecording, recordingDuration, startRecording, stopRecording, cancelRecording, hasGetUserMedia, hasSpeechRecognition, transcribeViaServer } from '../recorder';
import { mergeQuestionTimeline } from '../question-timeline';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { QuickCapture } from './QuickCapture';
import { RelativeTime } from './RelativeTime';
import type { ActivityLine, ChatMessage, DisplayCard, PendingQuestionDto, TurnUsage } from '../types';

const activeRecordingTarget = signal<string | null>(null);

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** Format an activity line's epoch-ms timestamp as a short wall-clock time.
 *  Empty / non-numeric (legacy lines) render no timestamp. */
function fmtActivityTs(ts: string): string {
  if (!ts) return '';
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  return new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface TraceStep {
  kind?: 'tool' | 'internal' | 'file' | 'patch' | 'retry' | 'compaction' | 'subtask' | 'notification';
  id?: string;
  tool?: string;
  status?: 'pending' | 'running' | 'completed' | 'error';
  detail?: string;
  title?: string;
  error?: string;
  durationMs?: number;
  text?: string;
  path?: string;
  name?: string;
  mime?: string;
  files?: string[];
  attempt?: number;
  auto?: boolean;
  agent?: string;
  description?: string;
}

function parseStep(text: string): TraceStep {
  try {
    const o = JSON.parse(text) as TraceStep;
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

/** Turn a raw tool name into what we show the user: `mcp__server__name`
 *  collapses to `server.name`; ordinary names lower-case. */
function cleanToolName(tool: string): string {
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice(5);
    const [server, ...name] = rest.split('__');
    return `${server}.${name.join('.') || rest}`;
  }
  return tool.toLowerCase();
}

/** File-operation tools carry the target path but no verb (and OpenCode's
 *  title is just the path), so map the tool name to a verb to make read vs.
 *  write vs. edit explicit. Case-insensitive to cover Claude (`Read`/`Write`/
 *  `Edit`) and OpenCode (`read`/`write`/`edit`). */
const FILE_OP_VERBS: Record<string, { present: string; past: string }> = {
  read: { present: 'Reading', past: 'Read' },
  write: { present: 'Writing', past: 'Wrote' },
  edit: { present: 'Editing', past: 'Edited' },
};

const COMMAND_TOOLS = new Set(['bash', 'shell', 'run', 'run_in_terminal']);

interface StepHeadline {
  action: string;
  subject?: string;
  codeSubject?: boolean;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stepHeadline(s: TraceStep): StepHeadline {
  switch (s.kind) {
    case 'tool': {
      const tool = (s.tool || '').toLowerCase();
      const finished = s.status === 'completed' || s.status === 'error';
      const fileOp = FILE_OP_VERBS[tool];
      if (fileOp) {
        const target = s.detail || s.title || '';
        return {
          action: finished ? fileOp.past : fileOp.present,
          ...(target ? { subject: singleLine(target), codeSubject: true } : {}),
        };
      }
      if (COMMAND_TOOLS.has(tool) && s.detail) {
        return { action: finished ? 'Ran' : 'Running', subject: singleLine(s.detail), codeSubject: true };
      }
      if (s.title) {
        return { action: s.title };
      }
      return {
        action: finished ? 'Used' : 'Using',
        subject: cleanToolName(s.tool || 'tool'),
        codeSubject: true,
      };
    }
    case 'internal': return { action: 'Internal activity' };
    case 'file': return { action: 'Opened', subject: s.name || s.path || 'file', codeSubject: true };
    case 'patch': {
      const files = s.files || [];
      return files.length === 1
        ? { action: 'Updated', subject: files[0], codeSubject: true }
        : { action: 'Updated', subject: `${files.length} files` };
    }
    case 'retry': return { action: 'Retrying', subject: `attempt ${s.attempt ?? 0}` };
    case 'compaction': return { action: s.auto ? 'Compacted context automatically' : 'Compacted context' };
    case 'subtask': return s.agent
      ? { action: 'Started subtask with', subject: s.agent, codeSubject: true }
      : { action: s.description || 'Started subtask' };
    case 'notification': return { action: s.text || 'Notification' };
    default: return { action: '' };
  }
}

/** One-line collapsed summary for a step (whitespace-collapsed so a
 *  multi-line command still fits one truncated row). */
function stepSummary(s: TraceStep): string {
  const headline = stepHeadline(s);
  return [headline.action, headline.subject].filter(Boolean).join(' ');
}

function StepHeadlineContent({ headline }: { headline: StepHeadline }) {
  return (
    <>
      {headline.action}
      {headline.subject
        ? <>{' '}{headline.codeSubject ? <code class="trace-subject">{headline.subject}</code> : headline.subject}</>
        : null}
    </>
  );
}

function stepBody(s: TraceStep): string | null {
  if (s.kind === 'tool') return [s.detail, s.error].filter(Boolean).join('\n\n') || null;
  if (s.kind === 'internal') return s.text || null;
  if (s.kind === 'patch') return s.files?.join('\n') || null;
  if (s.kind === 'retry') return s.error || null;
  if (s.kind === 'file') return s.path || null;
  return null;
}

function stepMeta(s: TraceStep, elapsedMs: number | null): string | null {
  if (s.kind !== 'tool') return null;
  const status = s.status === 'error'
    ? 'Failed'
    : s.status === 'completed'
      ? 'Completed'
      : s.status === 'running'
        ? 'Running'
        : 'Pending';
  const duration = s.status === 'running' ? elapsedMs : s.durationMs;
  const formattedDuration = typeof duration !== 'number'
    ? ''
    : s.status === 'running'
      ? `${Math.floor(duration / 1000)}s`
      : formatDuration(duration);
  return `${status}${formattedDuration ? ` · ${formattedDuration}` : ''}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatRecordingDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** One accordion row of an activity trace. Collapsed shows a single
 *  truncated summary line (timestamp + summary). Expanded shows a rich
 *  prefix inline next to the timestamp; a tool step additionally renders its
 *  raw primary argument as a multi-line code block below, newlines intact. */
function ActivityTraceRow({ line, open, live, now, onToggle }: { line: ActivityLine; open: boolean; live: boolean; now: number | null; onToggle: () => void }) {
  const parsedStep = parseStep(line.text);
  const step = !live && parsedStep.kind === 'tool' && (parsedStep.status === 'pending' || parsedStep.status === 'running')
    ? { ...parsedStep, status: 'completed' as const }
    : parsedStep;
  const headline = stepHeadline(step);
  const running = live && step.kind === 'tool' && step.status === 'running';
  const startedAt = Number(line.ts);
  const hasStartedAt = Number.isFinite(startedAt);
  const code = open ? stepBody(step) : null;
  const elapsedMs = running && hasStartedAt && now !== null ? Math.max(0, now - startedAt) : null;
  const meta = open ? stepMeta(step, elapsedMs) : null;
  return (
    <li class={`trace-row${open ? ' open' : ''}`}>
      <button
        type="button"
        class="trace-row-toggle"
        aria-expanded={open}
        title={open ? 'Collapse step' : stepSummary(step)}
        onClick={onToggle}
      >
        <span class={`chevron${open ? ' open' : ''}`}>{'\u203A'}</span>
        {line.ts ? <span class="ts">{fmtActivityTs(line.ts)}</span> : null}
        <span class="trace-text"><StepHeadlineContent headline={headline} /></span>
      </button>
      {meta ? <div class="trace-meta">{meta}</div> : null}
      {open && code != null
        ? <pre class="trace-code"><code>{code}</code></pre>
        : null}
    </li>
  );
}

/** A timestamped step list where each entry is an accordion row. Nothing is
 *  expanded by default; expanding a row shows its prefix inline next to the
 *  timestamp and, for a command step, the code body as a multi-line block.
 *  Single-open accordion. Shared by the persisted trace and the live typing
 *  bubble. */
function ActivityTraceList({ lines, live = false, now = null }: { lines: ActivityLine[]; live?: boolean; now?: number | null }) {
  const [sel, setSel] = useState<string | null>(null);
  const toggle = (id: string) => setSel((cur) => (cur === id ? null : id));
  return (
    <ul class="activity-trace">
      {lines.map((line, i) => {
        const id = parseStep(line.text).id || `activity-${i}`;
        return <ActivityTraceRow key={id} line={line} open={id === sel} live={live} now={now} onToggle={() => toggle(id)} />;
      })}
    </ul>
  );
}

function latestActivityHeadline(lines: ActivityLine[]): StepHeadline | null {
  if (!lines.length) return null;
  return stepHeadline(parseStep(lines[lines.length - 1].text));
}

/** A collapsible activity trace (chevron + timestamped step list). Used for
 *  the persisted trace on historical outbound messages; the live typing
 *  bubble renders its own copy coupled to autoscroll. */
function ActivityTrace({ lines }: { lines: ActivityLine[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!lines.length) return null;
  return (
    <div class={`msg-activity${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        class="trace-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide activity' : 'Show activity'}
        title={expanded ? 'Hide activity' : 'Show activity'}
        onClick={() => setExpanded((v) => !v)}
      >
        <span class={`chevron${expanded ? ' open' : ''}`}>{'\u203A'}</span>
        <span class="trace-count">{lines.length} step{lines.length === 1 ? '' : 's'}</span>
      </button>
      {expanded ? <ActivityTraceList lines={lines} /> : null}
    </div>
  );
}

function fmtCost(usd: number): string {
  if (usd >= 1) return '$' + usd.toFixed(2);
  if (usd >= 0.01) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(4);
}

function fmtDur(ms: number): string {
  if (ms >= 60_000) return Math.round(ms / 60_000) + 'm';
  return Math.round(ms / 1_000) + 's';
}

function shortModel(model: string): string {
  // Show the last `/`-separated component (e.g. "anthropic/claude-sonnet-4"
  // -> "claude-sonnet-4", "openai/gpt-4o" -> "gpt-4o"). Plain ids pass through.
  return model.split('/').pop() || model;
}

function mediaKind(filename: string, contentType?: string | null): 'audio' | 'video' | null {
  if (contentType?.startsWith('audio/')) return 'audio';
  if (contentType?.startsWith('video/')) return 'video';
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (['webm', 'm4a', 'mp3', 'ogg', 'wav', 'aac', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  return null;
}

function UsageMeta({ u }: { u: TurnUsage }) {
  const [expanded, setExpanded] = useState(false);
  const cost = fmtCost(u.cost_usd);
  const model = u.model ? shortModel(u.model) : '';
  const dur = u.duration_ms ? fmtDur(u.duration_ms) : '';
  const short = [cost, dur, model].filter(Boolean).join(' \u00b7 ');
  const tokens = `${fmtTok(u.input_tokens)}\u2192${fmtTok(u.output_tokens)}`;
  const cache = [
    u.cache_read_tokens > 0 ? `cache read ${fmtTok(u.cache_read_tokens)}` : '',
    u.cache_write_tokens > 0 ? `cache write ${fmtTok(u.cache_write_tokens)}` : '',
    u.reasoning_tokens ? `reasoning ${fmtTok(u.reasoning_tokens)}` : '',
  ].filter(Boolean).join(' \u00b7 ');
  const detail = [tokens, cache].filter(Boolean).join(' \u00b7 ');
  return (
    <span class="usage" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} title="Click for details">
      {short}{expanded && detail ? ` \u00b7 ${detail}` : ''}
    </span>
  );
}

function Message({ m }: { m: ChatMessage }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mdRef = useRef<HTMLDivElement | null>(null);
  if (m.direction === 'event') {
    const ev = m.event;
    const recur = ev?.recurrence ? ` \u00b7 ${ev.recurrence}` : '';
    const openTask = (): void => {
      if (groupId.value && threadId.value) openTaskPanel(groupId.value, threadId.value, ev?.taskId);
    };
    return (
      <button
        type="button"
        class="msg event event-clickable"
        data-msg-id={m.id}
        title={ev?.recurrence ? `Recurring: ${ev.recurrence} \u2014 open in task panel` : 'Open in task panel'}
        onClick={openTask}
      >
        <span class="event-icon" aria-hidden="true">{'\u23F0'}</span>
        <span class="event-text">{ev?.summary || m.text}</span>
        <span class="event-meta"><RelativeTime ts={m.ts} />{recur}</span>
      </button>
    );
  }
  if (m.direction === 'question' && m.question) {
    return (
      <QuestionCardItem
        question={m.question}
        busy={respondingQuestionIds.value.has(m.question.questionId)}
      />
    );
  }
  if (m.card) return <DisplayCardMessage message={m} card={m.card} />;
  const md = renderMarkdown(m.text);
  const q = searchQuery.value;
  useEffect(() => {
    // Reset markdown DOM before re-processing (handles search query changes).
    if (md != null && mdRef.current) mdRef.current.innerHTML = md;
    if (md != null && mdRef.current && groupId.value) {
      rewriteFileLinks(mdRef.current, groupId.value, (entry) => navFile(entry).catch(console.error));
      // Handle [[msg:id|threadId]] reference link clicks.
      for (const a of mdRef.current.querySelectorAll<HTMLAnchorElement>('a.msg-ref')) {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const tid = a.dataset.threadId;
          const msgId = a.dataset.msgId;
          if (tid && groupId.value) {
            highlightMessageId.value = msgId || null;
            if (threadId.value === tid) {
              setTimeout(() => { highlightMessageId.value = msgId || null; }, 50);
            } else {
              openChat(groupId.value, tid, null).catch(console.error);
            }
          }
        });
      }
    }
    // Highlight search query terms in the rendered message.
    if (q && ref.current) highlightTextNodes(ref.current, q);
  }, [m.text, md != null, q]);
  const cls = 'msg ' + m.direction + (md != null ? ' markdown' : '');
  const singleFile = m.files?.length === 1 ? m.files[0] : null;
  const singleMediaKind = singleFile?.url && !m.text.trim() ? mediaKind(singleFile.filename, singleFile.contentType) : null;
  return (
    <div class={cls} data-msg-id={m.id} ref={ref}>
      {m.direction === 'internal' ? <div class="internal-label">internal</div> : null}
      {md != null
        ? <div ref={mdRef} dangerouslySetInnerHTML={{ __html: md }} />
        : (m.text || '')}
      {singleFile && singleMediaKind
        ? (
          <div class="inline-media">
            {singleMediaKind === 'audio'
              ? <audio controls preload="metadata" src={singleFile.url!} title={singleFile.filename} />
              : <video controls preload="metadata" src={singleFile.url!} title={singleFile.filename} />}
            <div class="inline-media-name">{singleFile.filename}</div>
          </div>
        )
        : null}
      {m.files && m.files.length && !singleMediaKind
        ? (
          <div class="files">
            {m.files.map((f) => f.path
              ? (
                <button
                  type="button"
                  class="file-chip"
                  title={'/' + f.path}
                  onClick={() => navFile({ path: f.path!, name: f.filename, size: f.size }).catch(console.error)}
                  key={f.path}
                >{'\uD83D\uDCCE '}{f.filename}</button>
              )
              : <span class="file-chip inert" title="Source not in workspace" key={f.filename}>{'\uD83D\uDCCE '}{f.filename}</span>)}
          </div>
        )
        : null}
      {m.direction === 'out' && m.activity && m.activity.length
        ? <ActivityTrace lines={m.activity} />
        : null}
      {m.reactions && m.reactions.length
        ? (
          <div class="reactions">
            {m.reactions.map((r, i) => (
              <span class="reaction-chip" key={i} title={`Reacted ${r.emoji}`}>{r.emoji}</span>
            ))}
          </div>
        )
        : null}
      {m.ts ? <div class="meta">
        <RelativeTime ts={m.ts} />
        {m.usage && m.direction === 'out' ? <UsageMeta u={m.usage} /> : null}
      </div> : null}
    </div>
  );
}

function DisplayCardMessage({ message, card }: { message: ChatMessage; card: DisplayCard }) {
  return (
    <div class="msg out display-card" data-msg-id={message.id}>
      {card.title ? <div class="display-card-title">{card.title}</div> : null}
      {card.description ? <div class="display-card-description">{card.description}</div> : null}
      {card.children.length > 0 ? (
        <div class="display-card-blocks">
          {card.children.map((child, index) => <div class="display-card-block" key={index}>{child}</div>)}
        </div>
      ) : null}
      {card.actions.length > 0 ? (
        <div class="display-card-actions">
          {card.actions.map((action) => (
            <a
              class={`display-card-action display-card-action-${action.style || 'default'}`}
              href={action.url}
              target="_blank"
              rel="noopener noreferrer"
              key={`${action.label}:${action.url}`}
            >{action.label}<span aria-hidden="true"> {'\u2197'}</span></a>
          ))}
        </div>
      ) : null}
      {message.activity?.length ? <ActivityTrace lines={message.activity} /> : null}
      {message.reactions?.length ? (
        <div class="reactions">
          {message.reactions.map((reaction, index) => (
            <span class="reaction-chip" key={index} title={`Reacted ${reaction.emoji}`}>{reaction.emoji}</span>
          ))}
        </div>
      ) : null}
      {message.ts ? <div class="meta"><RelativeTime ts={message.ts} /></div> : null}
    </div>
  );
}

interface ThoughtsGroup { kind: 'thoughts'; thoughts: ChatMessage[]; answer: ChatMessage }
interface SingleGroup { kind: 'single'; m: ChatMessage }
interface EventsGroup { kind: 'events'; events: ChatMessage[] }
type MsgGroup = ThoughtsGroup | SingleGroup | EventsGroup;

function groupMessages(list: ChatMessage[]): MsgGroup[] {
  const out: MsgGroup[] = [];
  let pendingMsgs: ChatMessage[] = [];
  let events: ChatMessage[] = [];
  // A run of consecutive task-run events (e.g. a daily job) collapses into a
  // single expandable pill so it doesn't flood the transcript. A lone event
  // renders inline as an ordinary single.
  const flushEvents = () => {
    if (events.length === 0) return;
    if (events.length === 1) out.push({ kind: 'single', m: events[0]! });
    else out.push({ kind: 'events', events });
    events = [];
  };
  for (const m of list) {
    if (m.direction === 'event') {
      // Keep timeline order: flush any buffered internal thoughts first.
      for (const t of pendingMsgs) out.push({ kind: 'single', m: t });
      pendingMsgs = [];
      events.push(m);
      continue;
    }
    flushEvents();
    if (m.direction === 'internal') {
      pendingMsgs.push(m);
    } else if (m.direction === 'out' && pendingMsgs.length > 0) {
      out.push({ kind: 'thoughts', thoughts: pendingMsgs, answer: m });
      pendingMsgs = [];
    } else {
      out.push({ kind: 'single', m });
    }
  }
  flushEvents();
  for (const t of pendingMsgs) out.push({ kind: 'single', m: t });
  return out;
}

/** Collapsed run of consecutive task-run events. Shows a single summary pill
 *  ("Scheduled task ran N×") that expands to reveal each individual run. */
function EventsGroup({ events }: { events: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const n = events.length;
  const last = events[n - 1]!;
  // A collapsed run can span more than one distinct scheduled task (the
  // grouping is positional). Reflect that so the pill doesn't imply a single
  // task fired N times when it was actually several different tasks.
  const taskCount = new Set(
    events.map((e) => e.event?.taskId || e.event?.summary || '').filter(Boolean),
  ).size;
  const multi = taskCount > 1;
  if (open) {
    return (
      <div class="events-group open">
        <button type="button" class="events-collapse" onClick={() => setOpen(false)} title="Collapse runs">
          <span class="event-icon" aria-hidden="true">{'\u23F0'}</span>
          <span>{n}{' scheduled runs'}{multi ? ` \u00b7 ${taskCount} tasks` : ''}{' \u00b7 hide'}</span>
        </button>
        {events.map((e) => <Message key={e.id} m={e} />)}
      </div>
    );
  }
  return (
    <button type="button" class="msg event events-summary" onClick={() => setOpen(true)} title="Show individual runs">
      <span class="event-icon" aria-hidden="true">{'\u23F0'}</span>
      <span class="event-text">
        {multi
          ? `${taskCount} scheduled tasks ran ${n}\u00d7`
          : `Scheduled task ran ${n}\u00d7`}
      </span>
      <span class="event-meta">last&nbsp;<RelativeTime ts={last.ts} /></span>
    </button>
  );
}

function ThoughtGroup({ thoughts, answer }: { thoughts: ChatMessage[]; answer: ChatMessage }) {
  const [showThoughts, setShowThoughts] = useState(false);
  const n = thoughts.length;
  const label = showThoughts ? 'answer' : (n > 1 ? `thoughts (${n})` : 'thoughts');
  const title = showThoughts ? 'Show final answer' : 'Show agent thoughts leading to this answer';
  return (
    <div class={'thought-group' + (showThoughts ? ' showing-thoughts' : ' showing-answer')}>
      {showThoughts
        ? thoughts.map((t, i) => <Message key={'t' + i} m={t} />)
        : <Message m={answer} />}
      <button
        type="button"
        class="thoughts-toggle"
        title={title}
        onClick={() => setShowThoughts((v) => !v)}
      >{label}</button>
    </div>
  );
}

function ApprovalsBanner() {
  const list = pendingApprovals.value;
  if (list.length === 0) return null;
  const busy = respondingApprovalIds.value;
  return (
    <div class="approvals-banner">
      <div class="approvals-header">
        Pending approvals <span class="approvals-count">({list.length})</span>
      </div>
      {list.map((a) => (
        <div class="approval-row" key={a.approvalId}>
          <div class="approval-text">
            <div class="approval-title">{a.title || a.action}</div>
            {a.details ? <div class="approval-details">{a.details}</div> : null}
            <div class="approval-meta">
              <span class="approval-group">{a.agentGroupName || 'Global'}</span>
              <span class="dot">{'\u00b7'}</span>
              <RelativeTime ts={a.createdAt} />
            </div>
          </div>
          <div class="approval-actions">
            {a.options.length === 0
              ? <span class="approval-disabled">no options</span>
              : a.options.map((o) => (
                <button
                  type="button"
                  class={'approval-btn approval-' + (o.value === 'approve' ? 'approve' : o.value === 'reject' ? 'reject' : 'neutral')}
                  disabled={busy.has(a.approvalId)}
                  onClick={() => respondApproval(a.approvalId, o.value).catch(console.error)}
                  key={o.value}
                >{o.label}</button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Future-aware short label; fmtRelative clamps future times to "just now". */
function fmtNextShort(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 30_000) return 'now';
  const min = Math.round(diff / 60000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `in ${day}d`;
  return new Date(t).toLocaleDateString();
}

/** Persistent pills shown while the open thread has live scheduled task(s):
 *  one pill per distinct task, rendered as the last entries in the log so
 *  tasks are discoverable without expanding the threads rail. Mirrors the
 *  task-run bubble style; clicking a pill opens that task in the panel. */
function TaskIndicator() {
  const gid = groupId.value;
  const tid = threadId.value;
  if (!gid || !tid) return null;
  const t = threads.value.find((x) => x.threadId === tid);
  const tasks = t?.liveTasks;
  if (!tasks || tasks.length === 0) return null;
  return (
    <>
      {tasks.map((lt) => {
        const trailer = lt.paused ? 'paused' : lt.nextRunAt ? `next ${fmtNextShort(lt.nextRunAt)}` : '';
        return (
          <button
            key={lt.seriesId}
            type="button"
            class={'msg event events-summary task-indicator' + (lt.paused ? ' paused' : '')}
            title={lt.summary || 'Manage scheduled tasks'}
            onClick={() => openTaskPanel(gid, tid, lt.seriesId)}
          >
            <span class="event-icon" aria-hidden="true">{'\u23F0'}</span>
            <span class="event-text">{lt.summary || 'Scheduled task'}</span>
            {trailer ? <span class="event-meta">{trailer}</span> : null}
          </button>
        );
      })}
    </>
  );
}

function TypingIndicator({ traceExpanded, onToggleTrace }: { traceExpanded: boolean; onToggleTrace: () => void }) {
  const stableStartedAt = typingStartedAt.value;
  const fallbackStartedAt = useRef(Date.now());
  const startedAt = stableStartedAt ?? fallbackStartedAt.current;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const model = typingModel.value ? shortModel(typingModel.value) : '';
  const metadata = [fmtDur(Math.max(0, now - startedAt)), model].filter(Boolean).join(' \u00b7 ');
  const liveHeadline = latestActivityHeadline(activityLog.value);
  return (
    <div class={`typing${traceExpanded ? ' expanded' : ''}`} aria-live="polite">
      <div class="typing-summary">
        <div class="typing-dots">
          <span></span><span></span><span></span>
          {!traceExpanded && (liveHeadline || typingHint.value)
            ? <span class="hint">{liveHeadline ? <StepHeadlineContent headline={liveHeadline} /> : typingHint.value}</span>
            : null}
          {activityLog.value.length
            ? (
              <button
                type="button"
                class="trace-toggle"
                aria-expanded={traceExpanded}
                aria-label={traceExpanded ? 'Hide activity' : 'Show activity'}
                title={traceExpanded ? 'Hide activity' : 'Show activity'}
                onClick={onToggleTrace}
              >
                <span class={`chevron${traceExpanded ? ' open' : ''}`}>{'\u203A'}</span>
              </button>
            )
            : null}
        </div>
        <div class="typing-meta">{metadata}</div>
      </div>
      {traceExpanded && activityLog.value.length
        ? <ActivityTraceList lines={activityLog.value} live now={now} />
        : null}
    </div>
  );
}

function MessageLog() {
  const ref = useRef<HTMLDivElement | null>(null);
  const appliedHighlightRef = useRef<string | null>(null);
  const prevMsgCountRef = useRef<number>(0);
  const wasTypingRef = useRef<boolean>(false);
  const prevScrollTickRef = useRef<number>(scrollToBottomTick.value);
  const prevTraceLenRef = useRef<number>(0);
  const prevExpandedRef = useRef<boolean>(false);
  // Whether the user has expanded the activity trace. Collapsed by default:
  // the bubble shows only the dots + latest hint + a chevron, and expands to
  // the scrollable step list on demand.
  const [traceExpanded, setTraceExpanded] = useState(false);
  const highlight = highlightMessageId.value;
  const timeline = mergeQuestionTimeline(chatMessages.value, pendingQuestions.value, threadId.value);
  const msgCount = timeline.length;
  const typing = isTyping.value && !!threadId.value && !chatLoading.value;
  const scrollTick = scrollToBottomTick.value;
  // Subscribe to trace growth so the effect re-runs as steps stream in.
  const traceLen = activityLog.value.length;

  const scrollToBottom = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };

  // Whether the user is pinned to the bottom of the log. Updated on every
  // scroll so trace-follow can distinguish "following along" from "scrolled
  // up to read history". Programmatic scrollToBottom also fires scroll, which
  // keeps this true while we tail the trace.
  const atBottomRef = useRef<boolean>(true);
  const onLogScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    if (!ref.current) return;
    // Check for explicit scroll-to-bottom request (e.g. user sent a message)
    if (scrollTick !== prevScrollTickRef.current) {
      prevScrollTickRef.current = scrollTick;
      scrollToBottom();
      return;
    }
    if (highlight) {
      // If the highlight changed, reset so we can apply the new one.
      if (appliedHighlightRef.current && appliedHighlightRef.current !== highlight) {
        appliedHighlightRef.current = null;
      }
      const el = ref.current.querySelector(`[data-msg-id="${CSS.escape(highlight)}"]`);
      if (el && appliedHighlightRef.current !== highlight) {
        appliedHighlightRef.current = highlight;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 2000);
      }
      // While a highlight is active (pending or applied), don't scroll to bottom.
    } else {
      appliedHighlightRef.current = null;
      const newMessages = msgCount !== prevMsgCountRef.current;
      const typingJustStarted = typing && !wasTypingRef.current;
      const traceGrew = traceLen > prevTraceLenRef.current;
      const justExpanded = traceExpanded && !prevExpandedRef.current;
      // The trace is collapsed by default; only when expanded is it rendered
      // as a bounded, internally-scrolling list. Keep its newest line visible
      // as steps stream in while expanded.
      if (traceExpanded && traceGrew) {
        const ul = ref.current.querySelector('.activity-trace');
        if (ul) ul.scrollTop = ul.scrollHeight;
      }
      // Follow the log to the bottom on new messages, when the typing
      // indicator first appears, when the user just expanded the trace (the
      // bubble grows), or as an expanded trace grows — the last only while
      // the user is pinned to the bottom, so we never yank them down if
      // they've scrolled up to read earlier messages.
      if (newMessages || typingJustStarted || justExpanded || (traceExpanded && traceGrew && atBottomRef.current)) {
        prevMsgCountRef.current = msgCount;
        scrollToBottom();
      }
      prevTraceLenRef.current = traceLen;
    }
    wasTypingRef.current = !!typing;
    prevExpandedRef.current = traceExpanded;
  });
  const list = timeline;
  const groups = groupMessages(list);
  return (
    <div class="log" id="chat-log" ref={ref} onScroll={onLogScroll}>
      {chatLoading.value
        ? null
        : !threadId.value
          ? <div class="empty">Pick or start a chat.</div>
          : list.length === 0
            ? <div class="empty">No messages yet.</div>
            : groups.map((g, i) => g.kind === 'thoughts'
                ? <ThoughtGroup key={i} thoughts={g.thoughts} answer={g.answer} />
                : g.kind === 'events'
                  ? <EventsGroup key={i} events={g.events} />
                  : <Message key={i} m={g.m} />)}
      {typing
        ? <TypingIndicator traceExpanded={traceExpanded} onToggleTrace={() => setTraceExpanded((v) => !v)} />
        : null}
      <TaskIndicator />
    </div>
  );
}

function ContextChip() {
  const pins = pinnedContext.value;
  if (pins.length === 0) return <div class="context" id="chat-context" hidden></div>;
  return (
    <div class="context" id="chat-context">
      {pins.map((p) => (
        <span class="chip" key={p}>
          <span>{'\uD83D\uDCCE'}</span>
          <span class="path" title={p}>{p}</span>
          <button type="button" title="Unpin" onClick={() => removePinnedPath(p)}>{'\u00d7'}</button>
        </span>
      ))}
    </div>
  );
}

function PendingTray() {
  const list = pending.value;
  if (list.length === 0) return <div class="pending" id="chat-pending" hidden></div>;
  return (
    <div class="pending" id="chat-pending">
      {list.map((f, i) => (
        <span class="item" key={i}>
          {'\uD83D\uDCCE '}{f.name} ({fmtBytesShort(f.size)})
          <button type="button" title="Remove" onClick={() => removePending(i)}>{'\u00d7'}</button>
        </span>
      ))}
    </div>
  );
}

function QuestionCardItem({ question: q, busy }: { question: PendingQuestionDto; busy: boolean }) {
  const [answer, setAnswer] = useState('');
  const answerRef = useRef('');
  const target = `question:${q.questionId}`;
  const recording = isRecording.value && activeRecordingTarget.value === target;
  const recorderBusy = isRecording.value;
  const serverTranscribeAvailable = voiceMode.value !== 'off';
  const micCapable = hasGetUserMedia() && (serverTranscribeAvailable || hasSpeechRecognition());
  const [transcribeStatus, setTranscribeStatus] = useState('');
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdModeRef = useRef(false);
  const submitAfterTranscriptRef = useRef(false);
  const canType = q.responseMode === 'text' || q.responseMode === 'choice_or_text';
  const answered = q.status === 'answered';

  const submitAnswer = (value = answerRef.current): void => {
    const trimmed = value.trim();
    if (trimmed) respondQuestion(q.questionId, trimmed).catch(console.error);
  };

  const insertTranscript = (text: string): void => {
    const current = answerRef.current;
    const next = current && !/\s$/.test(current) ? `${current} ${text}` : current + text;
    answerRef.current = next;
    setAnswer(next);
    if (submitAfterTranscriptRef.current) {
      submitAfterTranscriptRef.current = false;
      submitAnswer(next);
    }
  };

  const finishQuestionRecording = async (): Promise<void> => {
    if (activeRecordingTarget.value !== target) return;
    const result = await stopRecording();
    activeRecordingTarget.value = null;
    if (!result) {
      submitAfterTranscriptRef.current = false;
      chatStatus.value = 'too short — discarded';
      setTimeout(() => { if (chatStatus.value === 'too short — discarded') chatStatus.value = 'connected'; }, 2000);
      return;
    }
    if (result.transcript) {
      insertTranscript(result.transcript);
      return;
    }
    if (!serverTranscribeAvailable || !groupId.value || !threadId.value) {
      submitAfterTranscriptRef.current = false;
      chatStatus.value = 'transcription unavailable';
      setTimeout(() => { if (chatStatus.value === 'transcription unavailable') chatStatus.value = 'connected'; }, 3000);
      return;
    }
    setTranscribeStatus('transcribing…');
    transcribeViaServer(result.blob, groupId.value, threadId.value, {
      onPartial: (delta) => {
        setTranscribeStatus((previous) => (previous === 'transcribing…' ? '' : previous) + delta);
      },
      onDone: (fullText) => {
        setTranscribeStatus('');
        const trimmed = fullText.trim();
        if (!trimmed || trimmed === '[inaudible]') {
          submitAfterTranscriptRef.current = false;
          return;
        }
        if (looksLikeRefusal(trimmed)) {
          submitAfterTranscriptRef.current = false;
          chatStatus.value = 'transcription unclear — try again';
          setTimeout(() => { if (chatStatus.value === 'transcription unclear — try again') chatStatus.value = 'connected'; }, 3000);
          return;
        }
        insertTranscript(trimmed);
      },
      onError: (error) => {
        submitAfterTranscriptRef.current = false;
        setTranscribeStatus('');
        chatStatus.value = `transcription failed: ${error}`;
        setTimeout(() => { if (chatStatus.value.startsWith('transcription failed')) chatStatus.value = 'connected'; }, 3000);
      },
    });
  };

  const startQuestionRecording = async (): Promise<void> => {
    if (recorderBusy) return;
    activeRecordingTarget.value = target;
    const started = await startRecording(true);
    if (!started) {
      activeRecordingTarget.value = null;
      chatStatus.value = 'microphone unavailable';
      setTimeout(() => { if (chatStatus.value === 'microphone unavailable') chatStatus.value = 'connected'; }, 3000);
    }
  };

  const onMicPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    holdModeRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      holdModeRef.current = true;
      startQuestionRecording().catch(console.error);
    }, 300);
  };

  const onMicPointerUp = (): void => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdModeRef.current || recording) {
      holdModeRef.current = false;
      finishQuestionRecording().catch(console.error);
    } else {
      startQuestionRecording().catch(console.error);
    }
  };

  const onMicPointerCancel = (): void => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    holdModeRef.current = false;
    if (recording) {
      cancelRecording();
      activeRecordingTarget.value = null;
    }
  };

  useEffect(() => {
    if (q.status !== 'pending' && activeRecordingTarget.value === target) {
      cancelRecording();
      activeRecordingTarget.value = null;
    }
    return () => {
      if (activeRecordingTarget.value === target) {
        cancelRecording();
        activeRecordingTarget.value = null;
      }
    };
  }, [q.status, target]);

  return (
    <div class={`msg ${answered ? 'in question-card-answered' : 'out'} question-card`} data-msg-id={q.questionId}>
      <div class="question-card-heading">{q.title}</div>
      <div class="question-card-title">{q.question}</div>
      {answered ? (
        <div class="question-card-answer">
          {q.options.find((option) => option.value === q.answerValue)?.selectedLabel ?? q.answerValue}
        </div>
      ) : q.status === 'cancelled' ? (
        <div class="question-card-answer">Cancelled</div>
      ) : (
        <>
          {q.options.length > 0 && (
            <div class="question-card-actions">
              {q.options.map((o) => (
                <button
                  type="button"
                  class="question-card-btn"
                  disabled={busy}
                  onClick={() => respondQuestion(q.questionId, o.value).catch(console.error)}
                  key={o.value}
                >{o.label}</button>
              ))}
            </div>
          )}
          {canType && (
            <form
              class="question-card-text-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (recording) {
                  submitAfterTranscriptRef.current = true;
                  finishQuestionRecording().catch(console.error);
                  return;
                }
                if (transcribeStatus) {
                  submitAfterTranscriptRef.current = true;
                  return;
                }
                submitAnswer();
              }}
            >
              <div class={`composer-input-wrap question-response-input-wrap${recording ? ' recording' : ''}${transcribeStatus ? ' transcribing' : ''}`}>
                <textarea
                  class="question-card-input"
                  rows={1}
                  value={answer}
                  disabled={busy}
                  aria-label="Your answer"
                  placeholder="Type your answer…"
                  onInput={(event) => {
                    answerRef.current = event.currentTarget.value;
                    setAnswer(event.currentTarget.value);
                  }}
                />
                {micCapable ? (
                  <button
                    type="button"
                    class={`mic-overlay question-response-mic${recording ? ' recording' : ''}${transcribeStatus ? ' transcribing' : ''}`}
                    title={recording ? 'Tap to stop and transcribe' : transcribeStatus ? 'Transcribing…' : 'Hold to record, tap to toggle'}
                    aria-label={recording ? 'Stop recording answer' : transcribeStatus ? 'Transcribing answer' : 'Record voice answer'}
                    disabled={busy || !!transcribeStatus || (recorderBusy && !recording)}
                    onPointerDown={onMicPointerDown as unknown as JSX.PointerEventHandler<HTMLButtonElement>}
                    onPointerUp={onMicPointerUp as unknown as JSX.PointerEventHandler<HTMLButtonElement>}
                    onPointerCancel={onMicPointerCancel as unknown as JSX.PointerEventHandler<HTMLButtonElement>}
                  >
                    {recording
                      ? <span class="recording-time">{formatRecordingDuration(recordingDuration.value)}</span>
                      : transcribeStatus
                        ? <span class="mic-spinner" aria-hidden="true"></span>
                        : '\uD83C\uDF99\uFE0F'}
                  </button>
                ) : null}
                <button
                  type="submit"
                  class="question-response-send"
                  aria-label="Send answer"
                  title={recording || transcribeStatus ? 'Stop, transcribe, and send' : 'Send answer'}
                  disabled={busy || (!answer.trim() && !recording && !transcribeStatus)}
                  onMouseDown={(event) => event.preventDefault()}
                >{'\u2191'}</button>
              </div>
            </form>
          )}
        </>
      )}
      {q.activity?.length ? <ActivityTrace lines={q.activity} /> : null}
      <div class="meta question-card-meta">
        <RelativeTime ts={answered && q.answeredAt ? q.answeredAt : q.createdAt} />
      </div>
    </div>
  );
}

// Detect refusal-style output from a misconfigured server-side transcription
// model (e.g. a chat LLM standing in for whisper). These should never reach
// the composer.
const REFUSAL_PATTERNS = [
  /^i'?m sorry,? (but )?i (can'?t|cannot)/i,
  /^i (can'?t|cannot) (process|transcribe|help|assist|fulfill|comply)/i,
  /^sorry,? (but )?i (can'?t|cannot)/i,
  /^as an ai (language )?model/i,
  /^i (do not|don'?t) have the ability to/i,
];
function looksLikeRefusal(text: string): boolean {
  const head = text.slice(0, 200);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

function Composer() {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [quickCapture, setQuickCapture] = useState(false);
  const isWeb = !channelType.value || channelType.value === 'web';
  const showComposer = isWeb || canSend.value;
  // Web threads send over the WebSocket; if it isn't connected, block input
  // rather than silently dropping the message. Non-web channels post via
  // HTTP and don't care about chatStatus.
  const wsDown = isWeb && chatStatus.value !== 'connected';
  // Disable composer while a question card is awaiting user response.
  const hasQuestion = pendingQuestions.value.some(
    (q) => q.status === 'pending' && (!q.threadId || q.threadId === threadId.value),
  );
  const composerDisabled = wsDown || hasQuestion;
  const autosize = (): void => {
    const el = inputRef.current;
    if (!el) return;
    // When empty, size to min-height. Chrome's scrollHeight reflects the
    // placeholder when value is empty, which makes a long/wrapping
    // placeholder (e.g. the wsDown 'Reconnecting…') puff the box to two
    // lines and leaves it stuck there once the placeholder shortens.
    if (!el.value) {
      el.style.height = '';
      el.style.overflowY = 'hidden';
      setMultiLine(false);
      return;
    }
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, 200);
    el.style.height = h + 'px';
    // overflow:auto with subpixel borders triggers a phantom scrollbar even
    // below the cap; only show it when actually capped.
    el.style.overflowY = h >= 200 ? 'auto' : 'hidden';
    // Threshold tracks the single-line scrollHeight (~30px on desktop
    // with padding:5px + 1.4 line-height). Two lines push it past ~50.
    setMultiLine(h > 44);
  };
  // Mount + width-change observer. The empty-value early return inside
  // autosize() means we don't need to re-run on focus or on wsDown
  // placeholder changes — only the value and the available width can
  // change the right height.
  useEffect(() => {
    autosize();
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Width changes (pane toggle, drawer, viewport resize) rewrap text
    // and change scrollHeight; re-run autosize so the box tracks content.
    // No-op when empty (early return), idempotent when stable, so this
    // doesn't ping-pong on the height changes autosize itself causes.
    const ro = new ResizeObserver(autosize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onSubmit = (ev: JSX.TargetedEvent<HTMLFormElement>): void => {
    ev.preventDefault();
    // Mic recording in flight → stop, transcribe, then submit. The
    // finishRecording / transcribe-callback paths trigger maybeAutoSend()
    // once the transcript (if any) is folded into the composer.
    if (recording && recordingModeRef.current === 'mic') {
      autoSendRef.current = true;
      finishRecording().catch(console.error);
      return;
    }
    // User already stopped, transcription still in flight → queue submit
    // for when onDone/onError fires.
    if (transcribingRef.current) {
      autoSendRef.current = true;
      return;
    }
    doSubmit();
  };
  const doSubmit = (): void => {
    const text = (inputRef.current?.value || '').trim();
    const files = pending.value.slice();
    if (!text && files.length === 0) return;
    const pins = pinnedContext.value;
    const prefix = pins.length > 0
      ? '> Context (file browser):\n' + pins.map((p) => `> - \`${p}\``).join('\n') + '\n\n'
      : '';
    const fullText = prefix + text;
    if (inputRef.current) inputRef.current.value = '';
    autosize();
    clearPending();
    clearPinnedContext();
    sendChat(fullText, files).catch(console.error);
  };
  // Set by onSubmit when the user presses Send while mic recording or
  // transcribing. Consumed by maybeAutoSend(); cleared on first fire.
  const autoSendRef = useRef(false);
  const maybeAutoSend = (): void => {
    if (!autoSendRef.current) return;
    autoSendRef.current = false;
    doSubmit();
  };
  const onKey = (ev: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void => {
    // On mobile, Enter inserts a newline (matches platform keyboard
    // convention — Send is the dedicated button). On desktop, Enter sends
    // and Shift+Enter inserts a newline.
    if (ev.key === 'Enter' && !ev.shiftKey && !isMobile.value) {
      ev.preventDefault();
      ev.currentTarget.form?.requestSubmit();
    }
  };
  const onAttachClick = (): void => fileRef.current?.click();
  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    addPendingFiles(files, UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
  };
  const onFileChange = (ev: JSX.TargetedEvent<HTMLInputElement>): void => {
    const files = Array.from(ev.currentTarget.files || []);
    ev.currentTarget.value = '';
    addFiles(files);
  };
  const onPaste = (ev: ClipboardEvent): void => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (!items || items.length === 0) return;
    ev.preventDefault();
    addFiles(Array.from(items));
  };

  // ── Voice capture ──────────────────────────────────────────────────
  // Two paths share the recorder:
  //   - mic button (PTT or tap-toggle): always transcribes, inserts text
  //     into the composer for editing. Never auto-sends.
  //   - + menu "Record audio attachment": records a blob and adds it as a
  //     pending file (only available when the responding model accepts
  //     audio — voiceMode === 'audio').
  const vm = voiceMode.value;
  const serverTranscribeAvailable = vm !== 'off';
  const micCapable = hasGetUserMedia() && (serverTranscribeAvailable || hasSpeechRecognition());
  const recorderBusy = isRecording.value;
  const recording = recorderBusy && activeRecordingTarget.value === 'composer';
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdModeRef = useRef(false);
  // 'mic' = transcribe-to-composer; 'attach' = blob-only attachment.
  const recordingModeRef = useRef<'mic' | 'attach' | null>(null);
  const attachRecording = recording && recordingModeRef.current === 'attach';

  const transcribingRef = useRef(false);
  const [transcribeStatus, setTranscribeStatus] = useState('');
  // True once the textarea has grown beyond a single line. Triggers the
  // "buttons get their own row" layout: textarea uses full width for
  // text, +/mic/Send sit in a dedicated strip at the bottom.
  const [multiLine, setMultiLine] = useState(false);
  // Holds transcript text that arrived while the textarea was unmounted
  // (replaced by the recording or transcribing indicator). Drained by the
  // useEffect below once the textarea re-mounts.
  const pendingInsertRef = useRef<string | null>(null);

  const doInsert = (el: HTMLTextAreaElement, text: string): void => {
    const cur = el.value;
    // Insert at the caret (or replace the current selection). When the
    // textarea has never been focused, selectionStart/End sit at 0 by
    // default — fall back to end-of-text so dictation doesn't land before
    // typed content.
    const hasFocus = document.activeElement === el;
    const start = hasFocus ? (el.selectionStart ?? cur.length) : cur.length;
    const end = hasFocus ? (el.selectionEnd ?? start) : cur.length;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const leftPad = before && !/\s$/.test(before) ? ' ' : '';
    const rightPad = after && !/^\s/.test(after) ? ' ' : '';
    const insert = leftPad + text + rightPad;
    el.value = before + insert + after;
    autosize();
    const caret = (before + insert).length;
    // Skip .focus() on mobile so the OS keyboard doesn't pop up after
    // dictation. The user taps the textarea explicitly if they want to
    // edit. Desktop benefits from focus so they can keep typing.
    if (!isMobile.value) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
    maybeAutoSend();
  };

  // Drain pendingInsert after every render. Re-runs whenever the textarea
  // becomes available (recording → false, transcribeStatus → '').
  useEffect(() => {
    if (pendingInsertRef.current == null) return;
    const el = inputRef.current;
    if (!el) return;
    const text = pendingInsertRef.current;
    pendingInsertRef.current = null;
    doInsert(el, text);
  });

  const insertIntoComposer = (text: string): void => {
    const el = inputRef.current;
    if (el) {
      doInsert(el, text);
      return;
    }
    // Textarea is currently hidden behind the recording / transcribing
    // indicator. Stash the text and let the useEffect insert it once the
    // textarea re-mounts.
    const queued = pendingInsertRef.current;
    pendingInsertRef.current = queued ? `${queued} ${text}` : text;
  };

  const attachAudioBlob = (blob: Blob): void => {
    const rawType = blob.type.split(';')[0] || 'audio/mp4';
    const ext = rawType.includes('ogg') ? 'ogg' : rawType.includes('mp4') ? 'm4a' : rawType.includes('wav') ? 'wav' : 'webm';
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: rawType });
    addPendingFiles([file], UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
  };

  const finishRecording = async (): Promise<void> => {
    if (activeRecordingTarget.value !== 'composer') return;
    const mode = recordingModeRef.current;
    recordingModeRef.current = null;
    const result = await stopRecording();
    activeRecordingTarget.value = null;
    if (!result) {
      chatStatus.value = 'too short — discarded';
      setTimeout(() => { if (chatStatus.value === 'too short — discarded') chatStatus.value = 'connected'; }, 2000);
      maybeAutoSend();
      return;
    }
    if (mode === 'attach') {
      attachAudioBlob(result.blob);
      return;
    }
    // mic mode → transcribe to composer. Prefer client transcript;
    // fall back to server when a transcription model is configured.
    if (result.transcript) {
      insertIntoComposer(result.transcript);
      return;
    }
    if (!serverTranscribeAvailable) {
      chatStatus.value = 'transcription unavailable';
      setTimeout(() => { if (chatStatus.value === 'transcription unavailable') chatStatus.value = 'connected'; }, 3000);
      maybeAutoSend();
      return;
    }
    if (!groupId.value || !threadId.value) {
      maybeAutoSend();
      return;
    }
    transcribingRef.current = true;
    setTranscribeStatus('transcribing…');
    transcribeViaServer(result.blob, groupId.value, threadId.value, {
      onPartial: (delta) => {
        setTranscribeStatus((prev) => {
          const cur = prev === 'transcribing…' ? '' : prev;
          return cur + delta;
        });
      },
      onDone: (fullText) => {
        transcribingRef.current = false;
        setTranscribeStatus('');
        const trimmed = fullText.trim();
        if (!trimmed || trimmed === '[inaudible]') {
          maybeAutoSend();
          return;
        }
        if (looksLikeRefusal(trimmed)) {
          chatStatus.value = 'transcription unclear — try again';
          setTimeout(() => { if (chatStatus.value === 'transcription unclear — try again') chatStatus.value = 'connected'; }, 3000);
          maybeAutoSend();
          return;
        }
        insertIntoComposer(trimmed);
      },
      onError: (err) => {
        transcribingRef.current = false;
        setTranscribeStatus('');
        chatStatus.value = `transcription failed: ${err}`;
        setTimeout(() => { if (chatStatus.value.startsWith('transcription failed')) chatStatus.value = 'connected'; }, 3000);
        maybeAutoSend();
      },
    });
  };

  const onMicPointerDown = (ev: PointerEvent): void => {
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    holdModeRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      // Held > 300ms → hold mode
      holdModeRef.current = true;
      recordingModeRef.current = 'mic';
      activeRecordingTarget.value = 'composer';
      startRecording(true).then((started) => {
        if (!started) activeRecordingTarget.value = null;
      }).catch(console.error);
    }, 300);
  };

  const onMicPointerUp = (): void => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdModeRef.current) {
      // Release after hold → stop & transcribe
      holdModeRef.current = false;
      finishRecording().catch(console.error);
    } else if (recording) {
      // Tap while recording (toggle mode) → stop & transcribe
      finishRecording().catch(console.error);
    } else {
      // Short tap → toggle mode start
      recordingModeRef.current = 'mic';
      activeRecordingTarget.value = 'composer';
      startRecording(true).then((started) => {
        if (!started) activeRecordingTarget.value = null;
      }).catch(console.error);
    }
  };

  const onMicPointerCancel = (): void => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdModeRef.current || recording) {
      cancelRecording();
      activeRecordingTarget.value = null;
      recordingModeRef.current = null;
      holdModeRef.current = false;
    }
  };

  const startAudioAttachRecording = async (): Promise<void> => {
    if (recorderBusy) return;
    recordingModeRef.current = 'attach';
    activeRecordingTarget.value = 'composer';
    const ok = await startRecording(false);
    if (!ok) {
      recordingModeRef.current = null;
      activeRecordingTarget.value = null;
      chatStatus.value = 'microphone unavailable';
      setTimeout(() => { if (chatStatus.value === 'microphone unavailable') chatStatus.value = 'connected'; }, 3000);
    }
  };

  const stopAttachRecording = (): void => {
    if (recordingModeRef.current !== 'attach') return;
    finishRecording().catch(console.error);
  };

  return (
    <>
    <form
      id="chat-form"
      onSubmit={onSubmit}
      style={showComposer ? '' : 'display:none'}
      class={`${composerDisabled ? 'ws-down' : ''} ${recording ? 'recording' : ''}`}
    >
      <input type="file" id="chat-file" multiple hidden ref={fileRef} onChange={onFileChange} />
      {attachRecording ? (
        <button
          type="button"
          id="chat-recording-indicator"
          class="recording-stop-btn"
          onClick={stopAttachRecording}
          title="Tap to stop recording"
        >
          <span class="recording-dot"></span>
          <span class="recording-time">{formatRecordingDuration(recordingDuration.value)}</span>
          <span class="recording-stop-label">Stop</span>
        </button>
      ) : (
        <div class={'composer-input-wrap' + (multiLine ? ' multi-line' : '') + (recording ? ' recording' : '') + (transcribeStatus ? ' transcribing' : '')}>
          {/* Textarea stays mounted across recording/transcribing states so
              the user's drafted text is never lost. Indicators render on
              top of it. The +, mic, and Send buttons are absolutely
              positioned inside this wrap to save horizontal space; the
              textarea reserves room for them via padding-left/right. */}
          <textarea
            id="chat-input"
            rows={1}
            placeholder={hasQuestion ? 'Answer the question above to continue\u2026' : wsDown ? 'Reconnecting\u2026' : 'Message the agent\u2026'}
            ref={inputRef}
            onInput={autosize}
            onKeyDown={onKey}
            onPaste={onPaste as unknown as JSX.ClipboardEventHandler<HTMLTextAreaElement>}
            autocomplete="off"
            disabled={hasQuestion}
          ></textarea>
          <ComposerPlusMenu
            disabled={composerDisabled || recording}
            title={composerDisabled ? (hasQuestion ? 'Answer the question above' : 'Disconnected') : 'Add\u2026'}
            showRecordAudio={vm === 'audio' && hasGetUserMedia()}
            showQuickCapture={hasGetUserMedia()}
            onUploadFile={onAttachClick}
            onQuickCapture={() => setQuickCapture(true)}
            onRecordAudio={() => { startAudioAttachRecording().catch(console.error); }}
          />
          {micCapable ? (
            <button
              type="button"
              id="chat-mic"
              class={'mic-overlay' + (recording ? ' recording' : '') + (transcribeStatus ? ' transcribing' : '')}
              title={recording
                ? 'Tap to stop and transcribe'
                : transcribeStatus
                  ? 'Transcribing\u2026'
                  : wsDown
                    ? 'Disconnected'
                    : 'Hold to record, tap to toggle'}
              aria-label={recording ? 'Stop recording' : transcribeStatus ? 'Transcribing' : 'Record voice message'}
              disabled={(composerDisabled && !recording) || !!transcribeStatus || (recorderBusy && !recording)}
              onPointerDown={onMicPointerDown as unknown as JSX.PointerEventHandler<HTMLButtonElement>}
              onPointerUp={onMicPointerUp as unknown as JSX.PointerEventHandler<HTMLButtonElement>}
              onPointerCancel={onMicPointerCancel as unknown as JSX.PointerEventHandler<HTMLButtonElement>}
            >
              {recording
                ? <span class="recording-time">{formatRecordingDuration(recordingDuration.value)}</span>
                : transcribeStatus
                  ? <span class="mic-spinner" aria-hidden="true"></span>
                  : '\uD83C\uDF99\uFE0F'}
            </button>
          ) : null}
          <button
            type="submit"
            id="chat-send"
            aria-label="Send"
            title={recording || transcribeStatus ? 'Stop, transcribe, and send' : 'Send'}
            disabled={composerDisabled}
            onMouseDown={(e) => e.preventDefault()}
          >{'\u2191'}</button>
        </div>
      )}
    </form>
    {quickCapture ? (
      <QuickCapture
        onCapture={(file) => { setQuickCapture(false); addFiles([file]); }}
        onClose={() => setQuickCapture(false)}
      />
    ) : null}
    </>
  );
}

function ReadonlyBanner() {
  const isWeb = !channelType.value || channelType.value === 'web';
  const showComposer = isWeb || canSend.value;
  if (showComposer) return <div class="readonly-banner" hidden></div>;
  const meta = channelMeta(channelType.value);
  return <div class="readonly-banner">Read-only view — reply on {meta.label} to continue this thread.</div>;
}

function Subnotice() {
  const isWeb = !channelType.value || channelType.value === 'web';
  const showComposer = isWeb || canSend.value;
  if (!(showComposer && !isWeb)) return <div class="chat-subnotice" hidden></div>;
  const meta = channelMeta(channelType.value);
  const t = threads.value.find((x) => x.threadId === threadId.value);
  const cp = t && t.counterparty ? ` \u00b7 ${t.counterparty}` : '';
  return <div class="chat-subnotice">{meta.icon} Sending via {meta.label}{cp}</div>;
}

export function ChatMain() {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let depth = 0;
    const hasFiles = (ev: DragEvent): boolean => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    const onEnter = (ev: DragEvent): void => { if (!hasFiles(ev)) return; ev.preventDefault(); depth++; el.classList.add('drag-active'); };
    const onOver = (ev: DragEvent): void => { if (!hasFiles(ev)) return; ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; };
    const onLeave = (): void => { depth = Math.max(0, depth - 1); if (depth === 0) el.classList.remove('drag-active'); };
    const onDrop = (ev: DragEvent): void => {
      if (!ev.dataTransfer) return;
      ev.preventDefault();
      depth = 0;
      el.classList.remove('drag-active');
      const files = Array.from(ev.dataTransfer.files || []);
      if (files.length > 0) addPendingFiles(files, UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragover', onOver);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('drop', onDrop);
    };
  }, []);
  return (
    <section class="chat-main" id="chat-main" ref={ref}>
      <ApprovalsBanner />
      <MessageLog />
      <div class="status" id="chat-status">{chatStatus.value}</div>
      <ContextChip />
      <PendingTray />
      <ReadonlyBanner />
      <Subnotice />
      <Composer />
    </section>
  );
}
