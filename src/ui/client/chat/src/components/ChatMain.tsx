// Chat main: message log, status, context chip, pending tray, readonly
// banner, composer.
import './ChatMain.css';
import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useRef, useEffect, useLayoutEffect, useState } from 'preact/hooks';
import {
  chatMessages, chatStatus, chatLoading, chatReady, chatReloadRequired, threadId, channelType, canSend, pending,
  threads, groups, groupId, messagingGroupId, channelMeta, pinnedContext, pendingApprovals, respondingApprovalIds,
  pendingQuestions,
  highlightMessageId, searchQuery, voiceInput, isMobile, scrollToBottomTick,
  currentUserId,
  pendingWebSends,
  activeTurn, turnConnected, stopRequest,
  UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE, UPLOAD_MAX_FILES,
} from '../state';
import { displayWorkspacePath, renderMarkdown, rewriteFileLinks, highlightTextNodes, fmtBytesShort } from '../utils';
import {
  sendChat, retryChatSend, warmChat, addPendingFiles, removePending,
  navFile, previewAttachment, removePinnedPath, clearPinnedContext, respondApproval,
  openChat, openTaskPanel, reconnectChatNow, forkThreadAt, editMessageInBranch,
} from '../actions';
import { requestConfirm } from './PromptModal';
import { isRecording, recordingDuration, startRecording, stopRecording, cancelRecording, hasGetUserMedia } from '../recorder';
import { voice, voiceBrowserReason } from '../voice-audio';
import { ComposerInput, useComposerTextarea } from './ComposerInput';
import { ActiveTurnStopButton } from './ActiveTurnStopButton';
import { ToolStopButton } from './ToolStopButton';
import { toolStopRequest } from '../stop-tool';
import { PendingMessageActions } from './PendingMessageActions';
import { canEditMessageInBranch, composerSendInFlight, currentPendingEditor } from '../pending-edit';
import { usePendingComposer } from '../pending-composer';
import { splitPendingInputs } from '../queued-followups';
import { isSystemNotice, showsMidTurnLabel } from '../chat-protocol';
import type { ConversationTurn } from '../../../../shared/conversation';
import { isTurnStartStep, QUEUED_TEXT, turnRequestedAt } from '../../../../shared/conversation-activity';
import {
  activityChapters, activityStepCount, headlineSummary, isOutcomeTraceStep, isTitleStep, isTodoStep, parseStep,
  todoItems, traceStatus, traceStatusClass, TRACE_STATUS_LABELS, TRACE_STEP_THRESHOLD_MS,
  type ModelTime, type StepHeadline, type TraceEntry, type TraceStatus, type TraceStep,
} from '../../../../shared/activity-presentation';
import { formatStopwatch } from '../duration-format';
import { chatTranscript, completedResponse, conversationState } from '../conversation-state';
import { submissionPresentation } from '../web-submissions';
import {
  activityTraceOwner, activityTraceExpanded, toggleActivityTrace, submissionTraceOwner,
  activityMetricsExpanded, toggleActivityMetrics,
} from '../activity-trace-state';
import { responseScrollTop } from '../turn-completion';
import { activeTurnNotices, hasTurnStats, liveTurnActivity, turnRowView } from '../turn-row';
import { formatContextPercent as fmtPct, formatUsageCost as fmtCost, latestContextUsage, technicalSummary, type KnownContext } from '../technical-summary';
import { inputStatePresentation } from '../input-state';
import { SUGGESTED_ACTIONS, isFutureWorkMessage } from '../future-work';
import { findEditBranchAnchorId } from '../edit-message';
import { BRANCH_ACTION_EXPLANATION, editBranchActionExplanation } from '../transcript-action-copy';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { QuickCapture } from './QuickCapture';
import { QuestionPrompt } from './QuestionPrompt';
import { QuestionAnswerBubble } from './QuestionAnswerBubble';
import { dockQuestions } from '../question-dock';
import { RelativeTime } from './RelativeTime';
import { ModalDialog } from './ModalDialog';
import { MessageBubble } from './MessageBubble';
import { ZoomableImage } from './ZoomableImage';
import { BranchIcon, EditIcon } from './ActionIcons';
import { CopyTranscriptButton } from './CopyTranscriptButton';
import { ScrollNavigationButtons } from './ScrollNavigationButtons';
import { attachScrollNavigation, type ScrollDirection, type ScrollNavigation } from '../scroll-navigation';
import { getAppearanceController } from '../appearance';
import { appearance } from '../appearance-state';
import { attachDensityReflow } from '../density-reflow';
import { attachScrollEdges } from '../scroll-edges';
import { revealLatestActivity } from '../activity-trace-scroll';
import { showToast } from './Toast';
import './ZoomableImage.css';
import type { ActivityLine, ChatMessage, DisplayCard, ForkChild, ForkOrigin, PendingWebSend, Thread, TranscriptRow, TurnUsage } from '../types';

const imageViewer = signal<{ src: string; alt: string; name: string } | null>(null);
const revealedMobileMessageActionsId = signal<string | null>(null);

function imageFileName(src: string): string {
  try {
    const name = new URL(src, window.location.href).pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : 'Image preview';
  } catch {
    return 'Image preview';
  }
}

function ImageViewer() {
  const image = imageViewer.value;
  if (!image) return null;

  return (
    <ModalDialog
      title={image.name}
      onClose={() => { imageViewer.value = null; }}
      className="image-viewer-dialog"
      backdropClassName="image-viewer-backdrop"
      maxWidth="calc(100vw - 32px)"
    >
        <ZoomableImage src={image.src} alt={image.alt} className="image-viewer-stage" autoFocus />
    </ModalDialog>
  );
}

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

function StepHeadlineContent({ headline, repetitions = 1 }: { headline: StepHeadline; repetitions?: number }) {
  return (
    <>
      {headline.action}
      {headline.subject
        ? <>{headline.action ? ' ' : null}{headline.codeSubject ? <code class="trace-subject">{headline.subject}</code> : headline.subject}</>
        : null}
      {repetitions > 1 ? ` · ${repetitions} times` : null}
    </>
  );
}

function stepMeta(s: TraceStep, elapsedMs: number | null): string | null {
  if (s.kind !== 'tool') return null;
  const status = TRACE_STATUS_LABELS[traceStatus(s)];
  const duration = s.status === 'running' ? elapsedMs : s.durationMs;
  const formattedDuration = typeof duration !== 'number' || (s.status !== 'running' && isZeroTime(duration))
    ? '' : formatStopwatch(duration, s.status !== 'running');
  return `${status}${formattedDuration ? ` · ${formattedDuration}` : ''}`;
}

function formatElapsedDuration(ms: number): string {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${ms < 0 ? '-' : ''}${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** A finished duration that would display as zero; live stopwatches still start from zero. */
const isZeroTime = (ms: number) => formatStopwatch(ms) === formatStopwatch(0);

/** Self-ticking stopwatch: tenths below 10s, then whole seconds. */
function LiveDuration({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  const elapsed = Math.max(0, now - since);
  const tick = elapsed < 10_000 ? 100 : 1000;
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), tick);
    return () => window.clearTimeout(timer);
  }, [now, tick]);
  return <>{formatStopwatch(elapsed)}</>;
}

/** A finished duration, or the start of a live one. */
type ChipTime = { ms: number } | { since: number };
const TIME_HINTS = { cpu: 'Execution time', ai: 'Model time' };

/** One cell of a trace time column. Always rendered so grid columns stay in place. */
function TimeCell({ kind, time }: { kind: 'cpu' | 'ai'; time: ChipTime | null }) {
  return (
    <span class={`trace-time trace-time-${kind}`} title={time ? TIME_HINTS[kind] : undefined}>
      {time ? 'since' in time ? <LiveDuration since={time.since} /> : formatStopwatch(time.ms) : null}
    </span>
  );
}

/** Finished zero durations are hidden; live stopwatches count up from zero. */
function shownChipTime(time: ChipTime | null): ChipTime | null {
  return time && 'ms' in time && isZeroTime(time.ms) ? null : time;
}

/** A live tail ticks on top of the finished time. */
function modelChipTime(modelTime: ModelTime | undefined): ChipTime | null {
  if (!modelTime) return null;
  return modelTime.since !== undefined ? { since: modelTime.since - modelTime.ms } : { ms: modelTime.ms };
}

function rowTimes(line: ActivityLine, step: TraceStep, live: boolean): { cpu: ChipTime | null; ai: ChipTime | null } {
  const startedAt = Number(line.ts);
  const cpu: ChipTime | null = execRunning(step, live)
    ? line.ts && Number.isFinite(startedAt) ? { since: startedAt } : null
    : isTimedStep(step) && typeof step.durationMs === 'number' ? { ms: step.durationMs } : null;
  return { cpu: shownChipTime(cpu), ai: shownChipTime(modelChipTime(line.modelTime)) };
}

function isTimedStep(step: TraceStep): boolean {
  return step.kind === 'tool' || step.kind === 'compaction' || isTurnStartStep(step);
}

/** A running timed step without a final duration; the start row keeps running after its wait ends. */
function execRunning(step: TraceStep, live: boolean): boolean {
  return live && isTimedStep(step) && step.status === 'running' && step.durationMs === undefined;
}

/** Chapter execution time counts overlapping child intervals once. */
function chapterTimes(entries: TraceEntry[], live: boolean) {
  let exec = 0;
  let execSince: number | null = null;
  const spans: Array<[number, number]> = [];
  let timed = false;
  let model = 0;
  let modelSince: number | null = null;
  for (const { line, step } of entries) {
    if (isTimedStep(step)) {
      timed = true;
      const startedAt = Number(line.ts);
      if (line.ts && Number.isFinite(startedAt)) {
        if (execRunning(step, live)) spans.push([startedAt, Infinity]);
        else if (step.durationMs !== undefined) spans.push([startedAt, startedAt + step.durationMs]);
      } else exec += step.durationMs ?? 0;
    }
    if (!line.modelTime) continue;
    model += line.modelTime.ms;
    if (line.modelTime.since !== undefined) modelSince = line.modelTime.since;
  }
  let covered = -Infinity;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (end <= covered) continue;
    if (end === Infinity) {
      execSince = start;
      exec -= Math.max(0, covered - start);
      break;
    }
    exec += end - Math.max(start, covered);
    covered = end;
  }
  return {
    cpu: shownChipTime(!timed ? null : execSince !== null ? { since: execSince - exec } : { ms: exec }),
    ai: shownChipTime(modelSince !== null ? { since: modelSince - model } : { ms: model }),
  };
}

function ActivityTraceRow({ entry, open, live, now, onToggle, child = false, turnId = null }: { entry: TraceEntry; open: boolean; live: boolean; now: number | null; onToggle: () => void; child?: boolean; turnId?: string | null }) {
  const { line, step, headline } = entry;
  const summary = headlineSummary(headline);
  const running = live && isTimedStep(step) && step.status === 'running';
  const startedAt = Number(line.ts);
  const hasStartedAt = !!line.ts && Number.isFinite(startedAt);
  const code = open ? entry.body : null;
  const elapsedMs = running && hasStartedAt && now !== null ? Math.max(0, now - startedAt) : null;
  const statusText = stepMeta(step, elapsedMs);
  const timestamp = open ? fmtActivityTs(line.ts) : '';
  const meta = open ? [timestamp, statusText].filter(Boolean).join(' · ') : '';
  const times = rowTimes(line, step, live);
  const todos = open ? todoItems(step) : null;
  // Stop appears once a running tool passes the threshold.
  const stoppable = elapsedMs !== null && elapsedMs >= TRACE_STEP_THRESHOLD_MS;
  const stoppableId = stoppable && step.kind === 'tool' && step.id ? step.id : null;
  const stopError = stoppableId && turnId ? toolStopRequest(turnId, stoppableId)?.error : '';
  return (
    <li class={`trace-row ${traceStatusClass(step)}${open ? ' open' : ''}${child ? ' trace-child' : ''}`}>
      <div class="trace-row-header">
        <button
          type="button"
          class="trace-row-toggle"
          aria-expanded={open}
          title={open ? 'Collapse step' : `${summary}${statusText ? ` · ${statusText}` : ''}`}
          aria-label={`${summary}${statusText ? ` · ${statusText}` : ''}`}
          onClick={onToggle}
        >
          <span class="trace-marker" aria-hidden="true"><span class="trace-dot" /></span>
          <TimeCell kind="cpu" time={times.cpu} />
          <TimeCell kind="ai" time={times.ai} />
          <span class="trace-text"><StepHeadlineContent headline={headline} /></span>
        </button>
        {/* Replaces the timeline node; a button cannot nest inside the toggle. */}
        {stoppableId && turnId ? <span class="trace-stop"><ToolStopButton turnId={turnId} toolCallId={stoppableId} /></span> : null}
      </div>
      {stopError ? <div class="trace-note turn-stop-error" role="alert">{stopError}</div> : null}
      {meta ? <div class="trace-meta">{meta}</div> : null}
      {open && isTitleStep(step) && !step.detail ? <div class="trace-note">The title was not recorded for this activity.</div> : null}
      {todos ? <ul class="trace-todos">
        {todos.map((todo, index) => {
          const status = todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'running'
            : todo.status === 'pending' ? 'queued' : todo.status === 'cancelled' ? 'interrupted' : 'unknown';
          const label = todo.status === 'in_progress' ? 'In progress' : todo.status[0].toUpperCase() + todo.status.slice(1);
          return <li key={index} class={`trace-todo trace-status-${status}`}>
            <span class="trace-todo-icon" role="img" aria-label={label}>{todo.status === 'completed' ? '\u2713' : todo.status === 'in_progress' ? '\u25b8' : todo.status === 'cancelled' ? '\u2013' : '\u25cb'}</span>
            <span class="trace-todo-content">{todo.content}{todo.priority ? <small>{todo.priority} priority</small> : null}</span>
          </li>;
        })}
      </ul> : null}
      {open && isTodoStep(step) && !code ? <div class="trace-note">TODO items were not recorded for this activity.</div> : null}
      {open && code != null && !todos
        ? <pre class="trace-code"><code>{code}</code></pre>
        : null}
      {open && todos && step.error ? <pre class="trace-code"><code>{step.error}</code></pre> : null}
    </li>
  );
}

type ActivityTraceTarget = { latest: string | null; chapter: string | null; entry: string | null } | null;

export function ActivityTraceList({ lines, live = false, now = null, turnId = null }: { lines: ActivityLine[]; live?: boolean; now?: number | null; turnId?: string | null }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<ActivityTraceTarget>(null);
  useEffect(() => {
    if (listRef.current) return attachScrollEdges(listRef.current);
  }, []);
  const revealed = useRef(false);
  const chapters = activityChapters(lines, live);
  // Outcome summaries do not advance chapter following.
  const latestChapter = [...chapters].reverse().find(chapter => chapter.entries.some(entry => !isOutcomeTraceStep(entry.step)));
  const latestEntryId = latestChapter?.entries.at(-1)?.id ?? null;
  const selection = target?.latest === latestEntryId ? target : null;
  const sel = selection?.entry ?? null;
  const openChapter = selection ? selection.chapter : latestChapter?.id ?? null;
  const following = !selection || sel === latestEntryId;
  useLayoutEffect(() => {
    if (!listRef.current || !lines.length) return;
    if (!revealed.current || (live && following)) revealLatestActivity(listRef.current, live && following && sel === latestEntryId);
    revealed.current = true;
  }, [lines, live, following, sel, openChapter]);
  const toggle = (chapterId: string, id: string) => {
    const opening = sel !== id;
    setTarget({ latest: latestEntryId, chapter: chapterId, entry: opening ? id : null });
  };
  const toggleChapter = (id: string) => {
    setTarget({ latest: latestEntryId, chapter: openChapter === id ? null : id, entry: null });
  };
  // The table scrolls both ways so long labels stay readable on narrow screens.
  return (
    <div class={`trace-table scroll-edge-fade${chapters.some(chapter => chapter.entries.length > 1) ? ' has-chapters' : ''}`} ref={listRef}>
      <ul class="activity-trace" tabIndex={0} aria-label="Activity steps">
        {chapters.map((chapter) => {
          if (chapter.entries.length === 1) {
            const entry = chapter.entries[0];
            return <ActivityTraceRow key={chapter.id} entry={entry} open={entry.id === sel} live={live} now={now} turnId={turnId} onToggle={() => toggle(chapter.id, entry.id)} />;
          }
          const open = openChapter === chapter.id;
          const times = chapterTimes(chapter.entries, live);
          return <li key={chapter.id} class={`trace-chapter trace-status-${chapter.status}${open ? ' open' : ''}`}>
            <div class="trace-row-header">
              <button type="button" class="trace-chapter-toggle" aria-expanded={open}
                aria-label={`${chapter.title} · ${TRACE_STATUS_LABELS[chapter.status]}${chapter.failures ? ` · ${chapter.failures} failed` : ''}`}
                onClick={() => toggleChapter(chapter.id)}>
                <span class="trace-marker" aria-hidden="true"><span class="trace-dot" /></span>
                <TimeCell kind="cpu" time={times.cpu} />
                <TimeCell kind="ai" time={times.ai} />
                <span class="trace-chapter-label">
                  <span class="trace-chapter-heading">
                    <span class="trace-chapter-title"><StepHeadlineContent headline={chapter.headline} repetitions={chapter.entries.length} /></span>
                    {chapter.failures ? <span class="trace-chapter-failures">{chapter.failures} failed</span> : null}
                    {chapter.status === 'unknown' || chapter.status === 'interrupted' ? <span class="trace-chapter-notice">{chapter.status === 'unknown' ? 'Outcome unknown' : 'Interrupted'}</span> : null}
                  </span>
                </span>
              </button>
            </div>
            {open ? <ul class="trace-children">
              {chapter.entries.map(entry => <ActivityTraceRow key={entry.id} entry={entry} open={entry.id === sel}
                live={live} now={now} turnId={turnId} onToggle={() => toggle(chapter.id, entry.id)} child />)}
            </ul> : null}
          </li>;
        })}
      </ul>
    </div>
  );
}

/** Display-only outcome entries can offer a trace even without recorded activity. */
function ActivityTraceToggle({ count, hasOutcome = false, expanded, onToggle }: { count: number; hasOutcome?: boolean; expanded: boolean; onToggle: () => void }) {
  if (!count && !hasOutcome) return null;
  return (
    <button
      type="button"
      class="trace-toggle"
      aria-expanded={expanded}
      aria-label={expanded ? 'Hide activity' : 'Show activity'}
      title={expanded ? 'Hide activity' : 'Show activity'}
      onClick={onToggle}
    >
      <span class={`chevron${expanded ? ' open' : ''}`}>{'\u203A'}</span>
      <span class="trace-count">{count ? `${count} trace${count === 1 ? '' : 's'}` : 'trace'}</span>
    </button>
  );
}

/** Inline metrics and step list, shared by live and completed traces. */
function ActivityTracePanel({
  lines,
  expanded,
  live = false,
  now = null,
  ownerId,
  turnId = null,
  metrics = null,
}: {
  lines: ActivityLine[];
  expanded: boolean;
  live?: boolean;
  now?: number | null;
  ownerId: string;
  turnId?: string | null;
  metrics?: JSX.Element | null;
}) {
  const showTrace = lines.length > 0 && expanded;
  if (!showTrace && !metrics) return null;
  return (
    <div class="msg-activity expanded">
      {metrics}
      {showTrace ? <ActivityTraceList key={ownerId} lines={lines} live={live} now={now} turnId={turnId} /> : null}
    </div>
  );
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

function fmtContextLimit(tokens: number): string {
  if (tokens < 1_000_000) return fmtTok(tokens);
  return (tokens / 1_000_000).toFixed(2).replace(/\.0+$|0+$/, '') + 'M';
}

type UsageProps = {
  ownerId: string; summary: string; records: ConversationTurn['usage']; model: string | null;
  live: boolean; partial: boolean; wallElapsedMs: number | null; modelElapsedMs: number | null; toolElapsedMs: number;
};

function UsageMeta({ summary, ownerId, live }: Pick<UsageProps, 'summary' | 'ownerId' | 'live'>) {
  const expanded = activityMetricsExpanded(ownerId);
  const short = summary || 'Usage details';
  return (
    <button
      type="button"
      class="trace-toggle usage"
      aria-expanded={expanded}
      aria-controls={`turn-usage-${ownerId}`}
      aria-label={`${short}. ${expanded ? 'Hide' : 'Show'} usage details`}
      title={expanded ? 'Hide usage details' : 'Show usage details'}
      onClick={(e) => { e.stopPropagation(); toggleActivityMetrics(ownerId, live); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && expanded) toggleActivityMetrics(ownerId); }}
    >
      <span class={`chevron${expanded ? ' open' : ''}`} aria-hidden="true">{'\u203A'}</span>
      <span class="usage-summary">{short}</span>
    </button>
  );
}

const fmtTokUnit = (n: number) => `${fmtTok(n)} tok`;
const fmtTime = (ms: number | null) => (ms === null ? 'Unavailable' : formatStopwatch(ms));
/** Breakdown rows hide zero but keep Unavailable. */
const shownTime = (ms: number | null) => ms === null || !isZeroTime(ms);

function UsageRow({ label, value, title, kind }: { label: string; value: string; title?: string; kind?: string }) {
  return <span class={`usage-row${kind ? ` usage-row-${kind}` : ''}`} title={title}><span>{label}</span><strong>{value}</strong></span>;
}

function UsageDetails({ ownerId, records, model, live, partial, wallElapsedMs, modelElapsedMs, toolElapsedMs }: Omit<UsageProps, 'summary'>) {
  const reports = records.length ? records : [{ id: 'usage', value: {} }];
  const otherMs = wallElapsedMs !== null && modelElapsedMs !== null
    ? Math.max(0, wallElapsedMs - toolElapsedMs - modelElapsedMs) : null;
  const heading = (index: number) => reports.length > 1 ? <strong class="usage-subheading">Usage report {index + 1}</strong> : null;
  return (
    <div class="usage-details" id={`turn-usage-${ownerId}`} role="group" aria-label="Turn usage details">
      {partial ? <span class="usage-notice">Partial usage report; final totals may be higher.</span> : null}
      <div class="usage-columns">
        <section class="usage-column" aria-label="Timing">
          <UsageRow label="Total" value={fmtTime(wallElapsedMs)} />
          {shownTime(modelElapsedMs) ? <UsageRow label="Model" value={fmtTime(modelElapsedMs)} title="Sum of reported model-call times" kind="model-time" /> : null}
          {shownTime(toolElapsedMs) ? <UsageRow label="Tools" value={fmtTime(toolElapsedMs)} title="Time with at least one tool running" /> : null}
          {shownTime(otherMs) ? <UsageRow label="Other" value={fmtTime(otherMs)}
            title="Total minus model and tool time: queueing, container startup, prompt assembly, history loading, message delivery, etc." /> : null}
        </section>
        <section class="usage-column" aria-label="Tokens">
          {reports.map((record, index) => <div class="usage-report" key={record.id}>
            {heading(index)}
            <UsageTokens u={record.value} live={live} />
          </div>)}
        </section>
        <section class="usage-column" aria-label="Model">
          {reports.map((record, index) => <div class="usage-report" key={record.id}>
            {heading(index)}
            <UsageModel u={record.value} model={model} live={live} partial={partial} />
          </div>)}
        </section>
      </div>
    </div>
  );
}

function UsageContext({ context, partialTokens }: {
  context: KnownContext | null; partialTokens?: number;
}) {
  const contextTokens = context ? context.context_tokens
    : partialTokens !== undefined && Number.isFinite(partialTokens) && partialTokens >= 0 ? partialTokens : undefined;
  if (contextTokens === undefined) return null;
  const detail = `${fmtTokUnit(contextTokens)}${context ? ` \u00b7 ${fmtPct(contextTokens, context.context_window)}` : ''}`;
  return <UsageRow label="Context utilization" value={detail}
    title="Context in use after the latest model call: its whole prompt plus its reply" />;
}

function UsageTokens({ u, live }: { u: Partial<TurnUsage>; live: boolean }) {
  const count = (n: number | undefined) => (n !== undefined ? fmtTokUnit(n) : 'unavailable');
  return <>
    <UsageRow label={live ? 'Processing so far' : 'Turn processing'}
      value={`${count(u.input_tokens)} in \u00b7 ${count(u.output_tokens)} out`} />
    {u.reasoning_tokens ? <UsageRow label="Reasoning" value={fmtTokUnit(u.reasoning_tokens)} /> : null}
    {u.cache_read_tokens ? <UsageRow label="Cache read" value={fmtTokUnit(u.cache_read_tokens)} /> : null}
    {u.cache_write_tokens ? <UsageRow label="Cache write" value={fmtTokUnit(u.cache_write_tokens)} /> : null}
    <UsageContext context={latestContextUsage([u])}
      partialTokens={u.context_window === undefined ? u.context_tokens : undefined} />
  </>;
}

function UsageModel({ u, model, live, partial }: { u: Partial<TurnUsage>; model?: string | null; live: boolean; partial: boolean }) {
  const reportedModel = u.model || model;
  const window = u.context_window !== undefined && Number.isFinite(u.context_window) && u.context_window > 0
    ? u.context_window : null;
  return <>
    {reportedModel ? <span class="usage-row"><span>Model</span><strong title={reportedModel}>{shortModel(reportedModel)}</strong></span> : null}
    {window !== null ? <UsageRow label="Context size" value={`${fmtContextLimit(window)} tok`} /> : null}
    {u.num_turns ? <UsageRow label={live ? 'Model calls so far' : 'Model calls'} value={String(u.num_turns)} /> : null}
    {u.cost_usd ? <UsageRow label={partial ? 'Reported cost' : 'Estimated cost'} value={fmtCost(u.cost_usd)} /> : null}
  </>;
}

function AgentActionLabel({ label, title }: { label: string; title: string }) {
  return <span class="delivery-origin" title={title}>{label}</span>;
}

/** The thread currently open in the log, as the rail knows it. */
function activeThread(): Thread | undefined {
  return threads.value.find((x) => x.threadId === threadId.value);
}

/**
 * Whether this thread can be branched. Shared and agent-shared sessions hold
 * many threads in one session and DM rooms have no thread to cut, so the
 * server rejects both — mirror that here rather than offering an action that
 * always fails.
 */
function canFork(t: Thread | undefined): boolean {
  if (!t || t.kind === 'dm' || t.threadId.startsWith('__dm:')) return false;
  const ct = t.channelType || 'web';
  return ct === 'web' || (t.sessionMode === 'per-thread' && !!t.messagingGroupId);
}

/**
 * Whether the branch action is offered on this message. Drives both the button
 * and the gutter the bubble has to reserve for it, so they can't disagree.
 * A message still streaming has no id yet, so there is nothing to anchor to.
 */
function canForkMessage(m: ChatMessage): boolean {
  return m.direction === 'out' && !!m.id && canFork(activeThread());
}

function ForkButton({ m, isLatest }: { m: ChatMessage; isLatest: boolean }) {
  const [busy, setBusy] = useState(false);
  const t = activeThread();
  if (isLatest || !canForkMessage(m)) return null;
  const anchorId = m.id!;
  const onFork = async (): Promise<void> => {
    if (busy) return;
    const ok = await requestConfirm({
      title: 'Branch from here',
      message: BRANCH_ACTION_EXPLANATION,
      okLabel: 'Branch',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await forkThreadAt(t!, anchorId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class="msg-action-btn msg-fork-btn"
      title="Branch a new thread from this message"
      aria-label="Branch a new thread from this message"
      disabled={busy}
      onClick={onFork}
    ><BranchIcon /></button>
  );
}

function EditMessageButton({ m }: { m: ChatMessage }) {
  const [busy, setBusy] = useState(false);
  const thread = activeThread();
  if (!thread || !canEditMessageInBranch(m)) return null;
  const anchorId = findEditBranchAnchorId(chatMessages.value, m.id!);
  if (anchorId && (!canFork(thread) || !canSend.value)) return null;
  const onEdit = async (): Promise<void> => {
    if (busy) return;
    const ok = await requestConfirm({
      title: 'Edit in a new branch',
      message: editBranchActionExplanation(!!anchorId),
      okLabel: 'Start editing',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await editMessageInBranch(thread, anchorId, m.text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      class="msg-action-btn msg-edit-btn"
      title="Start a new branch and copy this message into the composer for editing"
      aria-label="Start a new branch and copy this message into the composer for editing"
      disabled={busy}
      onClick={() => { onEdit().catch(console.error); }}
    ><EditIcon /></button>
  );
}

/**
 * Divider closing the region a branch inherited from its parent. Everything
 * above it was copied in at fork time — the user saw it in the other thread,
 * and (on the transcript tier) the agent only ever read a summary of it.
 */
function InheritedDivider({ origin }: { origin: ForkOrigin }) {
  const fidelityNote = origin.fidelity === 'native'
    ? 'Copied at the branch point. The agent kept its full context from the original.'
    : 'Copied at the branch point. The agent was given a text summary of it rather than its original context.';
  const suffix = origin.fidelity === 'native' ? '' : ' \u00b7 replayed as a transcript';
  if (origin.deleted) {
    return (
      <div class="msg event fork-divider" title={`${fidelityNote} That thread has since been deleted.`}>
        <span class="fork-divider-glyph" aria-hidden="true">{'\u2442'}</span>
        <span class="fork-divider-text">Inherited from a deleted thread{suffix}</span>
      </div>
    );
  }
  const name = origin.title || 'the original thread';
  return (
    <button
      type="button"
      class="msg event fork-divider event-clickable"
      title={`${fidelityNote} Open "${name}" at the branch point.`}
      onClick={() => openThreadAt(origin.threadId, origin.messageId)}
    >
      <span class="fork-divider-glyph" aria-hidden="true">{'\u2442'}</span>
      <span class="fork-divider-text">Inherited from {name}{suffix}</span>
    </button>
  );
}

/** Divider marking a branch that was taken out of this thread at this message. */
function BranchDivider({ child }: { child: ForkChild }) {
  return (
    <button
      type="button"
      class="msg event fork-divider event-clickable"
      title={`Open "${child.title}", branched from here.`}
      onClick={() => openThreadAt(child.threadId, child.messageId)}
    >
      <span class="fork-divider-glyph" aria-hidden="true">{'\u2442'}</span>
      <span class="fork-divider-text">Branched into {child.title}</span>
    </button>
  );
}

/** Opens another thread in this group scrolled to, and flashing, one message. */
function openThreadAt(targetThreadId: string, messageId: string): void {
  if (!groupId.value) return;
  highlightMessageId.value = messageId;
  openChat(groupId.value, targetThreadId, null).catch(console.error);
}

function MessageText({ text, md }: { text: string; md: string | null }) {
  const mdRef = useRef<HTMLDivElement | null>(null);
  const q = searchQuery.value;
  const gid = groupId.value;
  useLayoutEffect(() => {
    // Reset markdown DOM before re-processing (handles search query changes).
    if (md != null && mdRef.current) mdRef.current.innerHTML = md;
    if (md != null && mdRef.current && gid) {
      rewriteFileLinks(mdRef.current, gid, (entry) => navFile(entry).catch(console.error));
      for (const img of mdRef.current.querySelectorAll<HTMLImageElement>('img[src]')) {
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.setAttribute('aria-label', img.alt ? `View ${img.alt}` : 'View image');
        const openImage = (): void => {
          const src = img.currentSrc || img.src;
          imageViewer.value = { src, alt: img.alt || '', name: imageFileName(src) };
        };
        img.addEventListener('click', openImage);
        img.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openImage();
          }
        });
      }
      // Handle [[msg:id|threadId]] reference link clicks.
      for (const a of mdRef.current.querySelectorAll<HTMLAnchorElement>('a.msg-ref')) {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const tid = a.dataset.threadId;
          const msgId = a.dataset.msgId;
          if (tid && gid) {
            highlightMessageId.value = msgId || null;
            if (threadId.value === tid) {
              setTimeout(() => { highlightMessageId.value = msgId || null; }, 50);
            } else {
              openChat(gid, tid, null).catch(console.error);
            }
          }
        });
      }
    }
    // Highlight search query terms in the rendered message.
    if (q && mdRef.current) highlightTextNodes(mdRef.current, q);
  }, [text, md, q, gid]);
  return md != null
    ? <div class="transcript-copy-content" ref={mdRef} dangerouslySetInnerHTML={{ __html: md }} />
    : <div class="transcript-copy-content" ref={mdRef}>{text || ''}</div>;
}

function Message(
  { m, allowContinue = false, isLatest = false }:
  { m: ChatMessage; allowContinue?: boolean; isLatest?: boolean },
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [continueState, setContinueState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const traceOwner = activityTraceOwner(m);
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
  if (m.card) return <DisplayCardMessage message={m} card={m.card} />;
  const md = renderMarkdown(m.text, groupId.value);
  const isToolDelivery = m.deliveryOrigin === 'send_message' || m.deliveryOrigin === 'send_file';
  const systemNotice = isSystemNotice(m.direction, m.systemGenerated, m.suggestedAction);
  const systemNoticeTone = systemNotice && m.statsTurn?.outcome === 'failed'
    ? ' provenance-error'
    : systemNotice && ['warning', 'stopped', 'interrupted'].includes(m.statsTurn?.outcome ?? '')
      ? ' provenance-warning'
      : '';
  const inputPresentation = m.direction === 'in' && !m.hideInitialQueuedCaption ? inputStatePresentation(m.inputState) : null;
  const submission = m.submission;
  const activity = m.direction === 'out' ? m.activity ?? [] : [];
  const showTechnicalStatus = appearance.value.preferences.showTechnicalStatus;
  const cls = 'msg ' + m.direction + (md != null ? ' markdown' : '') + (isToolDelivery ? ' agent-action' : '')
    + (systemNotice ? ` system-notice${systemNoticeTone}` : '')
    + (inputPresentation ? ` ${inputPresentation.className}` : '') + (isLatest ? ' latest' : '')
    + (revealedMobileMessageActionsId.value === m.id ? ' mobile-actions-visible' : '');
  const singleFile = m.files?.length === 1 ? m.files[0] : null;
  const singleMediaKind = singleFile?.url && !m.text.trim() ? mediaKind(singleFile.filename, singleFile.contentType) : null;
  const isWebChannel = !channelType.value || channelType.value === 'web';
  const hasPendingSend = pendingWebSends.value.some((send) =>
    send.groupId === groupId.value && send.threadId === threadId.value && send.status !== 'failed');
  const suggestedAction = m.suggestedAction ?? (isFutureWorkMessage(m.text) ? 'continue' : undefined);
  const action = suggestedAction ? SUGGESTED_ACTIONS[suggestedAction] : undefined;
  const showContinue = isWebChannel && allowContinue && m.direction === 'out' &&
    !hasPendingSend &&
    !m.files?.length && action != null;
  return (
    <MessageBubble
      class={cls}
      data-msg-id={m.id}
      elementRef={ref}
      reveal={highlightMessageId.value === m.id ? searchQuery.value : undefined}
    >
      {showTechnicalStatus
        ? <TurnTechnicalDetails
            turn={m.direction === 'out' ? m.statsTurn : undefined}
            lines={activity}
            ownerId={traceOwner}
            live={m.turnTraceLive}
          />
        : null}
      {m.direction === 'internal' ? <div class="internal-label">internal</div> : null}
      {m.direction === 'in' && m.author && m.author.userId !== currentUserId.value
        ? <div class="message-author">{m.author.displayName}</div>
        : null}
      <MessageText text={m.text} md={md} />
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
                  title={displayWorkspacePath(f.path)}
                  onClick={() => navFile({ path: f.path!, name: f.filename, size: f.size }).catch(console.error)}
                  key={f.path}
                >{'\uD83D\uDCCE '}{f.filename}</button>
              )
              : f.url
                ? (
                  <button
                    type="button"
                    class="file-chip"
                    title={`Preview ${f.filename}`}
                    onClick={() => { previewAttachment(f).catch(console.error); }}
                    key={f.url}
                  >{'\uD83D\uDCCE '}{f.filename}</button>
                )
              : <span class="file-chip inert" title="Source not in workspace" key={f.filename}>{'\uD83D\uDCCE '}{f.filename}</span>)}
          </div>
        )
        : null}
      {showContinue
        ? (
          <div class="message-actions">
            <button
              type="button"
              class="message-action-btn"
              disabled={continueState !== 'idle' || !canSend.value || !!activeTurn.value}
              onClick={async () => {
                if (continueState !== 'idle') return;
                setContinueState('sending');
                const sent = await sendChat(action!.prompt, null);
                setContinueState(sent ? 'sent' : 'idle');
              }}
            >{
              continueState === 'sent'
                ? 'Sent'
                : continueState === 'sending'
                  ? action!.sendingLabel
                  : action!.label
            }</button>
          </div>
        )
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
      {submission?.status === 'failed' ? <div class="inline-error message-send-error" role="alert">
        <span>Send failed: {submission.error}<br />
          Use Retry to resend this message; Send creates a new one.
        </span>
        <button type="button" class="message-action-btn"
          disabled={!canSend.value || !chatReady.value || composerSendInFlight.value}
          onClick={() => { void retryChatSend(submission.messageId).catch(console.error); }}
        >Retry</button>
      </div> : null}
      {m.ts || m.inputState || activity.length ? <div class="meta turn-info">
        {m.ts && <RelativeTime ts={m.ts} />}
        {inputPresentation ? <span class="input-state-caption" role="status">{inputPresentation.caption}</span> : null}
        {submission?.status === 'sending' && !m.hideInitialQueuedCaption
          ? <span class="input-state-caption" role="status">Sending{'\u2026'}</span> : null}
        {showsMidTurnLabel(m.deliveryOrigin,
          !!conversationState.value?.conversation.turns.some((turn) => turn.id === m.turnId && turn.phase !== 'settled'))
          ? <AgentActionLabel label="mid-turn update" title="Sent during the turn with send_message" />
          : m.deliveryOrigin === 'send_file'
            ? <AgentActionLabel label="file delivery" title="Sent during the turn with send_file" />
            : null}
        <PendingMessageActions message={m} thread={activeThread() ?? null} gid={m.submission ? null : groupId.value}>
          {!m.submission ? <EditMessageButton m={m} /> : null}
          {!m.submission ? <ForkButton m={m} isLatest={isLatest} /> : null}
          <CopyTranscriptButton getContent={() => ref.current?.querySelector<HTMLElement>('.transcript-copy-content') ?? null} />
        </PendingMessageActions>
      </div> : null}
    </MessageBubble>
  );
}

function DisplayCardMessage({ message, card }: { message: ChatMessage; card: DisplayCard }) {
  const traceOwner = activityTraceOwner(message);
  const activity = message.activity ?? [];
  const showTechnicalStatus = appearance.value.preferences.showTechnicalStatus;
  return (
    <MessageBubble class="msg out display-card agent-action" data-msg-id={message.id}
      reveal={highlightMessageId.value === message.id ? searchQuery.value : undefined}>
      {showTechnicalStatus
        ? <TurnTechnicalDetails turn={message.statsTurn} lines={activity}
            ownerId={traceOwner} live={message.turnTraceLive} />
        : null}
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
      {message.reactions?.length ? (
        <div class="reactions">
          {message.reactions.map((reaction, index) => (
            <span class="reaction-chip" key={index} title={`Reacted ${reaction.emoji}`}>{reaction.emoji}</span>
          ))}
        </div>
      ) : null}
      {message.ts || activity.length ? <div class="meta turn-info">
        {message.ts ? <RelativeTime ts={message.ts} /> : null}
        <AgentActionLabel label="card" title="Sent with send_card" />
      </div> : null}
    </MessageBubble>
  );
}

interface ThoughtsGroup { kind: 'thoughts'; thoughts: ChatMessage[]; answer: ChatMessage }
interface SingleGroup { kind: 'single'; m: ChatMessage }
interface EventsGroup { kind: 'events'; events: ChatMessage[] }
type MsgGroup = ThoughtsGroup | SingleGroup | EventsGroup
  | { kind: 'starting'; row: Extract<TranscriptRow, { kind: 'starting' }> }
  | { kind: 'turn'; row: Extract<TranscriptRow, { kind: 'turn' }> }
  | { kind: 'question-answer'; row: Extract<TranscriptRow, { kind: 'question-answer' }> };

function messageKey(message: ChatMessage): string {
  return message.id || `${message.direction}:${message.ts}:${message.text}`;
}

function groupKey(group: MsgGroup, responseTurnId: string | null): string {
  if (group.kind === 'starting' || (group.kind === 'turn' && group.row.status &&
    group.row.turn.phase !== 'settled' && group.row.turn.id === responseTurnId))
    return 'response:active';
  if (group.kind === 'turn') return `turn:${group.row.turn.id}`;
  if (group.kind === 'question-answer') return `question-answer:${group.row.answer.id}`;
  if (group.kind === 'thoughts') return `thoughts:${messageKey(group.answer)}`;
  if (group.kind === 'events') return `events:${messageKey(group.events[0]!)}`;
  return `single:${messageKey(group.m)}`;
}

function groupContains(group: MsgGroup, messageId: string): boolean {
  if (group.kind === 'turn' || group.kind === 'starting') return false;
  if (group.kind === 'question-answer') return group.row.answer.id === messageId;
  if (group.kind === 'thoughts') {
    return group.answer.id === messageId || group.thoughts.some((t) => t.id === messageId);
  }
  if (group.kind === 'events') return group.events.some((e) => e.id === messageId);
  return group.m.id === messageId;
}

function groupMessages(list: TranscriptRow[]): MsgGroup[] {
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
  for (const row of list) {
    if (row.kind !== 'message') {
      flushEvents();
      for (const message of pendingMsgs) out.push({ kind: 'single', m: message });
      pendingMsgs = [];
      if (row.kind === 'starting') out.push({ kind: 'starting', row });
      else if (row.kind === 'turn') out.push({ kind: 'turn', row });
      else out.push({ kind: 'question-answer', row });
      continue;
    }
    const m = row.message;
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

/** Collapsed run of consecutive task-run events. */
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
  const failed = events.filter((event) => event.event?.status === 'failed' || event.event?.status === 'timed_out').length;
  if (open) {
    return (
      <div class="events-group open">
        <button type="button" class="events-collapse" onClick={() => setOpen(false)} title="Collapse runs">
          <span class="event-icon" aria-hidden="true">{'\u23F0'}</span>
          <span>{n}{' task attempts'}{failed ? ` \u00b7 ${failed} failed` : ''}{multi ? ` \u00b7 ${taskCount} tasks` : ''}{' \u00b7 hide'}</span>
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
          ? `${taskCount} tasks attempted ${n}\u00d7${failed ? ` \u00b7 ${failed} failed` : ''}`
          : `Task attempted ${n}\u00d7${failed ? ` \u00b7 ${failed} failed` : ''}`}
      </span>
      <span class="event-meta">last&nbsp;<RelativeTime ts={last.ts} /></span>
    </button>
  );
}

function ThoughtGroup({
  thoughts,
  answer,
  allowContinue,
  isLatest,
}: {
  thoughts: ChatMessage[];
  answer: ChatMessage;
  allowContinue: boolean;
  isLatest: boolean;
}) {
  const [showThoughts, setShowThoughts] = useState(false);
  const n = thoughts.length;
  const label = showThoughts ? 'answer' : (n > 1 ? `thoughts (${n})` : 'thoughts');
  const title = showThoughts ? 'Show final answer' : 'Show agent thoughts leading to this answer';
  return (
    <div class={'thought-group' + (showThoughts ? ' showing-thoughts' : ' showing-answer')}>
      {showThoughts
        ? thoughts.map((t) => <Message key={messageKey(t)} m={t} />)
        : <Message m={answer} allowContinue={allowContinue} isLatest={isLatest} />}
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
      <div class="approvals-list">
        {list.map((a) => (
          <div class="approval-row" key={a.approvalId}>
            <div class="approval-text">
              <div class="approval-title">{a.title || a.action}</div>
              {a.packages ? (
                <div class="approval-packages">
                  {(['apt', 'npm', 'pip'] as const).map((manager) =>
                    a.packages![manager].length > 0 ? (
                      <div class="approval-package-list" key={manager}>
                        <span class="approval-package-manager">{manager}</span>
                        <span>{a.packages![manager].join(', ')}</span>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : null}
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

function turnUsage(turn: ConversationTurn, ownerId: string, now: number): UsageProps | null {
  const view = turnRowView(turn, now);
  if (!hasTurnStats(turn, view)) return null;
  const live = turn.phase !== 'settled';
  const records = view.usage;
  const usage = records.map(record => record.value);
  return {
    ownerId, records, model: view.model,
    summary: technicalSummary({ elapsedMs: live ? null : view.elapsedMs, usage }),
    wallElapsedMs: view.elapsedMs, modelElapsedMs: view.modelCallMs, toolElapsedMs: view.toolCallMs, live,
    partial: turn.metadata.status === 'partial',
  };
}

function TurnTechnicalInfo({
  usage, count, hasOutcome = false, expanded, onToggle,
}: {
  usage: UsageProps | null; count: number; hasOutcome?: boolean; expanded: boolean; onToggle: () => void;
}) {
  if (!usage && !count && !hasOutcome) return null;
  return (
    <div class="meta turn-tech-info" role="group" aria-label="Technical information">
      <ActivityTraceToggle count={count} hasOutcome={hasOutcome} expanded={expanded} onToggle={onToggle} />
      {usage ? <UsageMeta summary={usage.summary} ownerId={usage.ownerId} live={usage.live} /> : null}
    </div>
  );
}

function TurnTechnicalDetails({
  turn, lines, ownerId, live = false, now = null,
}: {
  turn?: ConversationTurn;
  lines: ActivityLine[];
  ownerId: string;
  live?: boolean;
  now?: number | null;
}) {
  const expanded = activityTraceExpanded(ownerId);
  const metricsExpanded = activityMetricsExpanded(ownerId);
  const usage = turn ? turnUsage(turn, ownerId, now ?? Date.now()) : null;
  const count = activityStepCount(lines);
  const hasOutcome = lines.some((line) => isOutcomeTraceStep(parseStep(line.text)));
  if (!lines.length && !usage) return null;
  if (!turn && !count && !hasOutcome && !expanded) return null;
  return (
    <div class="turn-technical-details">
      <TurnTechnicalInfo usage={usage} count={count} hasOutcome={hasOutcome}
        expanded={expanded} onToggle={() => toggleActivityTrace(ownerId, live)} />
      <ActivityTracePanel lines={lines} expanded={expanded} live={live} now={now}
        ownerId={ownerId} turnId={live && turn ? turn.id : null}
        metrics={metricsExpanded && usage ? <UsageDetails {...usage} /> : null} />
    </div>
  );
}

/** The turn's Total, on the same clock as the usage summary. */
function TurnElapsed({ ms, live }: { ms: number; live: boolean }) {
  return (
    <span class={`turn-elapsed${live ? ' live' : ''}`}
      role={live ? 'timer' : undefined} aria-live={live ? 'off' : undefined}
      aria-label="Elapsed response time"
      title="Response time, including tools and waiting for replies">
      {formatStopwatch(ms)}
    </span>
  );
}

function startingResponsePresentation(submission: PendingWebSend, now: number) {
  const ownerId = submissionTraceOwner(submission.messageId);
  const submittedAt = Date.parse(submission.timestamp);
  return {
    ownerId, status: true, busy: true, traceLive: true, traceNow: null,
    attributes: { 'data-response-start': ownerId },
    technicalTurn: undefined,
    stopControl: <span class="msg-inline-actions turn-stop-inline"><ActiveTurnStopButton turnId={null} /></span>,
    elapsedControl: <TurnElapsed ms={Number.isFinite(submittedAt) ? Math.max(0, now - submittedAt) : 0} live />,
    tone: '',
    activity: { headline: { action: QUEUED_TEXT }, repetitions: 1, notice: false, error: false },
    // A real (counted) entry, so the trace exists from the moment of sending.
    // Pending: queueing has no CPU chip; the turn total covers it.
    lines: [{ ts: Number.isFinite(submittedAt) ? String(submittedAt) : '', text: JSON.stringify({
      kind: 'notification', id: `ui:start:${submission.messageId}`,
      text: QUEUED_TEXT, status: 'pending',
    }) }],
  };
}

function turnResponsePresentation(
  { turn, activity: lines, status, traceOwner: ownerId }: Extract<TranscriptRow, { kind: 'turn' }>,
  now: number,
) {
  const stop = stopRequest.value?.turnId === turn.id ? stopRequest.value : null;
  const settled = turn.phase === 'settled';
  const live = status && !settled;
  const activity = live ? liveTurnActivity(turn, lines, turnConnected.value, stop) : null;
  const elapsedMs = live ? turnRowView(turn, now).elapsedMs : null;
  const tone = stop?.error || (settled && turn.outcome === 'failed')
    ? ' provenance-error'
    : (settled && ['warning', 'stopped', 'interrupted'].includes(turn.outcome)) || (live && !turnConnected.value)
      ? ' provenance-warning'
      : '';
  return {
    ownerId, status, busy: live, traceLive: !settled,
    traceNow: turn.endedAt ? Date.parse(turn.endedAt) : now,
    attributes: { 'data-turn-id': status ? turn.id : undefined },
    technicalTurn: status ? turn : undefined,
    stopControl: live
      ? <span class="msg-inline-actions turn-stop-inline"><ActiveTurnStopButton turnId={turn.id} /></span> : null,
    elapsedControl: elapsedMs !== null ? <TurnElapsed ms={elapsedMs} live /> : null,
    tone, activity, lines: activity?.lines ?? lines,
  };
}

/** One stable shell for preparing, live, settled and trace-only response rows. */
function ResponseStatusRow({ source }: {
  source: Extract<TranscriptRow, { kind: 'starting' | 'turn' }>;
}) {
  // Measured from submission, so the wait before the turn starts counts.
  const clock = source.kind === 'turn'
    ? { startedAt: turnRequestedAt(source.turn), live: source.status && source.turn.phase !== 'settled' }
    : { startedAt: Date.parse(source.submission.timestamp), live: true };
  const [now, setNow] = useState(() => Date.now());
  // One clock for the status line and the usage summary: tenths below 10s, then whole seconds.
  const startedAt = clock.startedAt;
  const tick = Number.isFinite(startedAt) && now - startedAt < 10_000 ? 100 : 1000;
  useEffect(() => {
    if (!clock.live) return;
    const timer = window.setTimeout(() => setNow(Date.now()), tick);
    return () => window.clearTimeout(timer);
  }, [now, tick, clock.live]);
  useEffect(() => setNow(Date.now()), [clock.startedAt, clock.live]);
  const presentation = source.kind === 'starting'
    ? startingResponsePresentation(source.submission, now)
    : turnResponsePresentation(source, now);
  const { ownerId, status, busy, lines, activity } = presentation;
  const expanded = activityTraceExpanded(ownerId);
  const showTechnicalStatus = appearance.value.preferences.showTechnicalStatus;
  const headline = activity?.headline;
  const repetitions = activity?.repetitions ?? 1;
  if (!lines.length && !status) return null;
  if (!status && !showTechnicalStatus) return null;
  const hasTechnicalInformation = showTechnicalStatus && (lines.length > 0 ||
    (!!presentation.technicalTurn && hasTurnStats(presentation.technicalTurn, turnRowView(presentation.technicalTurn, now))));
  if (!busy && !presentation.stopControl && !hasTechnicalInformation) return null;
  return (
    <div
      class={`typing turn-system${status ? ' turn-status' : ''}${busy ? ' turn-live' : ''}${expanded ? ' expanded' : ''}${presentation.tone}`}
      {...presentation.attributes}
      aria-live={busy ? 'polite' : 'off'}
    >
      {showTechnicalStatus
        ? <TurnTechnicalDetails
            turn={presentation.technicalTurn}
            lines={lines}
            live={presentation.traceLive}
            now={presentation.traceNow}
            ownerId={ownerId}
          />
        : null}
      <div class="typing-summary turn-info">
        {busy ? <div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div> : null}
        {presentation.stopControl}
        {presentation.elapsedControl}
        {headline && activity?.notice
          ? <span class={`hint${activity.error ? ' turn-stop-error' : ''}`}
              role={activity.error ? 'alert' : 'status'} title={headlineSummary(headline, repetitions)}
            ><StepHeadlineContent headline={headline} repetitions={repetitions} /></span>
          : headline && showTechnicalStatus && expanded
          ? null
          : headline && showTechnicalStatus
          ? <button
              type="button"
              class="hint trace-preview"
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide activity' : 'Show latest activity'}
              title={expanded ? 'Hide activity' : 'Show latest activity'}
              onClick={() => toggleActivityTrace(ownerId, presentation.traceLive)}
            ><StepHeadlineContent headline={headline} repetitions={repetitions} /></button>
          : headline ? <span class="hint"><StepHeadlineContent headline={headline} repetitions={repetitions} /></span> : null}
      </div>
    </div>
  );
}

function MessageLog() {
  const ref = useRef<HTMLDivElement | null>(null);
  const appliedHighlightRef = useRef<string | null>(null);
  const prevMsgCountRef = useRef<number>(0);
  const prevLayoutRef = useRef('');
  const prevScrollTickRef = useRef<number>(scrollToBottomTick.value);
  const navigationRef = useRef<ScrollNavigation | null>(null);
  const pendingScrollFrame = useRef<number | null>(null);
  const revealedResponse = useRef<string | null>(completedResponse.value);
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection | null>(null);
  const [newMessageBelow, setNewMessageBelow] = useState(false);
  const [, setDensityReflowTick] = useState(0);
  const highlight = highlightMessageId.value;
  const timeline = submissionPresentation(chatTranscript.value, pendingWebSends.value,
    conversationState.value?.conversation ?? null, groupId.value, threadId.value);
  const { queued } = splitPendingInputs(chatMessages.value);
  const queuedIds = new Set(queued.map((message) => message.id));
  const transcript = timeline.filter((row) => row.kind !== 'message' || !queuedIds.has(row.message.id));
  const layoutKey = JSON.stringify({
    timeline,
    notices: activeTurnNotices(activeTurn.value, turnConnected.value, stopRequest.value),
  });
  const msgCount = timeline.length;
  const activeTurnId = activeTurn.value?.id;
  const scrollTick = scrollToBottomTick.value;
  const activeThreadId = threadId.value;
  const responseId = completedResponse.value;
  const atBottomRef = useRef<boolean>(true);
  const followingBottomRef = useRef<boolean>(true);
  const leavingBottomRef = useRef(false);
  const densityReflowRef = useRef(false);
  const onLogClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if (!isMobile.value || !(event.target instanceof Element)) return;
    const message = event.target.closest<HTMLElement>('.msg[data-msg-id]');
    revealedMobileMessageActionsId.value = message?.dataset.msgId ?? null;
  };

  const measureScroll = (): boolean => {
    const el = ref.current;
    if (!el) return true;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (!nearBottom || el.scrollTop <= 1) leavingBottomRef.current = false;
    const nextAtBottom = nearBottom && !leavingBottomRef.current;
    atBottomRef.current = nextAtBottom;
    if (nextAtBottom) setNewMessageBelow(false);
    return nextAtBottom;
  };

  const scrollToBottom = (smooth = false) => {
    const el = ref.current;
    if (!el) return;
    leavingBottomRef.current = false;
    navigationRef.current?.reset();
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    followingBottomRef.current = true;
    setNewMessageBelow(false);
  };

  const scrollToTop = () => {
    const el = ref.current;
    if (!el) return;
    navigationRef.current?.reset();
    // The first smooth-scroll frames are still inside the bottom-follow zone.
    leavingBottomRef.current = true;
    atBottomRef.current = false;
    followingBottomRef.current = false;
    el.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelScheduledScroll = () => {
    if (pendingScrollFrame.current !== null) cancelAnimationFrame(pendingScrollFrame.current);
    pendingScrollFrame.current = null;
  };
  const scheduleScroll = (callback: () => void) => {
    cancelScheduledScroll();
    pendingScrollFrame.current = requestAnimationFrame(() => {
      pendingScrollFrame.current = null;
      callback();
    });
  };

  // Whether the user is pinned to the bottom of the log. Updated on every
  // scroll so trace-follow can distinguish "following along" from "scrolled
  // up to read history". Programmatic scrollToBottom also fires scroll, which
  // keeps this true while we tail the trace.
  const onLogScroll = () => {
    if (!densityReflowRef.current) followingBottomRef.current = measureScroll();
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const navigation = attachScrollNavigation(el, setScrollDirection, () => {
      leavingBottomRef.current = false;
    });
    navigationRef.current = navigation;
    return () => {
      cancelScheduledScroll();
      navigation.dispose();
      navigationRef.current = null;
    };
  }, [activeThreadId]);

  useLayoutEffect(() => {
    prevMsgCountRef.current = 0;
    prevLayoutRef.current = '';
    atBottomRef.current = true;
    followingBottomRef.current = true;
    leavingBottomRef.current = false;
    setNewMessageBelow(false);
  }, [activeThreadId]);

  useLayoutEffect(() => {
    if (!responseId) {
      revealedResponse.current = null;
      return;
    }
    if (responseId === revealedResponse.current) return;
    const log = ref.current;
    const response = log?.querySelector<HTMLElement>(`.msg[data-msg-id="${CSS.escape(responseId)}"]`);
    if (!log || !response) return;
    revealedResponse.current = responseId;
    cancelScheduledScroll();
    navigationRef.current?.reset();
    leavingBottomRef.current = true;
    atBottomRef.current = false;
    followingBottomRef.current = false;
    response.scrollTop = 0;
    const topClearance = parseFloat(getComputedStyle(log, '::before').height) + parseFloat(getComputedStyle(log).rowGap);
    log.scrollTop = responseScrollTop(log.scrollTop, response.getBoundingClientRect().top,
      log.getBoundingClientRect().top + log.clientTop + topClearance);
    prevMsgCountRef.current = msgCount;
    prevLayoutRef.current = layoutKey;
    setNewMessageBelow(false);
  }, [responseId, activeThreadId, msgCount, layoutKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    return attachDensityReflow(getAppearanceController(), el, {
      followingBottom: () => followingBottomRef.current,
      beforeReflow: () => {
        densityReflowRef.current = true;
        navigationRef.current?.reset();
      },
      afterReflow: () => {
        densityReflowRef.current = false;
        navigationRef.current?.reset();
        setDensityReflowTick((tick) => tick + 1);
      },
    });
  }, [activeThreadId]);

  useEffect(() => {
    const el = ref.current;
    const onResize = (): void => {
      if (densityReflowRef.current) return;
      if (atBottomRef.current) scrollToBottom();
      else measureScroll();
    };
    window.addEventListener('resize', onResize);
    const observer = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (el && observer) observer.observe(el);
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const bubble = Array.from(ref.current?.querySelectorAll('[data-turn-id]') ?? [])
      .find((element) => element.getAttribute('data-turn-id') === activeTurnId);
    if (!bubble || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!densityReflowRef.current && followingBottomRef.current) scrollToBottom();
    });
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [activeTurnId, activeThreadId]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    if (densityReflowRef.current) return;
    // Check for explicit scroll-to-bottom request (e.g. user sent a message)
    if (scrollTick !== prevScrollTickRef.current) {
      prevScrollTickRef.current = scrollTick;
      scrollToBottom();
      scheduleScroll(() => scrollToBottom());
      return;
    }
    if (highlight) {
      // If the highlight changed, reset so we can apply the new one.
      if (appliedHighlightRef.current && appliedHighlightRef.current !== highlight) {
        appliedHighlightRef.current = null;
      }
      const el = ref.current.querySelector(`[data-msg-id="${CSS.escape(highlight)}"]`);
      if (el && (appliedHighlightRef.current !== highlight || prevLayoutRef.current !== layoutKey)) {
        appliedHighlightRef.current = highlight;
        navigationRef.current?.reset();
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 2000);
      }
      // While a highlight is active (pending or applied), don't scroll to bottom.
    } else {
      appliedHighlightRef.current = null;
      // Snapshot before measuring: this render may already include a new row,
      // so the updated DOM can look unpinned even though the user was at bottom.
      const wasAtBottom = atBottomRef.current;
      const currentlyAtBottom = measureScroll();
      const newMessages = msgCount > prevMsgCountRef.current;
      const repositioned = prevLayoutRef.current !== layoutKey;
      // Only follow timeline changes while the viewer is pinned.
      const shouldFollow = wasAtBottom && (newMessages || repositioned);
      if ((newMessages || repositioned) && !currentlyAtBottom) setNewMessageBelow(true);
      if (shouldFollow) {
        scrollToBottom();
        scheduleScroll(() => scrollToBottom());
      } else {
        scheduleScroll(measureScroll);
      }
      prevMsgCountRef.current = msgCount;
    }
    prevLayoutRef.current = layoutKey;
  });
  const list = transcript;
  const groups = groupMessages(list);
  const responseTurnId = list.some((row) => row.kind === 'starting') ? null :
    activeTurnId ?? list.reduce<string | null>((id, row) =>
      row.kind === 'turn' && row.status && row.turn.phase !== 'settled' ? row.turn.id : id, null);
  // The branch point, if this thread is a fork and the anchor is still in
  // view. Messages up to it were inherited; the divider closes that region.
  const thread = activeThread();
  const forkOrigin = thread?.forkedFrom;
  const inheritedUntil = forkOrigin && list.some((row) => row.kind === 'message' && row.message.id === forkOrigin.messageId)
    ? forkOrigin.messageId
    : null;
  // Branches taken out of this thread, keyed by the message each was cut at.
  const branchesAt = new Map<string, ForkChild[]>();
  for (const child of thread?.forkChildren ?? []) {
    const at = branchesAt.get(child.messageId) ?? [];
    at.push(child);
    branchesAt.set(child.messageId, at);
  }
  let latestConversationalMessage: ChatMessage | undefined;
  for (let index = list.length - 1; index >= 0; index--) {
    const row = list[index]!;
    if (row.kind !== 'message') continue;
    const message = row.message;
    if (message.direction !== 'internal' && message.direction !== 'event') {
      latestConversationalMessage = message;
      break;
    }
  }
  return (
    <div class="log-viewport">
      <div class="log scroll-edge-fade" id="chat-log" ref={ref} tabIndex={-1} onClick={onLogClick} onScroll={onLogScroll} onLoadCapture={measureScroll}>
        {chatLoading.value
          ? null
          : !threadId.value
            ? <div class="empty">Pick or start a chat.</div>
            : list.length === 0 && queued.length === 0
              ? <div class="empty">No messages yet.</div>
              : groups.map((g) => {
                  const key = `${threadId.value}:${groupKey(g, responseTurnId)}`;
                  const body = g.kind === 'starting' || g.kind === 'turn'
                    ? <ResponseStatusRow key={key} source={g.row} />
                    : g.kind === 'question-answer'
                      ? <QuestionAnswerBubble key={key} question={g.row.question} answer={g.row.answer} />
                    : g.kind === 'thoughts'
                    ? <ThoughtGroup
                        key={key}
                        thoughts={g.thoughts}
                        answer={g.answer}
                        allowContinue={g.answer === latestConversationalMessage}
                        isLatest={g.answer === latestConversationalMessage}
                      />
                    : g.kind === 'events'
                      ? <EventsGroup key={key} events={g.events} />
                      : <Message
                          key={key}
                          m={g.m}
                          allowContinue={g.m === latestConversationalMessage}
                          isLatest={g.m === latestConversationalMessage}
                        />;
                  const inherited = inheritedUntil !== null && groupContains(g, inheritedUntil);
                  const branches = [...branchesAt].filter(([id]) => groupContains(g, id)).flatMap(([, c]) => c);
                  if (!inherited && branches.length === 0) return body;
                  return (
                    <>
                      {body}
                      {inherited ? <InheritedDivider key={`${key}:fork`} origin={forkOrigin!} /> : null}
                      {branches.map((c) => <BranchDivider key={`${key}:branch:${c.threadId}`} child={c} />)}
                    </>
                  );
                })}
        {!chatLoading.value && queued.map((message) => <Message key={`${threadId.value}:${messageKey(message)}`} m={message} />)}
        <TaskIndicator />
      </div>
      <ScrollNavigationButtons
        direction={scrollDirection}
        newMessageBelow={newMessageBelow}
        onTop={scrollToTop}
        onBottom={() => scrollToBottom(true)}
      />
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
          <span class="path" title={displayWorkspacePath(p)}>{displayWorkspacePath(p)}</span>
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

function currentDockQuestions() {
  return dockQuestions(pendingQuestions.value, conversationState.value?.conversation.messages ?? [], groupId.value, threadId.value);
}

export function Composer() {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [quickCapture, setQuickCapture] = useState(false);
  const isWeb = !channelType.value || channelType.value === 'web';
  const showComposer = canSend.value;
  // Web threads receive over the socket but send over HTTP. Wait for the
  // synchronized socket handshake so the accepted inbound echo cannot race
  // ahead of the active subscription. Non-web sends do not require a socket.
  const wsDown = isWeb && !chatReady.value;
  const hasQuestion = currentDockQuestions().length > 0;
  const composerDisabled = wsDown || hasQuestion;
  const gid = groupId.value;
  const groupName = groups.value.find((group) => group.id === gid)?.name || 'the agent';
  const tid = threadId.value;
  const target = `${gid}:${tid}:composer`;
  const channel = channelType.value;
  const mg = messagingGroupId.value;
  const voiceState = voice.state.value;
  const activeVoice = voiceState.target === target;
  const voiceLocked = activeVoice && (voiceState.phase !== 'error' || voiceState.sending);
  const unavailable = voiceBrowserReason() || (!voiceInput.value.ready ? voiceInput.value.reason || 'Live voice input is not configured.' : '');
  const sendBusyRef = useRef(false);
  const { autosize, multiLine } = useComposerTextarea(inputRef);
  const edit = usePendingComposer(inputRef, autosize);
  const onSubmit = (ev: JSX.TargetedEvent<HTMLFormElement>): void => {
    ev.preventDefault();
    if (hasQuestion) return;
    if (edit.editing) {
      void edit.save();
      return;
    }
    if (composerDisabled) return;
    if (activeVoice) voice.send();
    else doSubmit().catch(console.error);
  };
  const doSubmit = async (): Promise<boolean> => {
    if (sendBusyRef.current || !canSend.value || groupId.value !== gid || threadId.value !== tid
      || channelType.value !== channel || messagingGroupId.value !== mg
      || (isWeb && !chatReady.value)
      || currentDockQuestions().length) return false;
    const text = (inputRef.current?.value || '').trim();
    const files = pending.value.slice();
    if (!text && files.length === 0) return false;
    const pins = pinnedContext.value;
    const prefix = pins.length > 0
      ? '> Context (file browser):\n' + pins.map((p) => `> - \`${p}\``).join('\n') + '\n\n'
      : '';
    const fullText = prefix + text;
    sendBusyRef.current = true;
    composerSendInFlight.value = true;
    try {
      let draftReleased = false;
      const clearSubmittedDraft = () => {
        if (draftReleased) return;
        draftReleased = true;
        if (groupId.value !== gid || threadId.value !== tid || channelType.value !== channel || messagingGroupId.value !== mg) return;
        if (inputRef.current?.value.trim() === text) inputRef.current.value = '';
        autosize();
        for (const file of files) {
          const index = pending.value.indexOf(file);
          if (index >= 0) removePending(index);
        }
        if (pinnedContext.value === pins) clearPinnedContext();
        if (isMobile.value) document.getElementById('chat-log')?.focus({ preventScroll: true });
      };
      const sent = await sendChat(fullText, files, { onSubmitted: clearSubmittedDraft });
      if (!sent || groupId.value !== gid || threadId.value !== tid || channelType.value !== channel || messagingGroupId.value !== mg) return false;
      clearSubmittedDraft();
      return true;
    } finally {
      sendBusyRef.current = false;
      composerSendInFlight.value = false;
    }
  };
  const onAttachClick = (): void => fileRef.current?.click();
  const addFiles = (files: File[]): void => {
    if (currentPendingEditor()) return;
    if (files.length === 0) return;
    addPendingFiles(files, UPLOAD_MAX_FILES, UPLOAD_MAX_FILE_SIZE, UPLOAD_MAX_TOTAL_SIZE);
  };
  const onFileChange = (ev: JSX.TargetedEvent<HTMLInputElement>): void => {
    const files = Array.from(ev.currentTarget.files || []);
    ev.currentTarget.value = '';
    addFiles(files);
  };
  const onPaste = (ev: JSX.TargetedClipboardEvent<HTMLTextAreaElement>): void => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (!items || items.length === 0) return;
    ev.preventDefault();
    addFiles(Array.from(items));
  };

  const attachRecording = isRecording.value;
  const startVoice = (): void => {
    if (currentPendingEditor()) return;
    if (!gid || !tid || unavailable || composerDisabled || isRecording.value) return;
    void warmChat();
    const el = inputRef.current;
    voice.start({
      key: target, groupId: gid, threadId: tid,
      channelType: channel, messagingGroupId: mg,
      getText: () => inputRef.current?.value || '',
      setText: (text) => { if (inputRef.current) inputRef.current.value = text; autosize(); },
      isCurrent: () => groupId.value === gid && threadId.value === tid && channelType.value === channel && messagingGroupId.value === mg,
      send: doSubmit,
    }, el?.selectionStart ?? el?.value.length);
  };
  const startAudioAttachRecording = async (): Promise<void> => {
    if (currentPendingEditor()) return;
    if (isRecording.value || voice.state.value.sending || !['idle', 'error'].includes(voice.state.value.phase)) return;
    const ok = await startRecording();
    if (ok && groupId.value === gid && threadId.value === tid) void warmChat();
    if (!ok) {
      showToast('Microphone unavailable', 'err');
    }
  };
  const stopAttachRecording = (): void => {
    void stopRecording().then((result) => {
      if (!result || groupId.value !== gid || threadId.value !== tid) return;
      const type = result.blob.type.split(';')[0] || 'audio/webm';
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
      addFiles([new File([result.blob], `voice-${Date.now()}.${ext}`, { type })]);
    });
  };

  useEffect(() => {
    const hidden = (): void => { if (document.hidden) cancelRecording(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', cancelRecording);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', cancelRecording);
      cancelRecording();
      if (voice.state.value.target === target) voice.detach();
    };
  }, [target, channel, mg]);
  useEffect(() => {
    if ((hasQuestion || !showComposer) && voice.state.value.target === target) voice.interrupt('Composer is no longer available. Current text has been kept.');
  }, [hasQuestion, showComposer, target]);

  return (
    <>
    <form
      id="chat-form"
      onSubmit={onSubmit}
      style={!hasQuestion && (showComposer || edit.editing) ? '' : 'display:none'}
      class={composerDisabled ? 'ws-down' : ''}
    >
      {edit.editing && <div class="composer-edit-header">
        <span>Editing pending message · text only</span>
        <button type="button" onClick={edit.exit}>Exit edit</button>
      </div>}
      <input type="file" id="chat-file" multiple hidden ref={fileRef} onChange={onFileChange} disabled={edit.editing} />
      {attachRecording && (
        <button
          type="button"
          id="chat-recording-indicator"
          class="recording-stop-btn"
          onClick={stopAttachRecording}
          title="Tap to stop recording"
        >
          <span class="recording-dot"></span>
          <span class="recording-time">{formatElapsedDuration(recordingDuration.value)}</span>
          <span class="recording-stop-label">Stop</span>
        </button>
      )}
        <ComposerInput
          inputRef={inputRef}
          multiLine={multiLine}
          listening={activeVoice && voiceState.phase === 'listening'}
          hidden={attachRecording}
          textarea={{
            id: 'chat-input',
            placeholder: edit.editing ? 'Edit pending message\u2026' : chatReloadRequired.value ? 'Reload to continue\u2026' : wsDown ? 'Reconnecting\u2026' : `Message ${groupName}\u2026`,
            'aria-label': edit.editing ? 'Pending message text' : 'Message',
            onInput: (event) => {
              edit.input(event.currentTarget.value);
              if (!edit.editing && event.currentTarget.value.trim()) void warmChat();
              autosize();
            },
            onPaste,
            autocomplete: 'off',
            disabled: !edit.editing && hasQuestion,
            readOnly: voiceLocked || !!edit.state?.busy || !!edit.state?.unresolved,
          }}
          controls={<ComposerPlusMenu
            disabled={edit.editing || composerDisabled || voiceState.sending || !['idle', 'error'].includes(voiceState.phase)}
            title={composerDisabled ? 'Disconnected' : 'Add\u2026'}
            showRecordAudio={hasGetUserMedia()}
            showQuickCapture={hasGetUserMedia()}
            onUploadFile={onAttachClick}
            onQuickCapture={() => setQuickCapture(true)}
            onRecordAudio={() => { startAudioAttachRecording().catch(console.error); }}
          />}
          voice={{
            target, controller: voice, onStart: startVoice, id: 'chat-mic',
            configured: voiceInput.value.ready, unavailable,
            disabled: edit.editing || composerDisabled || isRecording.value,
          }}
          send={{
            id: 'chat-send',
            label: edit.editing ? edit.state?.busy ? 'Saving…' : edit.state?.retry ? 'Retry save' : 'Save edit' : 'Send',
            busy: edit.state?.busy,
            title: edit.editing ? 'Save edit' : activeVoice && voiceState.phase === 'listening' ? 'Finalize and send' : 'Send',
            disabled: edit.editing ? edit.disabled : composerDisabled || (activeVoice && (voiceState.sending || !['listening', 'error'].includes(voiceState.phase))),
            icon: edit.editing ? '\u2713' : '\u2191',
          }}
        />
      {edit.editing && edit.error && <p class="inline-error pending-input-error" role="alert">{edit.error}</p>}
      {edit.editing && (edit.state?.busy || edit.state?.unresolved) && <p class="composer-edit-notice" role="status">
        This save may still apply. Exit edit only closes the editor; retry checks the same request.
      </p>}
    </form>
    {activeVoice && voiceState.error && <p class="inline-error voice-error" role="alert">
      <span class="inline-error-copy">
        <strong>Dictation stopped</strong>
        <span>{voiceState.error}</span>
        <span class="inline-error-guidance">Your draft was not sent. Review it before sending.</span>
      </span>
    </p>}
    {quickCapture && !hasQuestion ? (
      <QuickCapture
        onCapture={(file) => { setQuickCapture(false); addFiles([file]); }}
        onClose={() => setQuickCapture(false)}
      />
    ) : null}
    </>
  );
}

function ReadonlyBanner() {
  const showComposer = canSend.value;
  if (showComposer || chatReloadRequired.value || !conversationState.value) return <div class="readonly-banner" hidden></div>;
  if (!channelType.value || channelType.value === 'web') {
    return <div class="readonly-banner">Read-only view — sending is unavailable for this thread.</div>;
  }
  const meta = channelMeta(channelType.value);
  return <div class="readonly-banner">Read-only view — reply on {meta.label} to continue this thread.</div>;
}

function Subnotice() {
  const isWeb = !channelType.value || channelType.value === 'web';
  const showComposer = canSend.value;
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
      if (currentPendingEditor()) return;
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
  const reconnectPending = chatStatus.value.startsWith('disconnected \u00b7 reconnecting in ');
  return (
    <section class="chat-main" id="chat-main" ref={ref}>
      <ApprovalsBanner />
      <MessageLog />
      <ImageViewer />
      {reconnectPending
        ? <button class="status reconnect-status" id="chat-status" type="button" onClick={reconnectChatNow}>{chatStatus.value}</button>
        : <div class="status" id="chat-status" hidden={chatReloadRequired.value || chatStatus.value === 'connected'}>{chatStatus.value}</div>}
      <ReadonlyBanner />
      <InputDock />
    </section>
  );
}

export function InputDock() {
  const questions = currentDockQuestions();
  return <div class="input-dock">
    <div class="message-composer" hidden={questions.length > 0}>
      <ContextChip />
      <PendingTray />
      <Subnotice />
      <Composer />
    </div>
    {questions.length > 0 && <div class="question-dock">
      {questions.map((question) => <QuestionPrompt
        key={`${groupId.value}:${threadId.value}:${channelType.value}:${messagingGroupId.value}:${question.questionId}`}
        question={question} />)}
    </div>}
  </div>;
}
