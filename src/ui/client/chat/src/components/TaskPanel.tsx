// Scheduled-tasks management panel. Opened from the ⏰ badge on a thread row
// or the ⏰ button in the chat header. Lists one row per live task series
// (pending/paused) with Pause/Resume, Cancel, and Edit (prompt + schedule)
// actions. All mutations hit the thread's task endpoints, which write
// directly to the session's inbound.db (no container round-trip).
import './Settings.css';
import './TaskPanel.css';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { taskPanelRequest } from '../state';
import { taskUrl } from '../actions';
import { api, postJson, patchJson } from '../api';
import { showToast } from './Toast';
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

export function TaskPanel() {
  const req = taskPanelRequest.value;
  const [tasks, setTasks] = useState<TaskDetailDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editCron, setEditCron] = useState('');

  useEffect(() => {
    if (!req) return;
    setTasks(null);
    setError(null);
    setBusyId(null);
    setEditId(null);
    let cancelled = false;
    (async () => {
      try {
        const data = await api<TasksResponse>(taskUrl(req.gid, req.tid));
        if (!cancelled) setTasks(data.tasks || []);
      } catch {
        if (!cancelled) setError('Failed to load tasks.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [req?.gid, req?.tid]);

  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  if (!req) return null;
  const { gid, tid } = req;

  function close(): void {
    taskPanelRequest.value = null;
  }
  function onBackdrop(e: JSX.TargetedMouseEvent<HTMLDivElement>): void {
    if ((e.target as HTMLElement).classList.contains('settings-backdrop')) close();
  }

  async function doAction(seriesId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    if (action === 'cancel' && !window.confirm('Cancel this scheduled task? It will stop running.')) return;
    setBusyId(seriesId);
    setError(null);
    try {
      const r = await postJson<TasksResponse>(taskUrl(gid, tid, `/${encodeURIComponent(seriesId)}/${action}`));
      if (!r.ok) {
        setError(r.data.error || `HTTP ${r.status}`);
        showToast('Action failed', 'err');
        return;
      }
      setTasks(r.data.tasks || []);
      showToast(action === 'pause' ? 'Task paused' : action === 'resume' ? 'Task resumed' : 'Task cancelled', 'ok');
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(t: TaskDetailDto): void {
    setEditId(t.seriesId);
    setEditPrompt(t.prompt);
    setEditCron(t.recurrence || '');
  }

  async function saveEdit(seriesId: string): Promise<void> {
    setBusyId(seriesId);
    setError(null);
    try {
      const body: Record<string, unknown> = { prompt: editPrompt };
      // Empty cron field means "make it a one-off" (recurrence = null).
      body.recurrence = editCron.trim() ? editCron.trim() : null;
      const r = await patchJson<TasksResponse>(taskUrl(gid, tid, `/${encodeURIComponent(seriesId)}`), body);
      if (!r.ok) {
        setError(r.data.error === 'invalid_recurrence' ? 'Invalid cron expression.' : r.data.error || `HTTP ${r.status}`);
        return;
      }
      setTasks(r.data.tasks || []);
      setEditId(null);
      showToast('Task updated', 'ok');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div class="settings-backdrop" onClick={onBackdrop}>
      <div class="settings-modal task-panel" role="dialog" aria-label="Scheduled tasks" style="max-width:560px">
        <header class="settings-head">
          <span class="title">{'\u23F0'} Scheduled tasks</span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={close}>{'\u2715'}</button>
        </header>
        <div class="settings-body">
          {error ? <div class="settings-status err">{error}</div> : null}
          {tasks === null && !error ? <p class="muted">Loading{'\u2026'}</p> : null}
          {tasks !== null && tasks.length === 0 ? (
            <p class="muted" style="margin-top:0">No scheduled tasks in this thread.</p>
          ) : null}
          {tasks?.map((t) => {
            const editing = editId === t.seriesId;
            const busy = busyId === t.seriesId;
            return (
              <div class={'task-row' + (t.status === 'paused' ? ' paused' : '')} key={t.seriesId}>
                {editing ? (
                  <div class="task-edit">
                    <label class="task-field">
                      <span class="task-field-label">Prompt</span>
                      <textarea
                        rows={4}
                        value={editPrompt}
                        onInput={(e: JSX.TargetedEvent<HTMLTextAreaElement>) => setEditPrompt(e.currentTarget.value)}
                      />
                    </label>
                    <label class="task-field">
                      <span class="task-field-label">Schedule (cron, blank = one-off)</span>
                      <input
                        type="text"
                        placeholder="30 10 * * *"
                        value={editCron}
                        onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setEditCron(e.currentTarget.value)}
                      />
                      <span class="muted task-cron-preview">{humanizeCron(editCron.trim() || null)}</span>
                    </label>
                    <div class="task-actions">
                      <button type="button" onClick={() => saveEdit(t.seriesId)} disabled={busy || !editPrompt.trim()}>
                        {busy ? 'Saving\u2026' : 'Save'}
                      </button>
                      <button type="button" class="ghost" onClick={() => setEditId(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div class="task-summary">
                      {t.summary || '(no prompt)'}
                      {t.hasScript ? <span class="task-script-tag" title="Has a pre-check/exec script">script</span> : null}
                    </div>
                    <div class="task-meta">
                      <span class="task-schedule">{humanizeCron(t.recurrence)}</span>
                      {t.nextRunAt ? (
                        <span class="task-next" title={new Date(t.nextRunAt).toLocaleString()}>
                          next {fmtNextRun(t.nextRunAt)}
                        </span>
                      ) : null}
                      <span class={'task-status ' + t.status}>{t.status}</span>
                    </div>
                    <div class="task-actions">
                      {t.status === 'paused' ? (
                        <button type="button" onClick={() => doAction(t.seriesId, 'resume')} disabled={busy}>
                          Resume
                        </button>
                      ) : (
                        <button type="button" class="ghost" onClick={() => doAction(t.seriesId, 'pause')} disabled={busy}>
                          Pause
                        </button>
                      )}
                      <button type="button" class="ghost" onClick={() => startEdit(t)} disabled={busy}>
                        Edit
                      </button>
                      <button type="button" class="ghost danger" onClick={() => doAction(t.seriesId, 'cancel')} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div class="settings-row" style="padding:10px 16px;border-top:1px solid var(--border);justify-content:flex-end">
          <button type="button" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
