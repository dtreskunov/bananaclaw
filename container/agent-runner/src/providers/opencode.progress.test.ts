import { describe, expect, it } from 'bun:test';

import { formatProgressFromPart, isEventForSession } from './opencode.js';

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
