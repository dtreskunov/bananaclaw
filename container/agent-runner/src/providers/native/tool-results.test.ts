import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { boundToolResults, MAX_TOOL_TEXT_BYTES } from './tool-results.js';
import { NativeStore } from './store.js';

let root: string;
let store: NativeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-results-'));
  store = new NativeStore(path.join(root, 'state.db'));
});
afterEach(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
type Output = Extract<Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-result' }>['output'];
function project(output: Output) {
  const messages: ModelMessage[] = [{ role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'call', toolName: 'external', output },
  ] }];
  const result = boundToolResults(messages, (complete) => store.archiveResult(complete))[0];
  if (result.role !== 'tool' || result.content[0].type !== 'tool-result') throw new Error('Missing tool result');
  return { messages, output: result.content[0].output };
}

it.each(['text', 'error-text', 'json', 'error-json'] as const)('bounds %s while preserving the complete result and error status', (type) => {
  const text = '\u{1f642}'.repeat(10_000);
  const original: Output = type === 'json' || type === 'error-json'
    ? { type, value: { important: text } } : { type, value: text };
  const result = project(original);
  expect(result.output.type).toBe(type.startsWith('error') ? 'error-text' : 'text');
  if (result.output.type !== 'text' && result.output.type !== 'error-text') throw new Error('Missing preview');
  expect(Buffer.byteLength(result.output.value)).toBeLessThanOrEqual(MAX_TOOL_TEXT_BYTES);
  expect(result.output.value).not.toContain('\uFFFD');
  const files = fs.readdirSync(path.join(root, 'tool-results'));
  expect(files).toHaveLength(1);
  const filename = path.join(root, 'tool-results', files[0]);
  expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual(original);
  expect(result.output.value).toContain(filename);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  expect(result.messages[0]).toMatchObject({ content: [{ output: original }] });
  project(original);
  expect(fs.readdirSync(path.join(root, 'tool-results'))).toHaveLength(1);
});

it('caps aggregate text, preserves media, and leaves small results untouched', () => {
  const file = { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: 'AQID' } };
  const result = project({ type: 'content', value: [
    { type: 'text', text: 'a'.repeat(10_000) }, file, { type: 'text', text: 'b'.repeat(10_000) },
  ] }).output;
  expect(result.type).toBe('content');
  if (result.type !== 'content') throw new Error('Missing content');
  expect(result.value).toContainEqual(file);
  const text = result.value.filter(p => p.type === 'text').map(p => p.text).join('');
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TOOL_TEXT_BYTES);
  const small: Output = { type: 'text', value: 'complete small result' };
  expect(project(small).output).toBe(small);
});

it('surfaces archive-write failures instead of returning an incomplete success', () => {
  fs.writeFileSync(path.join(root, 'tool-results'), 'not a directory');
  expect(() => project({ type: 'text', value: 'x'.repeat(20_000) })).toThrow();
});

it('reconstructs complete private files from a database-only snapshot', () => {
  const original: Output = { type: 'text', value: 'complete result '.repeat(2000) };
  project(original);
  const [name] = fs.readdirSync(path.join(root, 'tool-results'));
  store.close();
  const child = path.join(root, 'fork');
  fs.mkdirSync(child);
  fs.copyFileSync(path.join(root, 'state.db'), path.join(child, 'state.db'));
  store = new NativeStore(path.join(child, 'state.db'));
  expect(JSON.parse(fs.readFileSync(path.join(child, 'tool-results', name), 'utf8'))).toEqual(original);
  expect(fs.statSync(path.join(child, 'tool-results', name)).mode & 0o777).toBe(0o600);
});
