import { describe, expect, it } from 'bun:test';

import {
  finalTextFromAssistantMessages,
  finalTextFromParts,
  formatProgressFromPart,
  hasNonEmptyReasoning,
  isEventForSession,
  isRecoverableReasoningOnlyCompletion,
} from './opencode.js';

describe('formatProgressFromPart', () => {
  it('ignores missing, streaming text, snapshots, and private thinking', () => {
    expect(formatProgressFromPart(undefined)).toBeNull();
    expect(formatProgressFromPart({ id: 't', type: 'text', text: 'reply' })).toBeNull();
    expect(formatProgressFromPart({ id: 's', type: 'snapshot' })).toBeNull();
    expect(formatProgressFromPart({ id: 'r', type: 'reasoning', text: 'working', time: { start: 1 } })).toBeNull();
  });

  it('maps identified tool lifecycle fields without output', () => {
    expect(formatProgressFromPart({
      id: 'part-1', callID: 'call-1', type: 'tool', tool: 'bash',
      state: {
        status: 'completed', input: { command: 'echo one\necho two' }, title: 'Run command',
        time: { start: 100, end: 175 },
      },
    })).toEqual({
      kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed',
      detail: 'echo one\necho two', title: 'Run command', durationMs: 75,
    });
  });

  it('maps tool errors but never includes raw output', () => {
    expect(formatProgressFromPart({
      id: 'tool-2', type: 'tool', tool: 'read',
      state: { status: 'error', input: { filePath: '/tmp/a' }, error: 'not found' },
    })).toEqual({
      kind: 'tool', id: 'tool-2', tool: 'read', status: 'error', detail: '/tmp/a', error: 'not found',
    });
  });

  it('preserves todo descriptions, statuses, and priorities as expandable detail', () => {
    expect(formatProgressFromPart({
      id: 'todo-1', type: 'tool', tool: 'todowrite',
      state: {
        status: 'completed',
        title: '2 todos',
        input: { todos: [
          { content: 'Create the sign structure', status: 'in_progress', priority: 'high' },
          { content: 'Render the PDFs', status: 'pending', priority: 'medium' },
        ] },
      },
    })).toEqual({
      kind: 'tool', id: 'todo-1', tool: 'todowrite', status: 'completed', title: '2 todos',
      detail: 'In progress: Create the sign structure (High priority)\nPending: Render the PDFs (Medium priority)',
    });
  });

  it('ignores completed provider reasoning', () => {
    expect(formatProgressFromPart({
      id: 'reason-1', type: 'reasoning', text: '  inspect the state  ', time: { start: 1, end: 2 },
    })).toBeNull();
  });

  it('maps safe file, patch, retry, compaction, and subtask metadata', () => {
    expect(formatProgressFromPart({ id: 'f', type: 'file', source: { path: '/tmp/a.ts' }, filename: 'a.ts', mime: 'text/plain' }))
      .toEqual({ kind: 'file', id: 'f', path: '/tmp/a.ts', name: 'a.ts', mime: 'text/plain' });
    expect(formatProgressFromPart({ id: 'p', type: 'patch', files: ['a.ts', 'b.ts'] }))
      .toEqual({ kind: 'patch', id: 'p', files: ['a.ts', 'b.ts'] });
    expect(formatProgressFromPart({ id: 'x', type: 'retry', attempt: 2, error: { data: { message: 'busy' } } }))
      .toEqual({ kind: 'retry', id: 'x', attempt: 2, error: 'busy' });
    expect(formatProgressFromPart({ id: 'c', type: 'compaction', auto: true }))
      .toEqual({ kind: 'compaction', id: 'c', auto: true });
    expect(formatProgressFromPart({ id: 'q', type: 'subtask', agent: 'explore', description: 'Find callers' }))
      .toEqual({ kind: 'subtask', id: 'q', agent: 'explore', description: 'Find callers' });
  });
});

describe('isEventForSession', () => {
  it('accepts only the active OpenCode session', () => {
    expect(isEventForSession('ses-active', 'ses-active')).toBe(true);
    expect(isEventForSession('ses-stale', 'ses-active')).toBe(false);
    expect(isEventForSession(undefined, 'ses-active')).toBe(false);
  });
});

describe('finalTextFromParts', () => {
  it('preserves all distinct finalized text parts in provider order', () => {
    expect(finalTextFromParts([
      { id: 't1', type: 'text', text: '<message to="web">one</message>' },
      { id: 'tool', type: 'tool', tool: 'bash' },
      { id: 't2', type: 'text', text: '<message to="web">two</message>' },
    ])).toBe(
      '<message to="web">one</message><message to="web">two</message>',
    );
  });

  it('does not include structured reasoning as deliverable text', () => {
    expect(finalTextFromParts([
      { id: 'r1', type: 'reasoning', text: 'private' },
      { id: 't1', type: 'text', text: '<message to="web">public</message>' },
    ])).toBe('<message to="web">public</message>');
  });
});

describe('finalTextFromAssistantMessages', () => {
  it('delivers only the final assistant message after tool-call narration', () => {
    expect(finalTextFromAssistantMessages([
      [{ id: 'progress-1', type: 'text', text: '<message to="web">Looking up the RSVP link.</message>' }],
      [{ id: 'progress-2', type: 'text', text: '<message to="web">Checking the guest list.</message>' }],
      [{ id: 'final', type: 'text', text: 'The RSVP link is https://example.com/rsvp' }],
    ])).toBe('The RSVP link is https://example.com/rsvp');
  });

  it('returns no reply when OpenCode produced no assistant message', () => {
    expect(finalTextFromAssistantMessages([])).toBe('');
  });
});

describe('hasNonEmptyReasoning', () => {
  it('detects an interrupted reasoning-only completion without exposing it as reply text', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'reasoning', text: 'I understand the answer. Next I will update the files.' },
      { type: 'step-finish' },
    ];

    expect(hasNonEmptyReasoning(parts)).toBe(true);
    expect(finalTextFromParts(parts)).toBe('');
  });

  it('ignores empty reasoning and normal text parts', () => {
    expect(hasNonEmptyReasoning([
      { type: 'reasoning', text: '   ' },
      { type: 'text', text: '<message>done</message>' },
    ])).toBe(false);
  });
});

describe('isRecoverableReasoningOnlyCompletion', () => {
  it('recovers only an unknown finish with reasoning but no reply text', () => {
    expect(isRecoverableReasoningOnlyCompletion('', true, 'unknown')).toBe(true);
    expect(isRecoverableReasoningOnlyCompletion('<message>done</message>', true, 'unknown')).toBe(false);
    expect(isRecoverableReasoningOnlyCompletion('', false, 'unknown')).toBe(false);
    expect(isRecoverableReasoningOnlyCompletion('', true, 'length')).toBe(false);
  });
});
