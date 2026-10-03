export interface TraceStep {
  kind?: 'tool' | 'internal' | 'file' | 'patch' | 'retry' | 'compaction' | 'subtask' | 'notification';
  id?: string;
  tool?: string;
  status?: 'pending' | 'running' | 'completed' | 'error' | 'interrupted' | 'unknown';
  detail?: string;
  title?: string;
  error?: string;
  durationMs?: number;
  text?: string;
  path?: string;
  name?: string;
  files?: string[];
  attempt?: number;
  auto?: boolean;
  agent?: string;
  description?: string;
}

export interface StepHeadline {
  action: string;
  subject?: string;
  codeSubject?: boolean;
}

export type TraceStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'neutral';
export const TRACE_STATUS_LABELS: Record<TraceStatus, string> = {
  queued: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted (outcome unknown)',
  unknown: 'Outcome unknown',
  neutral: 'Activity',
};
export interface TraceLine {
  ts: string;
  text: string;
  ordinal?: number;
}
export interface TraceEntry {
  id: string;
  line: TraceLine;
  step: TraceStep;
}
export interface TraceChapter {
  id: string;
  entries: TraceEntry[];
  title: string;
  status: TraceStatus;
  failures: number;
}
export interface TraceTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'unknown';
  priority?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStep(value: unknown): value is TraceStep {
  if (!isRecord(value)) return false;
  for (const key of ['id', 'tool', 'detail', 'title', 'error', 'text', 'path', 'name', 'agent', 'description']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (
    value.kind !== undefined &&
    (typeof value.kind !== 'string' ||
      !['tool', 'internal', 'file', 'patch', 'retry', 'compaction', 'subtask', 'notification'].includes(value.kind))
  )
    return false;
  if (
    value.status !== undefined &&
    (typeof value.status !== 'string' ||
      !['pending', 'running', 'completed', 'error', 'interrupted', 'unknown'].includes(value.status))
  )
    return false;
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0)
  )
    return false;
  if (value.attempt !== undefined && typeof value.attempt !== 'number') return false;
  if (value.auto !== undefined && typeof value.auto !== 'boolean') return false;
  return (
    value.files === undefined || (Array.isArray(value.files) && value.files.every((file) => typeof file === 'string'))
  );
}

/** Legacy plain-text lines remain visible through the caller's raw-text fallback. */
export function parseStep(text: string): TraceStep {
  try {
    const value: unknown = JSON.parse(text);
    return isStep(value) ? value : {};
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {};
  }
}

export function cleanToolName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool.toLowerCase();
  const [server, ...name] = tool.slice(5).split('__');
  return `${server}.${name.join('.') || server}`.toLowerCase();
}

function toolKind(step: TraceStep): string {
  return (
    cleanToolName(step.tool || '')
      .split('.')
      .at(-1) || ''
  );
}

export function isTodoStep(step: TraceStep): boolean {
  return step.kind === 'tool' && ['todo', 'todowrite', 'todo_write'].includes(toolKind(step));
}

export function isTitleStep(step: TraceStep): boolean {
  return (
    step.kind === 'tool' && ['nanoclaw.set_thread_title', 'set_thread_title'].includes(cleanToolName(step.tool || ''))
  );
}

export function todoItems(step: TraceStep): TraceTodo[] | null {
  if (!isTodoStep(step) || !step.detail) return null;
  const items: TraceTodo[] = [];
  for (const line of step.detail.split('\n')) {
    const match = line.match(/^(Completed|In progress|Pending|Cancelled|Task):\s*(.*)$/i);
    if (!match) {
      if (!items.length) return null;
      items[items.length - 1].content += `\n${line}`;
      continue;
    }
    const status = match[1].toLowerCase();
    const priority = match[2].match(/\s+\(([^()\n]+) priority\)$/i);
    items.push({
      content: priority ? match[2].slice(0, priority.index).trimEnd() : match[2],
      status:
        status === 'completed'
          ? 'completed'
          : status === 'in progress'
            ? 'in_progress'
            : status === 'pending'
              ? 'pending'
              : status === 'cancelled'
                ? 'cancelled'
                : 'unknown',
      ...(priority ? { priority: priority[1] } : {}),
    });
  }
  return items.length ? items : null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const FILE_OP_VERBS: Record<string, { present: string; past: string }> = {
  read: { present: 'Reading', past: 'Read' },
  write: { present: 'Writing', past: 'Wrote' },
  edit: { present: 'Editing', past: 'Edited' },
};
const COMMAND_TOOLS = new Set(['bash', 'shell', 'run', 'run_in_terminal']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'websearch', 'web_search']);

export function stepHeadline(step: TraceStep): StepHeadline {
  switch (step.kind) {
    case 'tool': {
      const tool = toolKind(step);
      if (!step.status || step.status === 'interrupted' || step.status === 'unknown') {
        return {
          action: step.status === 'interrupted' ? 'Interrupted (outcome unknown):' : 'Outcome unknown:',
          subject: [cleanToolName(step.tool || 'tool'), singleLine(step.detail || step.title || '')]
            .filter(Boolean)
            .join(' '),
          codeSubject: true,
        };
      }
      const finished = step.status === 'completed' || step.status === 'error';
      if (isTitleStep(step))
        return {
          action: finished
            ? step.detail
              ? 'Set title to'
              : 'Set title'
            : step.detail
              ? 'Setting title to'
              : 'Setting title',
          ...(step.detail ? { subject: singleLine(step.detail) } : {}),
        };
      if (isTodoStep(step)) return { action: finished ? 'Updated TODO items' : 'Updating TODO items' };
      const fileOp = FILE_OP_VERBS[tool];
      if (fileOp) {
        const target = step.detail || step.title || '';
        return {
          action: finished ? fileOp.past : fileOp.present,
          ...(target ? { subject: singleLine(target), codeSubject: true } : {}),
        };
      }
      if (COMMAND_TOOLS.has(tool))
        return {
          action: step.status === 'pending' ? 'Queued' : finished ? 'Ran' : 'Running',
          subject: singleLine(step.detail || cleanToolName(step.tool || 'command')),
          codeSubject: true,
        };
      if (SEARCH_TOOLS.has(tool) && (step.detail || step.title))
        return {
          action: finished ? 'Searched for' : 'Searching for',
          subject: singleLine(step.detail || step.title || ''),
          codeSubject: true,
        };
      if (step.title)
        return { action: step.title, ...(step.detail ? { subject: singleLine(step.detail), codeSubject: true } : {}) };
      return { action: finished ? 'Used' : 'Using', subject: cleanToolName(step.tool || 'tool'), codeSubject: true };
    }
    case 'internal':
      return { action: 'Internal activity' };
    case 'file':
      return { action: 'Opened', subject: step.name || step.path || 'file', codeSubject: true };
    case 'patch':
      return {
        action: 'Updated',
        subject: step.files?.length === 1 ? step.files[0] : `${step.files?.length || 0} files`,
        codeSubject: step.files?.length === 1,
      };
    case 'retry':
      return { action: 'Retrying', subject: `attempt ${step.attempt ?? 0}` };
    case 'compaction':
      return { action: step.auto ? 'Compacted context automatically' : 'Compacted context' };
    case 'subtask':
      return step.agent
        ? { action: 'Started subtask with', subject: step.agent, codeSubject: true }
        : { action: step.description || 'Started subtask' };
    case 'notification':
      return { action: step.text || 'Notification' };
    default:
      return { action: '' };
  }
}

export function stepSummary(step: TraceStep): string {
  const headline = stepHeadline(step);
  return [headline.action, headline.subject].filter(Boolean).join(' ');
}

export function traceStatus(step: TraceStep): TraceStatus {
  if (step.kind === 'retry') return 'queued';
  if (step.kind !== 'tool') return 'neutral';
  return step.status === 'pending' ? 'queued' : step.status === 'error' ? 'failed' : step.status || 'unknown';
}

export function traceStatusClass(step: TraceStep): string {
  return `trace-status-${traceStatus(step)}`;
}

export function activityLineId(line: TraceLine, index: number): string {
  if (line.ordinal !== undefined) return `activity-${line.ordinal}`;
  const step = parseStep(line.text);
  return step.id ? `${step.kind}:${step.id}` : `activity-${index}`;
}

export function displayStep(line: TraceLine, live: boolean): TraceStep {
  const step = parseStep(line.text);
  return step.kind === 'tool' && (!step.status || (!live && (step.status === 'pending' || step.status === 'running')))
    ? { ...step, status: 'unknown' }
    : step;
}

function chapterCategory(step: TraceStep, index: number): string {
  if (step.kind === 'file' || (step.kind === 'tool' && toolKind(step) === 'read')) return 'read';
  if (step.kind === 'patch' || (step.kind === 'tool' && ['write', 'edit', 'patch'].includes(toolKind(step))))
    return 'change';
  if (step.kind === 'tool' && COMMAND_TOOLS.has(toolKind(step))) return 'commands';
  if (step.kind === 'tool' && SEARCH_TOOLS.has(toolKind(step))) return 'search';
  return step.kind === 'tool' ? `tool:${cleanToolName(step.tool || 'tool')}` : `event:${index}`;
}

export function activityChapters(lines: TraceLine[], live = false): TraceChapter[] {
  const groups: { category: string; entries: TraceEntry[] }[] = [];
  lines.forEach((line, index) => {
    const step = displayStep(line, live);
    const entry = { id: activityLineId(line, index), line, step };
    const category = chapterCategory(step, index);
    const last = groups.at(-1);
    if (last?.category === category) last.entries.push(entry);
    else groups.push({ category, entries: [entry] });
  });
  return groups.map(({ category, entries }) => {
    const latest = entries[entries.length - 1].step;
    const latestStatus = traceStatus(latest);
    const executing = latestStatus === 'running' || latestStatus === 'queued';
    const uncertain = latestStatus === 'unknown' || latestStatus === 'interrupted';
    const titles: Record<string, string> = {
      read: uncertain ? 'File reads' : executing ? 'Reading files' : 'Read files',
      change: uncertain ? 'File changes' : executing ? 'Changing files' : 'Changed files',
      commands: uncertain ? 'Commands' : executing ? 'Running commands' : 'Ran commands',
      search: uncertain ? 'Searches' : executing ? 'Searching' : 'Searched',
    };
    const statuses = entries.map((entry) => traceStatus(entry.step));
    const status =
      (['running', 'queued', 'failed', 'interrupted', 'unknown', 'completed', 'neutral'] as const).find((candidate) =>
        statuses.includes(candidate),
      ) || 'neutral';
    return {
      id: entries[0].id,
      entries,
      title: titles[category] || stepSummary(latest) || 'Activities',
      status,
      failures: statuses.filter((item) => item === 'failed').length,
    };
  });
}
