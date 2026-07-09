import { describe, expect, it } from 'bun:test';

import {
  extractThinkText,
  formatProgressFromPart,
  isEventForSession,
  mergeReasoningPart,
  mergeReasoningText,
  reasoningStepsFromParts,
} from './opencode.js';

describe('formatProgressFromPart', () => {
  it('ignores missing, streaming text, snapshots, and unfinished reasoning', () => {
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

  it('emits completed reasoning text', () => {
    expect(formatProgressFromPart({
      id: 'reason-1', type: 'reasoning', text: '  inspect the state  ', time: { start: 1, end: 2 },
    })).toEqual({ kind: 'reasoning', id: 'reason-1', text: 'inspect the state' });
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

describe('mergeReasoningPart', () => {
  it('accumulates deltas when OpenCode keeps returning the initial text fragment', () => {
    const first = mergeReasoningPart(undefined, { id: 'r1', type: 'reasoning', text: 'This is' }, 'This is');
    const second = mergeReasoningPart(first, { id: 'r1', type: 'reasoning', text: 'This is' }, ' the full thought');
    expect(second.text).toBe('This is the full thought');
  });

  it('prefers a newer cumulative text value without duplicating its delta', () => {
    const first = { id: 'r1', type: 'reasoning', text: 'This is' };
    expect(mergeReasoningPart(first, { ...first, text: 'This is complete' }, ' complete').text)
      .toBe('This is complete');
  });
});

describe('think-text reasoning recovery', () => {
  it('extracts the complete thought from an unclosed think block', () => {
    expect(extractThinkText('<think>\nThe user wants me to inspect `package.json`. I need to find it first.'))
      .toBe('The user wants me to inspect `package.json`. I need to find it first.');
  });

  it('stops before a delivery block embedded after the thought', () => {
    expect(extractThinkText('<think>The retry needs wrapping.<message to="web">Answer</message>'))
      .toBe('The retry needs wrapping.');
  });

  it('replaces a truncated structured prefix with the complete think text', () => {
    expect(mergeReasoningText(
      'The user wants me to inspect `',
      'The user wants me to inspect `package.json`. I need to find it first.',
    )).toBe('The user wants me to inspect `package.json`. I need to find it first.');
  });

  it('treats an incomplete opening tag as not-yet-extractable', () => {
    expect(extractThinkText('<thi')).toBeUndefined();
    expect(extractThinkText('<think>')).toBeUndefined();
  });

  it('reconciles a final structured prefix with its complete companion think block', () => {
    expect(reasoningStepsFromParts([
      { id: 'r1', messageID: 'm1', type: 'reasoning', text: 'The user wants me to inspect `' },
      { id: 't1', messageID: 'm1', type: 'text', text: '<think>\nThe user wants me to inspect `package.json`. I need to find it first.<message to="web">Done</message>' },
      { id: 'end', messageID: 'm1', type: 'step-finish' },
    ])).toEqual([{
      kind: 'reasoning', id: 'r1',
      text: 'The user wants me to inspect `package.json`. I need to find it first.',
    }]);
  });
});
