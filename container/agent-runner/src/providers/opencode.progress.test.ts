import { describe, it, expect } from 'bun:test';

import { formatProgressFromPart, isEventForSession } from './opencode.js';
import { ProgressThrottle } from './types.js';
import type { ActivityStep } from './types.js';

const tool = (t: string, detail?: string): ActivityStep =>
  detail === undefined ? { kind: 'tool', tool: t } : { kind: 'tool', tool: t, detail };

describe('formatProgressFromPart', () => {
  const seen = () => new Set<string>();

  it('returns null for missing or unknown parts', () => {
    expect(formatProgressFromPart(undefined, 0, seen())).toBeNull();
    expect(formatProgressFromPart({}, 0, seen())).toBeNull();
    expect(formatProgressFromPart({ type: 'snapshot' }, 0, seen())).toBeNull();
    expect(formatProgressFromPart({ type: 'step-start' }, 0, seen())).toBeNull();
  });

  it('passes the raw tool name and primary argument through unformatted', () => {
    const cases: Array<[string, Record<string, unknown>, ActivityStep]> = [
      ['read', { filePath: '/workspace/agent/foo/bar.html' }, tool('read', '/workspace/agent/foo/bar.html')],
      ['write', { filePath: '/workspace/agent/foo/bar.html' }, tool('write', '/workspace/agent/foo/bar.html')],
      ['edit', { filePath: '/workspace/agent/foo/bar.html' }, tool('edit', '/workspace/agent/foo/bar.html')],
      ['grep', { pattern: 'foo.*bar' }, tool('grep', 'foo.*bar')],
      ['glob', { pattern: '**/*.ts' }, tool('glob', '**/*.ts')],
      // No matching primary-arg key → no detail.
      ['todowrite', {}, tool('todowrite')],
    ];
    for (const [t, input, expected] of cases) {
      expect(formatProgressFromPart({ type: 'tool', tool: t, state: { input } }, 0, seen())).toEqual(expected);
    }
  });

  it('preserves newlines in the tool detail (no single-line clipping)', () => {
    const cmd = 'pnpm exec tsx scripts/very-long-task.ts --flag value\nand newline';
    const out = formatProgressFromPart({ type: 'tool', tool: 'bash', state: { input: { command: cmd } } }, 0, seen());
    expect(out).toEqual(tool('bash', cmd));
    expect(out?.detail).toContain('\n');
  });

  it('passes the raw url through as detail (UI shortens for display)', () => {
    const out = formatProgressFromPart(
      { type: 'tool', tool: 'webfetch', state: { input: { url: 'https://example.com/path?q=1' } } },
      0,
      seen(),
    );
    expect(out).toEqual(tool('webfetch', 'https://example.com/path?q=1'));
  });

  it('passes MCP tool names through raw (UI renders server.name)', () => {
    const out = formatProgressFromPart({ type: 'tool', tool: 'mcp__tavily__search', state: {} }, 0, seen());
    expect(out).toEqual(tool('mcp__tavily__search'));
  });

  it('emits a bare tool step for unknown tools with no primary arg', () => {
    const out = formatProgressFromPart({ type: 'tool', tool: 'mystery', state: {} }, 0, seen());
    expect(out).toEqual(tool('mystery'));
  });

  it('yields a thinking step once per reasoning part id', () => {
    const set = new Set<string>();
    expect(formatProgressFromPart({ type: 'reasoning', id: 'r1' }, 0, set)).toEqual({ kind: 'thinking' });
    expect(formatProgressFromPart({ type: 'reasoning', id: 'r1' }, 0, set)).toBeNull();
    expect(formatProgressFromPart({ type: 'reasoning', id: 'r2' }, 0, set)).toEqual({ kind: 'thinking' });
  });

  it('yields a text step only once textLen >= 500', () => {
    expect(formatProgressFromPart({ type: 'text', messageID: 'm1', text: 'hi' }, 2, seen())).toBeNull();
    expect(formatProgressFromPart({ type: 'text', messageID: 'm1', text: 'x'.repeat(499) }, 499, seen())).toBeNull();
    expect(formatProgressFromPart({ type: 'text', messageID: 'm1', text: 'x'.repeat(500) }, 500, seen())).toEqual({ kind: 'text' });
  });
});

describe('isEventForSession', () => {
  it('accepts only the active OpenCode session', () => {
    expect(isEventForSession('ses-active', 'ses-active')).toBe(true);
    expect(isEventForSession('ses-stale', 'ses-active')).toBe(false);
    expect(isEventForSession(undefined, 'ses-active')).toBe(false);
  });
});

describe('ProgressThrottle', () => {
  const edit = tool('edit', 'a.ts');
  const read = tool('read', 'b.ts');

  it('passes through the first step immediately', () => {
    let now = 1000;
    const t = new ProgressThrottle(1000, () => now);
    expect(t.push(edit)).toEqual([edit]);
  });

  it('suppresses identical steps within the interval', () => {
    let now = 1000;
    const t = new ProgressThrottle(1000, () => now);
    expect(t.push(edit)).toEqual([edit]);
    now = 1500;
    expect(t.push({ ...edit })).toEqual([]);
    now = 2001;
    expect(t.push({ ...edit })).toEqual([edit]);
  });

  it('passes a different step through immediately', () => {
    let now = 1000;
    const t = new ProgressThrottle(1000, () => now);
    expect(t.push(edit)).toEqual([edit]);
    now = 1100;
    expect(t.push(read)).toEqual([read]);
  });

  it('ignores null inputs', () => {
    const t = new ProgressThrottle(1000, () => 1000);
    expect(t.push(null)).toEqual([]);
  });

  it('collapses the argument-less streaming form of a tool call', () => {
    // The detail-less first form is buffered, then superseded by the rich
    // form — only one line is emitted, and it carries the detail.
    const t = new ProgressThrottle(1000, () => 1000);
    expect(t.push(tool('bash'))).toEqual([]);
    expect(t.push(tool('bash', 'ls -la'))).toEqual([tool('bash', 'ls -la')]);
    expect(t.flush()).toEqual([]);
  });

  it('folds repeated full-detail updates for one tool into a single line', () => {
    let now = 1000;
    const t = new ProgressThrottle(1000, () => now);
    expect(t.push(tool('bash'))).toEqual([]);
    expect(t.push(tool('bash', 'ls'))).toEqual([tool('bash', 'ls')]);
    now = 1100;
    expect(t.push(tool('bash', 'ls'))).toEqual([]);
  });

  it('flushes a genuine argument-less tool call when a different step arrives', () => {
    const t = new ProgressThrottle(1000, () => 1000);
    expect(t.push(tool('todowrite'))).toEqual([]);
    // A different tool flushes the buffered bare call, then emits itself.
    expect(t.push(tool('read', 'a.ts'))).toEqual([tool('todowrite'), tool('read', 'a.ts')]);
  });

  it('flushes a trailing argument-less tool call at turn end', () => {
    const t = new ProgressThrottle(1000, () => 1000);
    expect(t.push(tool('todowrite'))).toEqual([]);
    expect(t.flush()).toEqual([tool('todowrite')]);
  });

  it('flushes a buffered tool before a non-tool step', () => {
    const t = new ProgressThrottle(1000, () => 1000);
    expect(t.push(tool('bash'))).toEqual([]);
    expect(t.push({ kind: 'thinking' })).toEqual([tool('bash'), { kind: 'thinking' }]);
  });
});
