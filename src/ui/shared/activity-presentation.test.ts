import { describe, expect, it } from 'vitest';
import {
  activityChapters,
  chapterEntryHeadline,
  displayStep,
  headlineSummary,
  parseStep,
  stepHeadline,
  stepSummary,
  todoItems,
  traceStatusClass,
  type TraceLine,
  type TraceStep,
} from './activity-presentation.js';

const line = (ordinal: number, step: TraceStep): TraceLine => ({
  ordinal,
  ts: String(1000 + ordinal),
  text: JSON.stringify(step),
});
const tool = (id: string, name: string, status: TraceStep['status'] = 'completed'): TraceStep => ({
  kind: 'tool',
  id,
  tool: name,
  status,
});

describe('activity presentation', () => {
  it('keeps steering injection markers visible as distinct steps between tool chapters', () => {
    const marker = {
      kind: 'notification' as const,
      id: 'steering:first',
      text: 'Steering message injected',
      detail: 'Use the revised approach.\nKeep <literal text> intact.',
    };
    const values = [
      line(0, tool('before', 'bash')),
      line(1, marker),
      line(2, { ...marker, id: 'steering:second' }),
      line(3, tool('after', 'bash')),
    ];
    const chapters = activityChapters(values);
    expect(chapters.map((chapter) => chapter.entries.length)).toEqual([1, 1, 1, 1]);
    expect(chapters.slice(1, 3).map((chapter) => chapter.title)).toEqual([
      'Considered Use the revised approach. Keep <literal text> intact.',
      'Considered Use the revised approach. Keep <literal text> intact.',
    ]);
    expect(displayStep(values[1], true).detail).toBe(marker.detail);
    expect(stepSummary(displayStep(values[1], true))).toBe(
      'Considered Use the revised approach. Keep <literal text> intact.',
    );
    expect(stepHeadline(marker)).toEqual({
      action: 'Considered',
      subject: 'Use the revised approach. Keep <literal text> intact.',
      codeSubject: true,
    });
    expect(chapters.flatMap((chapter) => chapter.entries.map((entry) => entry.line))).toEqual(values);
  });

  it.each([
    ['pending', 'Queued'],
    ['running', 'Running'],
    ['completed', 'Ran'],
    ['error', 'Ran'],
  ] as const)('uses %s execution-phase wording for commands', (status, verb) => {
    expect(stepSummary({ ...tool('a', 'bash', status), detail: 'pnpm test\n--run' })).toBe(`${verb} pnpm test --run`);
  });

  it('labels title changes using the actual title, with an honest legacy fallback', () => {
    const step = tool('a', 'mcp__nanoclaw__set_thread_title');
    expect(stepSummary({ ...step, detail: 'A useful thread title' })).toBe('Set title to A useful thread title');
    expect(stepSummary({ ...step, status: 'running', detail: 'New title' })).toBe('Setting title to New title');
    expect(stepHeadline({ ...step, detail: 'A useful thread title' })).toEqual({
      action: 'Set title to',
      subject: 'A useful thread title',
      codeSubject: true,
    });
    expect(stepSummary(step)).toBe('Set title');
  });

  it.each(['todo', 'todowrite', 'todo_write', 'mcp__nanoclaw__todo'])('specializes %s', (name) => {
    expect(stepSummary(tool('a', name))).toBe('Updated TODO items');
    expect(stepSummary(tool('a', name, 'running'))).toBe('Updating TODO items');
  });

  it('renders recorded TODO statuses, priorities and multiline contents without losing text', () => {
    const step = {
      ...tool('a', 'todowrite'),
      detail:
        'Completed: Inspect source (High priority)\nIn progress: Update UI\nKeep keyboard navigation\nPending: Verify\nCancelled: Old approach\nTask: Legacy task',
    };
    expect(todoItems(step)).toEqual([
      { content: 'Inspect source', status: 'completed', priority: 'High' },
      { content: 'Update UI\nKeep keyboard navigation', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
      { content: 'Old approach', status: 'cancelled' },
      { content: 'Legacy task', status: 'unknown' },
    ]);
    expect(todoItems({ ...step, detail: 'Unstructured legacy detail' })).toBeNull();
    expect(todoItems(tool('missing', 'todo'))).toBeNull();
  });

  it.each([
    ['pending', 'queued'],
    ['running', 'running'],
    ['completed', 'completed'],
    ['error', 'failed'],
    ['interrupted', 'interrupted'],
    ['unknown', 'unknown'],
  ] as const)('gives %s its own status class', (status, name) => {
    expect(traceStatusClass(tool('a', 'bash', status))).toBe(`trace-status-${name}`);
  });

  it('does not claim that an abandoned running historical step succeeded', () => {
    const value = line(0, tool('a', 'bash', 'running'));
    expect(displayStep(value, false).status).toBe('unknown');
    expect(displayStep(value, true).status).toBe('running');
    expect(stepSummary(displayStep(value, false))).toBe('Outcome unknown: bash');
  });

  it('treats legacy tool records without a status as unknown, even in live traces', () => {
    const value = line(0, { kind: 'tool', tool: 'bash' });
    expect(stepSummary(displayStep(value, true))).toBe('Outcome unknown: bash');
    expect(activityChapters([value, line(1, { kind: 'tool', tool: 'bash' })], true)[0].title).toBe('Command · 2 times');
  });

  it('preserves the raw-text fallback for malformed and legacy lines', () => {
    for (const text of [
      'Plain legacy activity',
      'null',
      '[]',
      '{"detail":123}',
      '{"durationMs":-1}',
      '{"kind":["tool"]}',
      '{"status":["completed"]}',
    ]) {
      expect(parseStep(text)).toEqual({});
    }
    expect(parseStep(JSON.stringify(tool('a', 'bash')))).toEqual(tool('a', 'bash'));
  });
});

describe('activity chapters', () => {
  it('formats repetition counts uniformly and omits them for a singleton', () => {
    const headline = { action: 'Used', subject: 'tavily.tavily_search', codeSubject: true };
    expect(headlineSummary(headline)).toBe('Used tavily.tavily_search');
    expect(headlineSummary(headline, 4)).toBe('Used tavily.tavily_search · 4 times');
  });

  it('keeps different commands in their existing group with a generic command summary', () => {
    const values = Array.from({ length: 4 }, (_, index) =>
      line(index, { ...tool(`command-${index}`, 'bash'), detail: `echo different-${index}` }),
    );
    const chapters = activityChapters(values);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].headline).toEqual({ action: 'Ran command' });
    expect(chapters[0].title).toBe('Ran command · 4 times');
    expect(chapters[0].entries.map((entry) => entry.line)).toEqual(values);
  });

  it('keeps different file targets grouped and only code-styles a single recorded path', () => {
    const values = [
      line(0, { ...tool('a', 'read'), detail: 'first.ts' }),
      line(1, { ...tool('b', 'read'), detail: 'second.ts' }),
      line(2, { ...tool('c', 'edit'), detail: 'first.ts' }),
      line(3, { ...tool('d', 'write'), detail: 'first.ts' }),
    ];
    const chapters = activityChapters(values);
    expect(chapters.map((chapter) => chapter.entries.length)).toEqual([2, 2]);
    expect(chapters[0].headline).toEqual({ action: 'Read', subject: '2 files', codeSubject: false });
    expect(chapters[1].headline).toEqual({ action: 'Edited', subject: 'first.ts', codeSubject: true });
    expect(chapters.flatMap((chapter) => chapter.entries.map((entry) => entry.line))).toEqual(values);
  });

  it('renders ordinary grouped tool names as code arguments', () => {
    const chapter = activityChapters([
      line(0, tool('a', 'mcp__Tavily__tavily_search')),
      line(1, tool('b', 'mcp__Tavily__tavily_search')),
    ])[0];
    expect(chapter.headline).toEqual({ action: 'Used', subject: 'tavily.tavily_search', codeSubject: true });
    expect(chapter.title).toBe('Used tavily.tavily_search · 2 times');
  });

  it('uses common recorded arguments generically without splitting groups with differing arguments', () => {
    const values = Array.from({ length: 4 }, (_, index) =>
      line(index, { ...tool(`custom-${index}`, 'custom'), title: 'Prepared resource', detail: 'resource:key' }),
    );
    const same = activityChapters(values);
    expect(same[0].headline).toEqual({ action: 'Prepared resource', subject: 'resource:key', codeSubject: true });
    expect(same[0].title).toBe('Prepared resource resource:key · 4 times');
    const different = activityChapters([
      ...values.slice(0, 3),
      line(3, { ...tool('custom-3', 'custom'), title: 'Prepared resource', detail: 'other:key' }),
    ]);
    expect(different).toHaveLength(1);
    expect(different[0].headline.subject).toBeUndefined();
    expect(different[0].title).toBe('Prepared resource · 4 times');
    expect(different[0].entries.map((entry) => entry.id)).toEqual(same[0].entries.map((entry) => entry.id));
  });

  it('groups only consecutive compatible tools and retains every entry in recorded order', () => {
    const values = [
      line(0, tool('r1', 'Read')),
      line(1, tool('r2', 'read')),
      line(2, tool('b1', 'bash')),
      line(3, tool('r3', 'read')),
      line(4, tool('w1', 'write')),
      line(5, tool('e1', 'edit')),
    ];
    const chapters = activityChapters(values);
    expect(chapters.map((chapter) => chapter.entries.length)).toEqual([2, 1, 1, 2]);
    expect(chapters.flatMap((chapter) => chapter.entries.map((entry) => entry.line))).toEqual(values);
  });

  it.each([
    ['write', 'completed', 'Edited files · 2 times'],
    ['edit', 'running', 'Editing files · 2 times'],
    ['bash', 'completed', 'Ran command · 2 times'],
    ['bash', 'running', 'Running command · 2 times'],
    ['bash', 'unknown', 'Command · 2 times'],
    ['write', 'interrupted', 'File changes · 2 times'],
  ] as const)('uses the latest %s/%s step for chapter wording', (name, status, title) => {
    expect(activityChapters([line(0, tool('first', name)), line(1, tool('last', name, status))], true)[0].title).toBe(
      title,
    );
  });

  it('does not hide earlier failures after a later successful step', () => {
    const chapter = activityChapters([line(0, tool('failed', 'bash', 'error')), line(1, tool('passed', 'bash'))])[0];
    expect(chapter).toMatchObject({ title: 'Ran command · 2 times', status: 'failed', failures: 1 });
    expect(chapter.entries[1].step.status).toBe('completed');
  });

  it('counts distinct recorded file paths instead of claiming every edit touched a different file', () => {
    const same = { ...tool('first', 'write'), detail: 'example.ts' };
    const repeated = { ...tool('second', 'edit'), detail: 'example.ts' };
    expect(activityChapters([line(0, same), line(1, repeated)])[0].title).toBe('Edited example.ts · 2 times');
    expect(
      activityChapters([
        line(0, same),
        line(1, repeated),
        line(2, { kind: 'patch', files: ['example.ts', 'other.ts'] }),
      ])[0].title,
    ).toBe('Edited 2 files · 3 times');
    expect(activityChapters([line(0, same), line(1, tool('patch', 'patch'))])[0].title).toBe('Edited files · 2 times');
  });

  it('names one repeatedly edited file and keeps execution-phase wording', () => {
    const edits = Array.from({ length: 4 }, (_, index) =>
      line(index, { ...tool(`edit-${index}`, index % 2 ? 'write' : 'edit'), detail: '/workspace/agent/file.txt' }),
    );
    expect(activityChapters(edits)[0].title).toBe('Edited /workspace/agent/file.txt · 4 times');
    expect(
      activityChapters(
        edits.map((entry, index) =>
          index === edits.length - 1
            ? line(index, { ...tool(`edit-${index}`, 'edit', 'running'), detail: '/workspace/agent/file.txt' })
            : entry,
        ),
        true,
      )[0].title,
    ).toBe('Editing /workspace/agent/file.txt · 4 times');
  });

  it('removes repeated verbs from child labels and collapsed previews without losing the primary argument', () => {
    expect(chapterEntryHeadline({ ...tool('a', 'bash'), detail: 'pnpm test' })).toEqual({
      action: '',
      subject: 'pnpm test',
      codeSubject: true,
    });
    expect(chapterEntryHeadline({ ...tool('b', 'edit'), detail: 'example.ts' }).subject).toBe('example.ts');
    expect(chapterEntryHeadline({ ...tool('c', 'todo'), detail: 'Completed: Inspect\nPending: Verify' }).action).toBe(
      '2 TODO items',
    );
    expect(chapterEntryHeadline(tool('d', 'mcp__nanoclaw__set_thread_title')).action).toBe('Title not recorded');
    expect(chapterEntryHeadline({ ...tool('d', 'mcp__nanoclaw__set_thread_title'), detail: 'New title' })).toEqual({
      action: '',
      subject: 'New title',
      codeSubject: true,
    });
  });

  it('keeps chapter identity and the selected activity stable across live updates', () => {
    const before = activityChapters([line(0, tool('first', 'bash')), line(1, tool('second', 'bash', 'running'))], true);
    const after = activityChapters(
      [line(0, tool('first', 'bash')), line(1, tool('second', 'bash')), line(2, tool('third', 'bash', 'running'))],
      true,
    );
    expect(before[0].id).toBe(after[0].id);
    expect(before[0].entries[1].id).toBe(after[0].entries[1].id);
  });

  it('retains 50 steps with long commands and mixed statuses', () => {
    const values = Array.from({ length: 50 }, (_, index) =>
      line(index, {
        ...tool(`call-${index}`, index % 5 === 0 ? 'read' : 'bash', index === 27 ? 'error' : 'completed'),
        detail: index === 10 ? 'x'.repeat(2000) : `argument-${index}`,
      }),
    );
    const chapters = activityChapters(values);
    expect(chapters.flatMap((chapter) => chapter.entries.map((entry) => entry.line))).toEqual(values);
    expect(chapters.reduce((sum, chapter) => sum + chapter.failures, 0)).toBe(1);
  });
});
