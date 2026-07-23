// Scheduled-tasks management panel. Opened from the ⏰ badge on a thread row
// or the ⏰ button in the chat header. Lists one row per live task series
// (pending/paused) with Pause/Resume, Cancel, and Edit (prompt + schedule)
// actions. All mutations hit the thread's task endpoints, which write
// directly to the session's inbound.db (no container round-trip).
import './Settings.css';
import './TaskPanel.css';
import type { JSX } from 'preact';
import { MobileDialog } from './MobileDialog';
import { useEffect, useState } from 'preact/hooks';
import { taskPanelRequest } from '../state';
import { taskUrl } from '../actions';
import { api, postJson, patchJson } from '../api';
import { showToast } from './Toast';
import { renderMarkdown } from '../utils';
import { highlightCode } from '../highlight';
import type { TaskDetailDto } from '../types';

interface TasksResponse {
  tasks: TaskDetailDto[];
  timezone?: string;
  error?: string;
}

/** Best-effort human phrase for common cron shapes; falls back to the raw
 *  expression so nothing is ever hidden. */
function humanizeCron(expr: string | null): string {
  if (!expr) return 'One-off';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const at = (h: string, m: string): string => {
    const hh = Number(h);
    const mm = Number(m);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return `${h}:${m}`;
    const ampm = hh < 12 ? 'am' : 'pm';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const numeric = (s: string): boolean => /^\d+$/.test(s);
  if (dom === '*' && mon === '*' && dow === '*' && numeric(min) && numeric(hour)) {
    return `Daily at ${at(hour, min)}`;
  }
  if (dom === '*' && mon === '*' && numeric(dow) && numeric(min) && numeric(hour)) {
    return `Weekly on ${DAYS[Number(dow) % 7]} at ${at(hour, min)}`;
  }
  if (mon === '*' && dow === '*' && numeric(dom) && numeric(min) && numeric(hour)) {
    return `Monthly on day ${dom} at ${at(hour, min)}`;
  }
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${min.slice(2)} min`;
  }
  return expr;
}

/** Future-aware relative label (fmtRelative clamps future times to "just now"). */
function fmtNextRun(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 30 * 1000) return 'now';
  const min = Math.round(diff / 60000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `in ${day}d`;
  return new Date(t).toLocaleDateString();
}

/** ISO → `YYYY-MM-DDTHH:mm` in the browser's local zone, for a
 *  <input type="datetime-local">. Falls back to now when the time is missing. */
function toDatetimeLocal(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact, view-only task card for list mode. Clicking the summary opens
 *  the focused single-task view. */
function TaskCard({ task, onOpen }: { task: TaskDetailDto; onOpen: () => void }): JSX.Element {
  return (
    <div class={'task-card' + (task.status === 'paused' ? ' paused' : '')} data-series-id={task.seriesId}>
      <button type="button" class="task-card-summary" onClick={onOpen} title="Open task">
        {task.summary || '(no prompt)'}
      </button>
      <div class="task-meta">
        <span class="task-schedule">{humanizeCron(task.recurrence)}</span>
        {task.nextRunAt ? (
          <span class="task-next" title={new Date(task.nextRunAt).toLocaleString()}>
            next {fmtNextRun(task.nextRunAt)}
          </span>
        ) : null}
        <span class={'task-status ' + task.status}>{task.status}</span>
      </div>
    </div>
  );
}

/**
 * Focused single-task view. The summary is read-only (derived from the
 * prompt); Schedule, Prompt, and Script each have their own inline edit
 * affordance that saves independently and keeps you in this view. Prompt and
 * Script are collapsed by default and render as Markdown / highlighted code
 * respectively. Pause/Resume and Cancel live here too.
 */
function TaskSingle({
  gid,
  tid,
  task,
  onBack,
  onTasks,
}: {
  gid: string;
  tid: string;
  task: TaskDetailDto;
  onBack: () => void;
  onTasks: (tasks: TaskDetailDto[]) => void;
}): JSX.Element {
  const [section, setSection] = useState<null | 'schedule' | 'prompt' | 'script'>(null);
  const [draft, setDraft] = useState('');
  const [schedKind, setSchedKind] = useState<'once' | 'cron'>('cron');
  const [dtDraft, setDtDraft] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function begin(sec: 'schedule' | 'prompt' | 'script', initial: string): void {
    setErr(null);
    setDraft(initial);
    setSection(sec);
  }

  async function save(): Promise<void> {
    if (!section) return;
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (section === 'schedule') {
        if (schedKind === 'once') {
          const ms = Date.parse(dtDraft);
          if (!Number.isFinite(ms)) {
            setErr('Pick a valid date and time.');
            return;
          }
          body.processAfter = new Date(ms).toISOString();
          body.recurrence = null;
        } else {
          body.recurrence = draft.trim() ? draft.trim() : null;
        }
      } else if (section === 'prompt') body.prompt = draft;
      else body.script = draft;
      const r = await patchJson<TasksResponse>(taskUrl(gid, tid, `/${encodeURIComponent(task.seriesId)}`), body);
      if (!r.ok) {
        const e = r.data.error;
        setErr(
          e === 'invalid_recurrence'
            ? 'Invalid cron expression.'
            : e === 'invalid_process_after'
              ? 'Invalid date/time.'
              : e || `HTTP ${r.status}`,
        );
        return;
      }
      onTasks(r.data.tasks || []);
      setSection(null);
      showToast('Task updated', 'ok');
    } finally {
      setBusy(false);
    }
  }

  async function act(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    if (action === 'cancel' && !window.confirm('Cancel this scheduled task? It will stop running.')) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<TasksResponse>(taskUrl(gid, tid, `/${encodeURIComponent(task.seriesId)}/${action}`));
      if (!r.ok) {
        setErr(r.data.error || `HTTP ${r.status}`);
        showToast('Action failed', 'err');
        return;
      }
      onTasks(r.data.tasks || []);
      showToast(action === 'pause' ? 'Task paused' : action === 'resume' ? 'Task resumed' : 'Task cancelled', 'ok');
      if (action === 'cancel') onBack();
    } finally {
      setBusy(false);
    }
  }

  // Nudge the next run to "now" by rewriting process_after. Not truly instant:
  // the host sweep polls for due tasks roughly once a minute (see the info
  // popover). For a recurring series this fires one extra run; the normal
  // cadence resumes because the next occurrence is recomputed from the cron.
  async function runNow(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await patchJson<TasksResponse>(
        taskUrl(gid, tid, `/${encodeURIComponent(task.seriesId)}`),
        { processAfter: new Date().toISOString() },
      );
      if (!r.ok) {
        setErr(r.data.error || `HTTP ${r.status}`);
        showToast('Run now failed', 'err');
        return;
      }
      onTasks(r.data.tasks || []);
      showToast('Queued to run shortly', 'ok');
    } finally {
      setBusy(false);
    }
  }

  const promptHtml = renderMarkdown(task.prompt);
  const hi = task.script ? highlightCode(task.script, 'script.sh') : null;
  const lockOther = (sec: string): boolean => busy || (section !== null && section !== sec);

  return (
    <div class="task-single">
      <div class="task-single-head">
        <button type="button" class="task-back" onClick={onBack}>{'\u2039'} Tasks</button>
        <span class={'task-status ' + task.status}>{task.status}</span>
      </div>

      {err ? <div class="settings-status err">{err}</div> : null}

      <div class="task-single-summary">{task.summary || '(no prompt)'}</div>

      {/* Schedule — always visible */}
      <div class="task-sec">
        <div class="task-sec-head">
          <span class="task-sec-title">Schedule</span>
          {section === 'schedule' ? null : (
            <button
              type="button"
              class="task-sec-edit"
              disabled={lockOther('schedule')}
              onClick={() => {
                setErr(null);
                setSchedKind(task.recurrence ? 'cron' : 'once');
                setDraft(task.recurrence || '');
                setDtDraft(toDatetimeLocal(task.nextRunAt));
                setSection('schedule');
              }}
            >
              Edit
            </button>
          )}
        </div>
        {section === 'schedule' ? (
          <div class="task-sec-edit-body">
            <div class="task-sched-kind">
              <label>
                <input
                  type="radio"
                  name="task-sched-kind"
                  checked={schedKind === 'once'}
                  onChange={() => setSchedKind('once')}
                />
                {' '}One-time
              </label>
              <label>
                <input
                  type="radio"
                  name="task-sched-kind"
                  checked={schedKind === 'cron'}
                  onChange={() => setSchedKind('cron')}
                />
                {' '}Recurring
              </label>
            </div>
            {schedKind === 'once' ? (
              <input
                type="datetime-local"
                value={dtDraft}
                onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setDtDraft(e.currentTarget.value)}
              />
            ) : (
              <>
                <input
                  type="text"
                  placeholder="30 10 * * *"
                  value={draft}
                  onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value)}
                />
                <span class="muted task-cron-preview">{humanizeCron(draft.trim() || null)}</span>
              </>
            )}
            <div class="task-actions">
              <button type="button" onClick={save} disabled={busy}>{busy ? 'Saving\u2026' : 'Save'}</button>
              <button type="button" class="ghost" onClick={() => setSection(null)} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : (
          <div class="task-sec-view task-meta">
            <span class="task-schedule">{humanizeCron(task.recurrence)}</span>
            {task.nextRunAt ? (
              <span class="task-next" title={new Date(task.nextRunAt).toLocaleString()}>
                next {fmtNextRun(task.nextRunAt)}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* Prompt — collapsible, Markdown-rendered */}
      <details class="task-sec task-collapsible">
        <summary class="task-sec-title">Prompt</summary>
        {section === 'prompt' ? (
          <div class="task-sec-edit-body">
            <textarea
              rows={6}
              value={draft}
              onInput={(e: JSX.TargetedEvent<HTMLTextAreaElement>) => setDraft(e.currentTarget.value)}
            />
            <div class="task-actions">
              <button type="button" onClick={save} disabled={busy || !draft.trim()}>{busy ? 'Saving\u2026' : 'Save'}</button>
              <button type="button" class="ghost" onClick={() => setSection(null)} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : (
          <div class="task-sec-view">
            {promptHtml ? (
              <div class="markdown-preview" dangerouslySetInnerHTML={{ __html: promptHtml }} />
            ) : (
              <div class="muted">{task.prompt || '(no prompt)'}</div>
            )}
            <button type="button" class="task-sec-edit" disabled={lockOther('prompt')} onClick={() => begin('prompt', task.prompt)}>
              Edit
            </button>
          </div>
        )}
      </details>

      {/* Script — collapsible, syntax-highlighted */}
      <details class="task-sec task-collapsible">
        <summary class="task-sec-title">Script</summary>
        {section === 'script' ? (
          <div class="task-sec-edit-body">
            <textarea
              class="task-mono"
              rows={8}
              spellcheck={false}
              placeholder="#!/usr/bin/env bash"
              value={draft}
              onInput={(e: JSX.TargetedEvent<HTMLTextAreaElement>) => setDraft(e.currentTarget.value)}
            />
            <div class="task-actions">
              <button type="button" onClick={save} disabled={busy}>{busy ? 'Saving\u2026' : 'Save'}</button>
              <button type="button" class="ghost" onClick={() => setSection(null)} disabled={busy}>Cancel</button>
            </div>
          </div>
        ) : (
          <div class="task-sec-view">
            {task.script ? (
              hi ? (
                <pre class="hljs" data-lang={hi.language}>
                  <code dangerouslySetInnerHTML={{ __html: hi.html }} />
                </pre>
              ) : (
                <pre class="hljs">
                  <code>{task.script}</code>
                </pre>
              )
            ) : (
              <div class="muted">No script.</div>
            )}
            <button type="button" class="task-sec-edit" disabled={lockOther('script')} onClick={() => begin('script', task.script)}>
              Edit
            </button>
          </div>
        )}
      </details>

      {/* Lifecycle actions */}
      <div class="task-single-actions">
        <div class="task-run-now">
          <button
            type="button"
            onClick={runNow}
            disabled={busy || section !== null || task.status === 'paused'}
            title={task.status === 'paused' ? 'Resume the task before running it now' : undefined}
          >
            Run now
          </button>
          <button
            type="button"
            class="task-info-btn"
            aria-label="About Run now"
            aria-expanded={infoOpen}
            onClick={() => setInfoOpen((v) => !v)}
          >
            i
          </button>
          {infoOpen ? (
            <>
              <div class="task-info-backdrop" onClick={() => setInfoOpen(false)} />
              <div class="task-info-pop" role="tooltip">
                Not truly instant. The scheduler checks for due tasks about once a
                minute, so it may take up to ~60 seconds for the run to actually
                start.
              </div>
            </>
          ) : null}
        </div>
        {task.status === 'paused' ? (
          <button type="button" onClick={() => act('resume')} disabled={busy || section !== null}>Resume</button>
        ) : (
          <button type="button" class="ghost" onClick={() => act('pause')} disabled={busy || section !== null}>Pause</button>
        )}
        <button type="button" class="ghost danger" onClick={() => act('cancel')} disabled={busy || section !== null}>
          Cancel task
        </button>
      </div>
    </div>
  );
}

export function TaskPanel() {
  const req = taskPanelRequest.value;
  const [tasks, setTasks] = useState<TaskDetailDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'single'>('list');
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!req) return;
    setTasks(null);
    setError(null);
    setMode('list');
    setActiveId(null);
    let cancelled = false;
    (async () => {
      try {
        const data = await api<TasksResponse>(taskUrl(req.gid, req.tid));
        if (cancelled) return;
        const list = data.tasks || [];
        setTasks(list);
        // Deep-link (⏰ pill): open straight into the focused task.
        if (req.focusSeriesId && list.some((t) => t.seriesId === req.focusSeriesId)) {
          setActiveId(req.focusSeriesId);
          setMode('single');
        }
      } catch {
        if (!cancelled) setError('Failed to load tasks.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [req?.gid, req?.tid, req?.focusSeriesId]);

  function close(): void {
    taskPanelRequest.value = null;
  }
  function back(): void {
    setMode('list');
    setActiveId(null);
  }

  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (mode === 'single') back();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, mode]);

  if (!req) return null;
  const { gid, tid } = req;
  const focusMissing = !!req.focusSeriesId && !!tasks && !tasks.some((t) => t.seriesId === req.focusSeriesId);
  const activeTask = mode === 'single' && activeId ? tasks?.find((t) => t.seriesId === activeId) || null : null;

  return (
    <MobileDialog title={`${'\u23F0'} Scheduled tasks`} onClose={close} maxWidth="560px" className="task-panel">
        <div class="settings-body">
          {error ? <div class="settings-status err">{error}</div> : null}
          {tasks === null && !error ? <p class="muted">Loading{'\u2026'}</p> : null}

          {activeTask ? (
            <TaskSingle gid={gid} tid={tid} task={activeTask} onBack={back} onTasks={(ts) => setTasks(ts)} />
          ) : (
            <>
              {focusMissing ? (
                <p class="muted" style="margin-top:0">
                  That task has already completed and is no longer scheduled. Showing the thread's live tasks.
                </p>
              ) : null}
              {tasks !== null && tasks.length === 0 ? (
                <p class="muted" style="margin-top:0">No scheduled tasks in this thread.</p>
              ) : null}
              {tasks?.map((t) => (
                <TaskCard
                  key={t.seriesId}
                  task={t}
                  onOpen={() => {
                    setActiveId(t.seriesId);
                    setMode('single');
                  }}
                />
              ))}
            </>
          )}
        </div>
        <div class="settings-row" style="padding:10px 16px;border-top:1px solid var(--border);justify-content:flex-end">
          <button type="button" onClick={close}>Done</button>
        </div>
    </MobileDialog>
  );
}
