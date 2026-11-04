import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { boundToolResults, finishedToolReceipts, MAX_TOOL_TEXT_BYTES } from './tool-results.js';
import { NativeStore } from './store.js';
import type { NativeContextEntry } from './store.js';

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

function exchange(name = 'write', output: Output = { type: 'text', value: 'File written' }, id = 'original-call'): ModelMessage[] {
  return [
    { role: 'assistant', content: [
      { type: 'text', text: 'Preserved explanation' },
      { type: 'tool-call', toolName: name, toolCallId: id, input: { path: 'report.py', content: 'OLD_CODE '.repeat(4000) } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: name, toolCallId: id, output }] },
  ];
}

function entries(messages: ModelMessage[], finished = true): NativeContextEntry[] {
  return messages.map((message, index) => ({ ref: String(index + 1), finished, message }));
}

it('projects finished successes into retrievable receipts while leaving active history and answers intact', () => {
  const conversation = store.createConversation();
  const first = store.append(conversation, [{ role: 'user', content: 'Original request' }]);
  store.append(conversation, exchange());
  const last = store.append(conversation, [{ role: 'assistant', content: 'Final answer' }]);
  store.finishTurn(conversation, first, last);
  store.append(conversation, [{ role: 'user', content: 'Active request' }]);
  const active = exchange('read');
  store.append(conversation, active);
  const original = store.messages(conversation);
  const project = () => finishedToolReceipts(store.contextEntries(conversation), text => store.archiveResult(text));
  const visible = project();
  expect(JSON.stringify(visible)).toContain('Finished-turn tool receipt');
  expect(JSON.stringify(visible)).toContain('report.py');
  expect(visible).toContainEqual({ role: 'user', content: 'Original request' });
  expect(visible).toContainEqual({ role: 'assistant', content: 'Final answer' });
  expect(visible.slice(-2)).toEqual(active);
  expect(JSON.stringify(visible).match(/OLD_CODE /g)).toHaveLength(4000);
  expect(store.messages(conversation)).toEqual(original);
  const [name] = fs.readdirSync(path.join(root, 'tool-results'));
  expect(JSON.parse(fs.readFileSync(path.join(root, 'tool-results', name), 'utf8'))).toEqual({ type: 'json', value: exchange() });
  expect(project()).toEqual(visible);
  expect(fs.readdirSync(path.join(root, 'tool-results'))).toHaveLength(1);
});

it.each([
  ['write', { type: 'error-text', value: 'failed; outcome unknown' }],
  ['bash', { type: 'json', value: { status: 'unknown', exitCode: null } }],
  ['bash', { type: 'json', value: { status: 'interrupted', exitCode: null } }],
  ['bash', { type: 'text', value: 'legacy shell result without structured status' }],
  ['skill', { type: 'text', value: 'Loaded instructions' }],
  ['tool_search', { type: 'json', value: { loaded: ['mcp__test__tool'] } }],
  ['mcp__nanoclaw__send_email', { type: 'text', value: '{"isError":true}' }],
  ['mcp__external__lookup', { type: 'json', value: { isError: true } }],
  ['view_image', { type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } }] }],
] as Array<[string, Output]>)('retains failed, uncertain, legacy, instruction and media exchanges (%s)', (name, output) => {
  const original = exchange(name, output);
  expect(finishedToolReceipts(entries(original), text => store.archiveResult(text))).toEqual(original);
  expect(fs.existsSync(path.join(root, 'tool-results'))).toBe(false);
});

it('never projects an unfinished turn, partial pair, mixed-status parallel group, or orphan result', () => {
  const original = exchange();
  const archive = (text: string) => store.archiveResult(text);
  expect(finishedToolReceipts(entries(original, false), archive)).toEqual(original);
  expect(finishedToolReceipts(entries(original.slice(0, 1)), archive)).toEqual(original.slice(0, 1));
  expect(finishedToolReceipts(entries(original.slice(1)), archive)).toEqual(original.slice(1));
  const mixed = entries(original);
  mixed[1].finished = false;
  expect(finishedToolReceipts(mixed, archive)).toEqual(original);
  const parallel: ModelMessage[] = [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'a', toolName: 'write', input: { content: 'code'.repeat(1000) } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'write', input: {} },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'a', toolName: 'write', output: { type: 'text', value: 'written' } },
      { type: 'tool-result', toolCallId: 'b', toolName: 'write', output: { type: 'error-text', value: 'failed' } },
    ] },
  ];
  expect(finishedToolReceipts(entries(parallel), archive)).toEqual(parallel);
  expect(fs.existsSync(path.join(root, 'tool-results'))).toBe(false);
});

it('reduces completed-turn payload bytes without a summarizer, without altering the source, and preserves tiny exchanges', () => {
  const original = Array.from({ length: 60 }, (_, index) => exchange('bash', {
    type: 'json', value: { status: 'completed', exitCode: 0, stdout: `result-${index} `.repeat(300), stderr: '', signal: null },
  }, `call-${index}`)).flat();
  const source = JSON.stringify(original);
  const projected = finishedToolReceipts(entries(original), text => store.archiveResult(text));
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(Buffer.byteLength(source) / 10);
  expect(JSON.stringify(original)).toBe(source);
  expect(fs.readdirSync(path.join(root, 'tool-results'))).toHaveLength(60);
  const tiny: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tiny', toolName: 'read', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tiny', toolName: 'read', output: { type: 'text', value: 'ok' } }] },
  ];
  expect(finishedToolReceipts(entries(tiny), text => store.archiveResult(text))).toEqual(tiny);
});

it('archives a complete parallel call/result group together, without orphaning calls or losing answer text', () => {
  const original: ModelMessage[] = [
    { role: 'assistant', content: [
      { type: 'text', text: 'Keep this explanation' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'write', input: { path: 'a', content: 'code'.repeat(1000) } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'read', input: { path: 'b' } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'write', output: { type: 'text', value: 'written' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'read', output: { type: 'text', value: 'data' } }] },
  ];
  const projected = finishedToolReceipts(entries(original), text => store.archiveResult(text));
  expect(projected).toHaveLength(1);
  expect(projected[0].role).toBe('assistant');
  if (!Array.isArray(projected[0].content)) throw new Error('Missing receipt content');
  expect(projected[0].content[0]).toEqual({ type: 'text', text: 'Keep this explanation' });
  expect(JSON.stringify(projected)).toContain('write (a): completed');
  expect(JSON.stringify(projected)).toContain('read (b): completed');
  const [name] = fs.readdirSync(path.join(root, 'tool-results'));
  expect(JSON.parse(fs.readFileSync(path.join(root, 'tool-results', name), 'utf8'))).toEqual({ type: 'json', value: original });
});

it('rebuilds finished-turn receipts and complete retrieval in a database-only native fork', () => {
  const conversation = store.createConversation();
  const first = store.append(conversation, [{ role: 'user', content: 'request' }]);
  store.append(conversation, exchange());
  const last = store.append(conversation, [{ role: 'assistant', content: 'answer' }]);
  store.finishTurn(conversation, first, last);
  finishedToolReceipts(store.contextEntries(conversation), text => store.archiveResult(text));
  const child = store.fork(conversation, last)!;
  expect(store.messages(child)).toEqual(store.messages(conversation));
  store.close();
  const directory = path.join(root, 'fork');
  fs.mkdirSync(directory);
  fs.copyFileSync(path.join(root, 'state.db'), path.join(directory, 'state.db'));
  store = new NativeStore(path.join(directory, 'state.db'));
  const projected = finishedToolReceipts(store.contextEntries(child), text => store.archiveResult(text));
  expect(JSON.stringify(projected)).not.toContain('OLD_CODE ');
  expect(JSON.stringify(projected)).toContain(path.join(directory, 'tool-results'));
  const [filename] = fs.readdirSync(path.join(directory, 'tool-results'));
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'tool-results', filename), 'utf8')))
    .toEqual({ type: 'json', value: exchange() });
  expect(JSON.stringify(store.messages(child))).toContain('OLD_CODE ');
});
