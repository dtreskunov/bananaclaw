import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { jsonSchema, tool } from 'ai';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { resetTurnSendTracking } from '../current-batch.js';
import { formatNativeToolStep, MAX_STEPS, NativeProvider, portableHistory, userMessage } from './native.js';
import * as nativeCatalog from './native/catalog.js';
import * as nativeAudio from './native/audio.js';
import * as nativeTools from './native/tools.js';
import * as nativeAttachments from './native/attachments.js';
import { NativeStore } from './native/store.js';
import { fingerprintToolInput, type ProviderEvent, type TurnUsage } from './types.js';
import { COMPACTION_INSTRUCTIONS } from './native/compaction.js';
import { accumulateCallUsage } from './usage.js';

/** The runner's fold of a turn's per-call reports. */
function turnTotal(events: ProviderEvent[]): TurnUsage | null {
  let total: TurnUsage | null = null;
  for (const event of events) if (event.type === 'usage_call') total = accumulateCallUsage(total, event.data);
  return total;
}

let root: string;
let server: ReturnType<typeof Bun.serve>;
let requests: Array<Record<string, unknown>>;
let requestUrls: string[];
let requestHeaders: Headers[];
let toolMode: boolean;
let anthropicToolMode: boolean;
let externalMcpToolMode: boolean;
/** Each non-summary model request pops one scripted call; text when empty. */
let scriptedToolCalls: Array<[name: string, args: string]>;
let skillToolMode: boolean;
let todoToolMode: boolean;
let rejectAudio: boolean;
let holdModelResponse: boolean;
let releaseModelResponse: (() => void) | undefined;
let modelRequestStarted: (() => void) | undefined;
let slowToolMode: boolean;
/** Texts for successive text-only answers; `hello from stub` once empty. */
let scriptedTexts: string[];
/** Text streamed before each tool call, in the same step. */
let toolCallText: string;
let catalogFetch: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let catalogModels: Record<string, unknown>;
let contextOverflows: number;
let overflowAfterTool: boolean;
let rejectCompaction: boolean;
type StubUsage = { prompt_tokens?: number; completion_tokens?: number };
let scriptedUsage: StubUsage[];
let compactionUsage: StubUsage;
let reasoningOnlyCompactions: number;

const haveAudioTools = ['ffmpeg', 'ffprobe'].every(
  (executable) => spawnSync(executable, ['-version'], { stdio: 'ignore' }).status === 0,
);

function replyTexts(events: ProviderEvent[]): string[][] {
  return events.flatMap((event) => (event.type === 'result' ? [(event.replies ?? []).map((reply) => reply.text)] : []));
}

function requestImages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(requestImages);
  if (!value || typeof value !== 'object') return [];
  if ('type' in value && (value.type === 'image' || value.type === 'image_url')) return [value];
  return Object.values(value).flatMap(requestImages);
}

async function collect(
  provider: NativeProvider,
  continuation?: string,
  files?: Array<{ path: string; mime: string; filename: string }>,
): Promise<ProviderEvent[]> {
  const query = provider.query({ prompt: continuation ? 'follow up' : 'hello', continuation, cwd: root, files });
  query.end();
  const events: ProviderEvent[] = [];
  for await (const event of query.events) events.push(event);
  return events;
}

beforeEach(() => {
  resetTurnSendTracking();
  nativeCatalog.clearNativeCatalogForTest();
  catalogModels = {};
  const realFetch = globalThis.fetch;
  catalogFetch = spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    String(input) === 'https://models.dev/api.json' ? Promise.resolve(Response.json(catalogModels)) : realFetch(input, init));
  root = fs.mkdtempSync(path.join(process.cwd(), '.native-provider-'));
  requests = [];
  requestUrls = [];
  requestHeaders = [];
  toolMode = false;
  anthropicToolMode = false;
  externalMcpToolMode = false;
  scriptedToolCalls = [];
  skillToolMode = false;
  todoToolMode = false;
  rejectAudio = false;
  holdModelResponse = false;
  releaseModelResponse = undefined;
  modelRequestStarted = undefined;
  slowToolMode = false;
  scriptedTexts = [];
  toolCallText = '';
  contextOverflows = 0;
  overflowAfterTool = false;
  rejectCompaction = false;
  scriptedUsage = [];
  compactionUsage = { prompt_tokens: 4, completion_tokens: 3 };
  reasoningOnlyCompactions = 0;
  const { inbound } = initTestSessionDb();
  inbound
    .prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
     VALUES (1, 'web', 'chat-1', NULL)`,
    )
    .run();
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestUrls.push(request.url);
      requestHeaders.push(request.headers);
      requests.push((await request.json()) as Record<string, unknown>);
      const isCompaction = JSON.stringify(requests.at(-1)).includes(COMPACTION_INSTRUCTIONS);
      const modelMessages = requests.at(-1)?.messages;
      const hasCompletedTool = Array.isArray(modelMessages) && modelMessages.some(
        (message: unknown) => !!message && typeof message === 'object' && 'role' in message && (
          message.role === 'tool' || ('content' in message && JSON.stringify(message.content).includes('"tool_result"'))
        ),
      );
      if (isCompaction && rejectCompaction) {
        return Response.json({ error: { message: 'Summary service rejected the request', type: 'invalid_request_error' } }, { status: 400 });
      }
      if (isCompaction && reasoningOnlyCompactions > 0) {
        reasoningOnlyCompactions--;
        const tokens = Number(requests.at(-1)?.max_tokens);
        if (!Number.isInteger(tokens) || tokens < 1) throw new Error('Summarization request is missing its generation limit');
        const body = new URL(request.url).pathname.endsWith('/messages')
          ? [
              'event: message_start',
              'data: {"type":"message_start","message":{"id":"reasoning-only","type":"message","role":"assistant","content":[],"model":"MiniMax-M3.1-Flash-Preview","stop_reason":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
              '',
              'event: content_block_start',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
              '',
              'event: content_block_delta',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Review the completed actions."}}',
              '',
              'event: content_block_stop',
              'data: {"type":"content_block_stop","index":0}',
              '',
              'event: message_delta',
              `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":${tokens},"output_tokens_details":{"thinking_tokens":${tokens}}}}`,
              '',
              'event: message_stop',
              'data: {"type":"message_stop"}',
              '',
              '',
            ].join('\n')
          : [
              'data: {"id":"reasoning-only","object":"chat.completion.chunk","created":1,"model":"MiniMax-M3.1-Flash-Preview","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Review the completed actions."},"finish_reason":null}]}',
              '',
              `data: {"id":"reasoning-only","object":"chat.completion.chunk","created":1,"model":"MiniMax-M3.1-Flash-Preview","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":4,"completion_tokens":${tokens},"completion_tokens_details":{"reasoning_tokens":${tokens}}}}`,
              '',
              'data: [DONE]',
              '',
              '',
            ].join('\n');
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (!isCompaction && contextOverflows > 0 && (!overflowAfterTool || hasCompletedTool)) {
        contextOverflows--;
        return Response.json({ type: 'error', error: { message: 'invalid params, context window exceeds limit (2013)', type: 'invalid_request_error' } }, { status: 400 });
      }
      if (holdModelResponse) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"id":"waiting","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
            releaseModelResponse = () => {
              controller.enqueue(new TextEncoder().encode('data: {"id":"waiting","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"original answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\ndata: [DONE]\n\n'));
              controller.close();
            };
            modelRequestStarted?.();
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (rejectAudio && JSON.stringify(requests.at(-1)?.messages).includes('input_audio')) {
        return Response.json({ error: { message: 'Unsupported audio format', type: 'invalid_request_error' } }, { status: 400 });
      }
      const scripted = isCompaction ? undefined : scriptedToolCalls.shift();
      const customUsage = isCompaction ? compactionUsage : scriptedUsage.shift();
      if (new URL(request.url).pathname.endsWith('/messages')) {
        const requestBody = requests.at(-1)!;
        const hasToolResult = JSON.stringify(requestBody.messages).includes('tool_result');
        const body =
          !isCompaction && (scripted || (anthropicToolMode && !hasToolResult))
            ? [
                'event: message_start',
                `data: {"type":"message_start","message":{"id":"msg_minimax_tool","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${customUsage?.prompt_tokens ?? 4},"output_tokens":0}}}`,
                '',
                'event: content_block_start',
                `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_minimax_${requests.length}","name":"${scripted?.[0] ?? (slowToolMode ? 'bash' : 'mcp__nanoclaw__send_message')}","input":{}}}`,
                '',
                'event: content_block_delta',
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(scripted?.[1] ?? (slowToolMode ? '{"command":"sleep 30"}' : '{"text":"hello from direct tool"}'))}}}`,
                '',
                'event: content_block_stop',
                'data: {"type":"content_block_stop","index":0}',
                '',
                'event: message_delta',
                `data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":${customUsage?.completion_tokens ?? 10}}}`,
                '',
                'event: message_stop',
                'data: {"type":"message_stop"}',
                '',
                '',
              ].join('\n')
            : [
                'event: message_start',
                `data: {"type":"message_start","message":{"id":"msg_minimax","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${customUsage?.prompt_tokens ?? 4},"output_tokens":0,"cache_read_input_tokens":20,"cache_creation_input_tokens":3}}}`,
                '',
                'event: content_block_start',
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                '',
                'event: content_block_delta',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from direct minimax"}}',
                '',
                'event: content_block_stop',
                'data: {"type":"content_block_stop","index":0}',
                '',
                'event: message_delta',
                `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":${customUsage?.completion_tokens ?? 5}}}`,
                '',
                'event: message_stop',
                'data: {"type":"message_stop"}',
                '',
                '',
              ].join('\n');
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      const requestBody = requests.at(-1)!;
      const messages = requestBody.messages as Array<{ role: string }>;
      const toolResultCount = messages.filter((message) => message.role === 'tool').length;
      const shouldCallTool = !isCompaction && (scripted ? true : todoToolMode
        ? toolResultCount < 2
        : (toolMode || externalMcpToolMode || skillToolMode || slowToolMode) && toolResultCount === 0);
      const toolName = scripted ? scripted[0] : slowToolMode ? 'bash' : todoToolMode
        ? toolResultCount === 0
          ? 'todowrite'
          : 'todoread'
        : skillToolMode
          ? 'skill'
          : externalMcpToolMode
            ? 'mcp__Fixture__echo_value'
            : 'mcp__nanoclaw__send_message';
      const toolArguments = scripted ? scripted[1] : slowToolMode ? '{"command":"sleep 30"}' : todoToolMode
        ? toolResultCount === 0
          ? '{"todos":[{"id":"inspect","content":"turn-one-secret","status":"in_progress"}]}'
          : '{}'
        : skillToolMode
          ? '{"name":"local-guide"}'
          : externalMcpToolMode
            ? '{"value":"from-model"}'
            : '{"text":"hello user"}';
      const usage = customUsage ?? (shouldCallTool
        ? { prompt_tokens: 11, completion_tokens: 2 }
        : { prompt_tokens: 4, completion_tokens: 3 });
      const body = shouldCallTool
        ? [
            ...(toolCallText
              ? [
                  `data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(toolCallText)}},"finish_reason":null}]}`,
                  '',
                ]
              : []),
            `data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_${requests.length}","type":"function","function":{"name":"${toolName}","arguments":${JSON.stringify(toolArguments)}}}]},"finish_reason":null}]}`,
            '',
            `data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":${JSON.stringify(usage)}}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n')
        : [
            `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(isCompaction ? 'Earlier work completed; continue pending requests without repeating tools.' : scriptedTexts.shift() ?? 'hello from stub')}},"finish_reason":null}]}`,
            '',
            `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":${JSON.stringify(usage)}}`,
            '',
            'data: [DONE]',
            '',
          ].join('\n');
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  process.env.NATIVE_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.NATIVE_STATE_PATH = path.join(root, 'native-state.db');
});

afterEach(() => {
  catalogFetch.mockRestore();
  nativeCatalog.clearNativeCatalogForTest();
  server.stop(true);
  closeSessionDb();
  delete process.env.NATIVE_BASE_URL;
  delete process.env.NATIVE_PROTOCOL;
  delete process.env.NATIVE_STATE_PATH;
  delete process.env.NATIVE_SHARED_SKILLS_ROOT;
  delete process.env.NATIVE_LOCAL_SKILLS_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NativeProvider', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=';
  const gif = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  function vision(protocol: nativeCatalog.NativeProtocol) {
    process.env.NATIVE_PROTOCOL = protocol;
    catalogModels = { local: { models: {
      'vision-model': { modalities: { input: ['text', 'image'], output: ['text'] } },
    } } };
    return new NativeProvider({ model: 'local/vision-model' });
  }
  function wireImage(protocol: nativeCatalog.NativeProtocol, data = png, mime = 'image/png') {
    return protocol === 'openai-chat'
      ? { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } };
  }

  it.each([
    ['openai-chat', 'pdf', 'view_pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')],
    ['anthropic-messages', 'pdf', 'view_pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')],
    ['openai-chat', 'audio', 'listen_audio', 'audio/mpeg', Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(413)])],
    ['openai-chat', 'audio', 'listen_audio', 'audio/wav', Buffer.from('524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000', 'hex')],
    ['openai-chat', 'video', 'view_video', 'video/mp4', Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex')],
    ['openai-chat', 'video', 'view_video', 'video/webm', Buffer.from('1a45dfa3874282847765626d', 'hex')],
  ] as const)(
    'sends original %s/%s tool bytes in native blocks and resumes without reopening the source',
    async (protocol, modality, toolName, mime, bytes) => {
      process.env.NATIVE_PROTOCOL = protocol;
      catalogModels = { local: { models: {
        'media-model': { modalities: { input: ['text', modality], output: ['text'] } },
      } } };
      const filename = path.join(root, 'source.txt');
      fs.writeFileSync(filename, bytes);
      scriptedToolCalls = [[toolName, '{"path":"source.txt"}']];
      const prepare = spyOn(nativeAudio, 'prepareAudio');
      let events: ProviderEvent[];
      try {
        events = await collect(new NativeProvider({ model: 'local/media-model' }));
        expect(prepare).not.toHaveBeenCalled();
      } finally { prepare.mockRestore(); }
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(JSON.stringify(requests[0]?.tools)).toContain(toolName);
      const instructions = JSON.stringify(protocol === 'anthropic-messages'
        ? requests[0]?.system : requests[0]?.messages);
      for (const name of ['view_image', 'view_pdf', 'listen_audio', 'view_video']) {
        expect(instructions.includes(name)).toBe(name === toolName);
      }
      const data = bytes.toString('base64');
      let wire: Record<string, unknown>;
      if (protocol === 'anthropic-messages') {
        wire = { type: 'document', source: { type: 'base64', media_type: mime, data } };
      } else if (modality === 'pdf') {
        wire = { type: 'file', file: { filename: 'document.pdf', file_data: `data:${mime};base64,${data}` } };
      } else if (modality === 'audio') {
        wire = { type: 'input_audio', input_audio: { data, format: mime === 'audio/wav' ? 'wav' : 'mp3' } };
      } else {
        wire = { type: 'video_url', video_url: { url: `data:${mime};base64,${data}` } };
      }
      expect(JSON.stringify(requests[1]?.messages)).toContain(JSON.stringify(wire));
      expect(events.some((event) => event.type === 'progress' && event.step.tool === toolName &&
        event.step.status === 'completed' && event.step.detail === 'source.txt')).toBe(true);
      const init = events.find((event) => event.type === 'init');
      if (init?.type !== 'init') throw new Error('Missing native continuation');
      const store = new NativeStore();
      try {
        expect(nativeAttachments.inlineHistoryBytes(store.messages(init.continuation))).toBe(data.length);
      } finally { store.close(); }
      fs.unlinkSync(filename);
      const resumed = await collect(new NativeProvider({ model: 'local/media-model' }), init.continuation);
      expect(resumed.some((event) => event.type === 'error')).toBe(false);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain(JSON.stringify(wire));
      expect(resumed.some((event) => event.type === 'progress' && event.step.tool === toolName)).toBe(false);
    },
  );

  it('recovers PDF tool media pressure without replaying completed actions', async () => {
    process.env.NATIVE_PROTOCOL = 'openai-chat';
    catalogModels = { local: { models: {
      'media-model': { modalities: { input: ['text', 'pdf', 'image'], output: ['text'] } },
    } } };
    const continuation = mediaHistory();
    const bytes = Buffer.from(`%PDF-1.4\n${' '.repeat(200)}\n%%EOF\n`);
    fs.writeFileSync(path.join(root, 'document.pdf'), bytes);
    scriptedToolCalls = [
      ['bash', '{"command":"echo once >> once.txt"}'],
      ['view_pdf', '{"path":"document.pdf"}'],
      ['view_pdf', '{"path":"document.pdf"}'],
    ];
    const events = await collect(new NativeProvider({ model: 'local/media-model' }), continuation);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'completed')).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(`data:application/pdf;base64,${bytes.toString('base64')}`);
    const store = new NativeStore();
    try {
      expect(nativeAttachments.inlineHistoryBytes(store.contextMessages(continuation))).toBe(bytes.toString('base64').length);
    } finally { store.close(); }
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'sends actual local-image content through %s and replays without source files',
    async (protocol) => {
      const provider = vision(protocol);
      const filename = path.join(root, 'screenshot.png');
      fs.writeFileSync(filename, Buffer.from(png, 'base64'));
      scriptedToolCalls = [
        ['view_image', '{"path":"screenshot.png"}'],
        ['view_image', JSON.stringify({ path: filename })],
      ];
      const events = await collect(provider);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(JSON.stringify(requests[0]?.tools)).toContain('view_image');
      const instructions = JSON.stringify(protocol === 'anthropic-messages'
        ? requests[0]?.system : requests[0]?.messages);
      expect(instructions).toContain('view_image');
      for (const name of ['view_pdf', 'listen_audio', 'view_video']) expect(instructions).not.toContain(name);
      expect(requestImages(requests[1]?.messages)).toContainEqual(wireImage(protocol));
      expect(requestImages(requests[2]?.messages)).toHaveLength(2);
      expect(events.filter((event) => event.type === 'progress' &&
        event.step.tool === 'view_image' && event.step.status === 'completed')).toHaveLength(2);
      const init = events.find((event) => event.type === 'init');
      if (init?.type !== 'init') throw new Error('Missing native continuation');
      fs.unlinkSync(filename);
      const resumed = await collect(new NativeProvider({ model: 'local/vision-model' }), init.continuation);
      expect(resumed.some((event) => event.type === 'error')).toBe(false);
      expect(requestImages(requests.at(-1)?.messages)).toHaveLength(2);
      expect(requestImages(requests.at(-1)?.messages)).toContainEqual(wireImage(protocol));
      expect(resumed.some((event) => event.type === 'progress' && event.step.tool === 'view_image')).toBe(false);
    },
  );

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'reopens the updated source image after %s compaction omits old pixels',
    async (protocol) => {
      const provider = vision(protocol);
      const filename = path.join(root, 'image-source.png');
      fs.writeFileSync(filename, Buffer.from(png, 'base64'));
      scriptedToolCalls = [['view_image', '{"path":"image-source.png"}']];
      const first = await collect(provider);
      const init = first.find((event) => event.type === 'init');
      if (init?.type !== 'init') throw new Error('Missing native continuation');
      const store = new NativeStore();
      try {
        store.append(init.continuation, [
          { role: 'user', content: 'Subsequent requirements '.repeat(250) },
          { role: 'assistant', content: 'Later work' },
          { role: 'user', content: 'More work' },
          { role: 'assistant', content: 'More results' },
          { role: 'user', content: 'Another request' },
          { role: 'assistant', content: 'Another answer' },
        ]);
        fs.writeFileSync(filename, Buffer.from(gif, 'base64'));
        contextOverflows = 1;
        scriptedToolCalls = [['view_image', '{"path":"image-source.png"}']];
        const events = await collect(provider, init.continuation);
        expect(events.some((event) => event.type === 'error')).toBe(false);
        expect(events.some((event) => event.type === 'progress' &&
          event.step.kind === 'compaction' && event.step.status === 'completed')).toBe(true);
        const summary = requests.find((request) => JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS));
        expect(summary).toBeDefined();
        expect(JSON.stringify(summary)).toContain('image-source.png');
        expect(requestImages(summary?.messages)).toEqual([]);
        expect(JSON.stringify(summary)).not.toContain(png);
        expect(requestImages(requests.at(-1)?.messages)).toEqual([wireImage(protocol, gif, 'image/gif')]);
        expect(JSON.stringify(store.contextMessages(init.continuation))).not.toContain(png);
        expect(JSON.stringify(store.messages(init.continuation))).toContain(png);
        expect(JSON.stringify(store.messages(init.continuation))).toContain(gif);
      } finally { store.close(); }
    },
  );

  it('reports protected media that cannot be compacted instead of silently dropping it', async () => {
    const provider = vision('openai-chat');
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from(png, 'base64'));
    const protectedPath = path.join(root, 'protected.png');
    fs.writeFileSync(protectedPath, paddedPng(nativeAttachments.MAX_INLINE_BYTES));
    scriptedToolCalls = [['view_image', '{"path":"image.png"}']];
    const events = await collect(provider, undefined, [{
      path: protectedPath, mime: 'image/png', filename: 'protected.png',
    }]);
    expect(events.some((event) => event.type === 'error' && event.message.includes('cannot be compacted'))).toBe(true);
    expect(requestImages(requests.at(-1)?.messages)).toHaveLength(1);
    expect(events.filter((event) => event.type === 'progress' &&
      event.step.tool === 'view_image' && event.step.status === 'completed')).toHaveLength(0);
    expect(events.some((event) => event.type === 'progress' && event.step.status === 'error' &&
      event.step.error?.includes('media budget'))).toBe(true);
  });

  function paddedPng(encodedBytes: number) {
    const bytes = Buffer.from(png, 'base64');
    const padding = Buffer.alloc(encodedBytes * 3 / 4 - bytes.length - 12, 65);
    padding.write('Padding\0');
    const chunk = Buffer.alloc(padding.length + 12);
    chunk.writeUInt32BE(padding.length);
    chunk.write('tEXt', 4);
    padding.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const image = Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
    expect(image.toString('base64').length).toBe(encodedBytes);
    return image;
  }

  function mediaHistory() {
    const encodedBytes = nativeAttachments.MAX_INLINE_BYTES - png.length + 4;
    const data = paddedPng(encodedBytes).toString('base64');
    const store = new NativeStore();
    try {
      const continuation = store.createConversation();
      store.append(continuation, [
        { role: 'user', content: [
          { type: 'text', text: 'Earlier image at /workspace/old.png' },
          { type: 'file', mediaType: 'image/png', data },
        ] },
        { role: 'assistant', content: 'Earlier visual work done' },
        { role: 'user', content: 'Later requirements '.repeat(250) },
        { role: 'assistant', content: 'Later work done' },
        { role: 'user', content: 'Another task' },
        { role: 'assistant', content: 'Another task done' },
      ]);
      expect(nativeAttachments.inlineHistoryBytes(store.contextMessages(continuation))).toBe(encodedBytes);
      return continuation;
    } finally { store.close(); }
  }

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'recovers actual media pressure on %s without replaying completed actions',
    async (protocol) => {
      const provider = vision(protocol);
      const continuation = mediaHistory();
      fs.writeFileSync(path.join(root, 'image.png'), Buffer.from(png, 'base64'));
      scriptedToolCalls = [
        ['bash', '{"command":"echo once >> once.txt"}'],
        ['view_image', '{"path":"image.png"}'],
        ['view_image', '{"path":"image.png"}'],
      ];
      const events = await collect(provider, continuation);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
        event.step.status === 'completed')).toHaveLength(1);
      expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
        event.step.detail?.includes('media budget'))).toBe(true);
      expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
      expect(events.filter((event) => event.type === 'progress' && event.step.tool === 'bash' &&
        event.step.status === 'completed')).toHaveLength(1);
      expect(requestImages(requests.at(-1)?.messages)).toEqual([wireImage(protocol)]);
      const store = new NativeStore();
      try {
        expect(nativeAttachments.inlineHistoryBytes(store.contextMessages(continuation))).toBe(png.length);
        expect(nativeAttachments.inlineHistoryBytes(store.messages(continuation))).toBe(
          nativeAttachments.MAX_INLINE_BYTES + 4,
        );
      } finally { store.close(); }
    },
  );

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'compacts before preparing a new inline attachment on %s',
    async (protocol) => {
      const provider = vision(protocol);
      const continuation = mediaHistory();
      const filename = path.join(root, 'new.png');
      fs.writeFileSync(filename, Buffer.from(png, 'base64'));
      const events = await collect(provider, continuation, [{ path: filename, mime: 'image/png', filename: 'new.png' }]);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
        event.step.status === 'completed')).toBe(true);
      expect(requestImages(requests.at(-1)?.messages)).toEqual([wireImage(protocol)]);
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('inline-payload-limit');
    },
  );

  it('surfaces media compaction failure without retrying tool side effects', async () => {
    const provider = vision('openai-chat');
    const continuation = mediaHistory();
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from(png, 'base64'));
    scriptedToolCalls = [
      ['bash', '{"command":"echo once >> once.txt"}'],
      ['view_image', '{"path":"image.png"}'],
    ];
    rejectCompaction = true;
    const events = await collect(provider, continuation);
    expect(events.some((event) => event.type === 'error' && event.message.includes('Summary service rejected'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'error')).toBe(true);
  });

  it('bounds recovery when the protected current image occupies the whole budget', async () => {
    const provider = vision('openai-chat');
    const continuation = history();
    const filename = path.join(root, 'protected.png');
    fs.writeFileSync(filename, paddedPng(nativeAttachments.MAX_INLINE_BYTES));
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from(png, 'base64'));
    scriptedToolCalls = Array.from({ length: 3 }, (): [string, string] => ['view_image', '{"path":"image.png"}']);
    const events = await collect(provider, continuation, [{ path: filename, mime: 'image/png', filename: 'protected.png' }]);
    expect(events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'running')).toHaveLength(2);
    expect(events.some((event) => event.type === 'error' && event.message.includes('media budget recovery exhausted'))).toBe(true);
    const store = new NativeStore();
    try {
      expect(nativeAttachments.inlineHistoryBytes(store.contextMessages(continuation))).toBe(nativeAttachments.MAX_INLINE_BYTES);
    } finally { store.close(); }
  });

  it('shares the two recovery attempts between media and token pressure', async () => {
    const provider = vision('openai-chat');
    const continuation = mediaHistory();
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from(png, 'base64'));
    scriptedToolCalls = [['view_image', '{"path":"image.png"}']];
    contextOverflows = 2;
    overflowAfterTool = true;
    const events = await collect(provider, continuation);
    const compactions = events.filter((event) => event.type === 'progress' &&
      event.step.kind === 'compaction' && event.step.status === 'running');
    expect(compactions).toHaveLength(2);
    expect(compactions[0]).toMatchObject({ step: { detail: expect.stringContaining('media budget') } });
    expect(compactions[1]).toMatchObject({ step: { detail: expect.stringContaining('Context window') } });
    expect(events.some((event) => event.type === 'error' && event.message.includes('2013'))).toBe(true);
  });

  it('compacts oversized tool-media history before sending the next model request', async () => {
    const provider = vision('openai-chat');
    const continuation = mediaHistory();
    const create = nativeTools.createNativeTools;
    const fixture = spyOn(nativeTools, 'createNativeTools').mockImplementation((...args) => ({
      ...create(...args),
      fixture_media: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async () => png,
        toModelOutput: ({ output }) => ({ type: 'content', value: [
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: output } },
        ] }),
      }),
    }));
    try {
      scriptedToolCalls = [['fixture_media', '{}']];
      const events = await collect(provider, continuation);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
        event.step.status === 'completed')).toHaveLength(1);
      expect(requestImages(requests.at(-1)?.messages)).toEqual([wireImage('openai-chat')]);
      expect(events.filter((event) => event.type === 'progress' && event.step.tool === 'fixture_media' &&
        event.step.status === 'completed')).toHaveLength(1);
    } finally { fixture.mockRestore(); }
  });

  it.each([false, true])('prepares media steering after compaction, preserving acknowledgement ordering (abort=%s)', async (abort) => {
    const provider = vision('openai-chat');
    const continuation = mediaHistory();
    const filename = path.join(root, 'guidance.png');
    fs.writeFileSync(filename, Buffer.from(png, 'base64'));
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    const query = provider.query({ prompt: 'continue', continuation, cwd: root });
    const events: ProviderEvent[] = [];
    let offered = false;
    for await (const event of query.events) {
      events.push(event);
      if (!offered && event.type === 'progress' && event.step.tool === 'bash' && event.step.status === 'completed') {
        offered = true;
        expect(query.steer!({
          id: 'media-guidance', prompt: 'inspect this guidance',
          files: [{ path: filename, mime: 'image/png', filename: 'guidance.png' }],
        })).toBe(true);
      }
      if (abort && event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'running')
        query.abort('user');
      if (event.type === 'result') query.end();
    }
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(provider.appliedSteering(continuation, ['media-guidance'])).toEqual(abort ? [] : ['media-guidance']);
    if (abort) {
      expect(events.some((event) => event.type === 'steering_applied')).toBe(false);
      expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
        event.step.status === 'interrupted')).toBe(true);
    } else {
      const compacted = events.findIndex((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
        event.step.status === 'completed');
      const acknowledged = events.findIndex((event) => event.type === 'steering_applied');
      expect(compacted).toBeGreaterThan(-1);
      expect(acknowledged).toBeGreaterThan(compacted);
      expect(requestImages(requests.at(-1)?.messages)).toEqual([wireImage('openai-chat')]);
    }
  });

  function history(): string {
    const store = new NativeStore();
    try {
      const continuation = store.createConversation();
      store.append(continuation, [
        { role: 'user', content: 'Earlier requirements '.repeat(250) },
        { role: 'assistant', content: 'Earlier work complete' },
        { role: 'user', content: 'Previous task' },
        { role: 'assistant', content: 'Previous answer' },
      ]);
      return continuation;
    } finally { store.close(); }
  }

  it('automatically compacts error 2013, traces its lifecycle, and retries the same request', async () => {
    const continuation = history();
    contextOverflows = 1;
    const events = await collect(new NativeProvider({ model: 'local/test-model' }), continuation);
    const compaction = events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction');
    expect(compaction).toHaveLength(2);
    expect(compaction[0]).toMatchObject({ step: { status: 'running', auto: true } });
    expect(compaction[1]).toMatchObject({ step: { status: 'completed', id: (compaction[0] as Extract<ProviderEvent, { type: 'progress' }>).step.id } });
    expect(replyTexts(events)).toEqual([['hello from stub']]);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const store = new NativeStore();
    try {
      expect(JSON.stringify(store.messages(continuation))).toContain('Earlier requirements '.repeat(250));
      expect(JSON.stringify(store.contextMessages(continuation))).not.toContain('Earlier requirements '.repeat(250));
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('follow up');
    } finally { store.close(); }
  });

  it('does not rerun a completed tool when the next model step exceeds context', async () => {
    const continuation = history();
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    contextOverflows = 1;
    overflowAfterTool = true;
    const events = await collect(new NativeProvider({ model: 'local/test-model' }), continuation);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(events.filter((event) => event.type === 'progress' && event.step.kind === 'tool' && event.step.tool === 'bash' && event.step.status === 'completed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'completed')).toBe(true);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('tool_call_id');
    expect(replyTexts(events)).toEqual([['hello from stub']]);
  });

  function knownContext() {
    catalogModels = { local: { models: { 'test-model': {
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1_000_000, output: 8192 },
    } } } };
    return new NativeProvider({ model: 'local/test-model' });
  }

  function compactions(events: ProviderEvent[], status: 'running' | 'completed' | 'error') {
    return events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === status);
  }

  function miniMaxFlash(maxOutputTokens = 512_000) {
    catalogModels = { local: { models: { 'MiniMax-M3.1-Flash-Preview': {
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1_000_000, output: maxOutputTokens },
    } } } };
    return new NativeProvider({ model: 'local/MiniMax-M3.1-Flash-Preview' });
  }

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'recovers a reasoning-only MiniMax compaction through %s without duplicate billing', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      contextOverflows = 1;
      reasoningOnlyCompactions = 1;
      const events = await collect(miniMaxFlash(), history());
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(compactions(events, 'completed')).toHaveLength(1);
      const summaries = requests.filter((request) => JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS));
      expect(summaries.map((request) => request.max_tokens)).toEqual([16_000, 24_000]);
      for (const request of summaries) {
        if (protocol === 'anthropic-messages') {
          expect(request.output_config).toEqual({ effort: 'low' });
          expect(request.thinking).toBeUndefined();
        } else expect(request.reasoning_effort).toBe('low');
      }
      const normal = requests.filter((request) => !JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS));
      expect(normal.every((request) => request.output_config === undefined && request.reasoning_effort === undefined)).toBe(true);
      const calls = events.filter((event) => event.type === 'usage_call');
      expect(calls).toHaveLength(3);
      expect(calls.filter((event) => event.type === 'usage_call' && event.data.reasoning_tokens === 16_000)).toHaveLength(1);
      const total = { data: turnTotal(events) };
      expect(total).toMatchObject({ data: { input_tokens: 12, reasoning_tokens: 16_000, num_turns: 3,
        output_tokens: protocol === 'anthropic-messages' ? 16_008 : 16_006,
        context_tokens: protocol === 'anthropic-messages' ? 32 : 7 } });
      expect(replyTexts(events)).toHaveLength(1);
    },
  );

  it('reports exact diagnostics after a second reasoning-only MiniMax summary without activating it', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    contextOverflows = 1;
    reasoningOnlyCompactions = 2;
    const continuation = history();
    const events = await collect(miniMaxFlash(), continuation);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('empty summary') }));
    expect(compactions(events, 'error')).toHaveLength(1);
    expect(JSON.stringify(compactions(events, 'error'))).toContain('reasoning=24000');
    expect(JSON.stringify(compactions(events, 'error'))).toContain('summary_bytes=0/32000');
    expect(events.filter((event) => event.type === 'usage_call')).toHaveLength(2);
    expect(requests).toHaveLength(3);
    const store = new NativeStore();
    try {
      expect(JSON.stringify(store.contextMessages(continuation))).toContain('Earlier requirements '.repeat(250));
    } finally { store.close(); }
  });

  it('does not treat numeric summary diagnostics as a retryable HTTP error', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    contextOverflows = 1;
    reasoningOnlyCompactions = 1;
    const events = await collect(miniMaxFlash(512), history());
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', retryable: false, message: expect.stringContaining('generation_limit=512'),
    }));
    expect(requests).toHaveLength(2);
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'compacts at exactly 75%% between completed steps through %s without replaying tools', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      const provider = knownContext();
      scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
      scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
      const events = await collect(provider, history());
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(compactions(events, 'completed')).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
      const start = events.findIndex((event) => event.type === 'progress' && event.step.kind === 'compaction');
      const toolEnd = events.findIndex((event) => event.type === 'progress' && event.step.kind === 'tool' &&
        event.step.status === 'completed');
      expect(start).toBeGreaterThan(toolEnd);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('once.txt');
      expect(requests.filter((request) => JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS))).toHaveLength(1);
    },
  );

  it.each([
    { name: 'below threshold', usage: { prompt_tokens: 749_997, completion_tokens: 2 }, known: true },
    { name: 'missing usage', usage: {}, known: true },
    { name: 'unknown window', usage: { prompt_tokens: 900_000, completion_tokens: 2 }, known: false },
  ])('does not proactively compact with $name', async ({ usage, known }) => {
    const provider = known ? knownContext() : new NativeProvider({ model: 'local/test-model' });
    scriptedToolCalls = [['bash', '{"command":"echo once"}']];
    scriptedUsage = [usage];
    const events = await collect(provider, history());
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(compactions(events, 'running')).toHaveLength(0);
  });

  it('does not compact a final answer even above the threshold', async () => {
    const provider = knownContext();
    scriptedUsage = [{ prompt_tokens: 800_000, completion_tokens: 3 }];
    const events = await collect(provider, history());
    expect(compactions(events, 'running')).toHaveLength(0);
    expect(replyTexts(events)).toEqual([['hello from stub']]);
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'does not reuse stale occupancy or summarizer usage, and bills %s summary calls exactly once', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      const provider = knownContext();
      const continuation = history();
      scriptedToolCalls = [
        ['bash', '{"command":"echo first"}'],
        ['bash', '{"command":"echo second"}'],
      ];
      scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
      compactionUsage = { prompt_tokens: 900_000, completion_tokens: 3 };
      const events = await collect(provider, continuation);
      expect(compactions(events, 'completed')).toHaveLength(1);
      const calls = events.filter((event) => event.type === 'usage_call');
      const summaries = calls.filter((event) => event.type === 'usage_call' && event.data.input_tokens === 900_000);
      expect(summaries).toHaveLength(1);
      expect(summaries.every((event) => event.type === 'usage_call' && event.data.context_tokens === undefined)).toBe(true);
      const total = { data: turnTotal(events) };
      expect(total).toMatchObject({ data: protocol === 'anthropic-messages'
        ? { input_tokens: 1_650_006, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 6, context_tokens: 32, num_turns: 4 }
        : { input_tokens: 1_650_013, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, context_tokens: 7, num_turns: 4 } });
      const resumed = await collect(provider, continuation);
      expect(compactions(resumed, 'running')).toHaveLength(0);
    },
  );

  it('reports proactive failure once, continues unchanged, and keeps emergency recovery available', async () => {
    const provider = knownContext();
    const continuation = history();
    scriptedToolCalls = [
      ['bash', '{"command":"echo once >> once.txt"}'],
      ['bash', '{"command":"echo twice >> once.txt"}'],
    ];
    scriptedUsage = [{ prompt_tokens: 800_000, completion_tokens: 2 }, { prompt_tokens: 800_000, completion_tokens: 2 }];
    rejectCompaction = true;
    const events = await collect(provider, continuation);
    expect(compactions(events, 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'notification' &&
      event.step.text.includes('Automatic compaction failed'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\ntwice\n');
    rejectCompaction = false;
    contextOverflows = 1;
    const recovered = await collect(provider, continuation);
    expect(compactions(recovered, 'completed')).toHaveLength(1);
    expect(recovered.some((event) => event.type === 'error')).toBe(false);
  });

  it('caps proactive compactions without spending the emergency recovery budget', async () => {
    const provider = knownContext();
    scriptedToolCalls = Array.from({ length: 4 }, () => ['bash', '{"command":"echo once >> once.txt"}']);
    scriptedUsage = Array.from({ length: 4 }, () => ({ prompt_tokens: 800_000, completion_tokens: 2 }));
    const events = await collect(provider, history());
    expect(compactions(events, 'completed')).toHaveLength(2);
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'notification' &&
      event.step.text.includes('compaction limit'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\nonce\nonce\nonce\n');
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('retains both emergency attempts in the same turn after proactive compaction', async () => {
    const provider = knownContext();
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
    const query = provider.query({ prompt: 'follow up', continuation: history(), cwd: root });
    query.end();
    const events: ProviderEvent[] = [];
    let rejected = false;
    for await (const event of query.events) {
      events.push(event);
      if (!rejected && event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'completed') {
        rejected = true;
        contextOverflows = 2;
      }
    }
    expect(compactions(events, 'completed')).toHaveLength(3);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
  });

  it('keeps protected steering through proactive compaction and acknowledges it at generation start', async () => {
    const provider = knownContext();
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
    const query = provider.query({ prompt: 'follow up', continuation: history(), cwd: root });
    const events: ProviderEvent[] = [];
    let offered = false;
    for await (const event of query.events) {
      events.push(event);
      if (!offered && event.type === 'progress' && event.step.kind === 'tool' && event.step.status === 'completed') {
        offered = true;
        expect(query.steer?.({ id: 'threshold-guidance', prompt: 'Keep the completed file edit; report the next task.' })).toBe(true);
      }
      if (event.type === 'result') query.end();
    }
    expect(compactions(events, 'completed')).toHaveLength(1);
    const compacted = events.findIndex((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'completed');
    expect(events.findIndex((event) => event.type === 'steering_applied')).toBeGreaterThan(compacted);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Keep the completed file edit');
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
  });

  it('stops a proactive compaction without activating a summary or starting the next model step', async () => {
    const provider = knownContext();
    const continuation = history();
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
    const query = provider.query({ prompt: 'follow up', continuation, cwd: root });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'running')
        query.abort('user');
    }
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'interrupted')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(replyTexts(events)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    const store = new NativeStore();
    try {
      expect(JSON.stringify(store.contextMessages(continuation))).toContain('Earlier requirements '.repeat(250));
    } finally { store.close(); }
  });

  it('continues after proactive compaction cannot remove protected or recent history', async () => {
    const provider = knownContext();
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
    const events = await collect(provider);
    expect(compactions(events, 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(replyTexts(events)).toEqual([['hello from stub']]);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
  });

  it('bounds overflow recovery to two compactions and surfaces a persistent rejection', async () => {
    contextOverflows = 3;
    const events = await collect(new NativeProvider({ model: 'local/test-model' }), history());
    expect(events.filter((event) => event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'running')).toHaveLength(2);
    expect(events.some((event) => event.type === 'error' && event.message.includes('2013'))).toBe(true);
  });

  it('reports a failed compaction distinctly and preserves the uncompressed context', async () => {
    const continuation = history();
    contextOverflows = 1;
    rejectCompaction = true;
    const events = await collect(new NativeProvider({ model: 'local/test-model' }), continuation);
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'error' && event.message.includes('Summary service rejected'))).toBe(true);
    const store = new NativeStore();
    try { expect(JSON.stringify(store.contextMessages(continuation))).toContain('Earlier requirements '.repeat(250)); }
    finally { store.close(); }
  });

  it('compacts MiniMax-style error 2013 through the Anthropic Messages adapter', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    contextOverflows = 1;
    const events = await collect(new NativeProvider({ model: 'local/test-model' }), history());
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'completed')).toBe(true);
    expect(replyTexts(events)).toEqual([['hello from direct minimax']]);
  });

  it('reports cancelled compaction as interrupted without saving a summary or resuming', async () => {
    const continuation = history();
    contextOverflows = 1;
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'current request', continuation, cwd: root });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'running') query.abort('user');
    }
    expect(events.some((event) => event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'interrupted')).toBe(true);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    const store = new NativeStore();
    try { expect(JSON.stringify(store.contextMessages(continuation))).toContain('Earlier requirements '.repeat(250)); }
    finally { store.close(); }
  });

  it('removes buffered guidance before consumption without stopping the active reply', async () => {
    holdModelResponse = true;
    const started = new Promise<void>((resolve) => { modelRequestStarted = resolve; });
    const provider = new NativeProvider({ model: 'local/test-model' });
    expect(provider.supportsInputCancellation).toBe(true);
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'result') query.end();
      }
    })();
    try {
      await started;
      expect(query.steer!({ id: 'cancelled', prompt: 'do not consume this' })).toBe(true);
      expect(query.steer!({ id: 'kept', prompt: 'retained guidance' })).toBe(true);
      expect(query.cancelSteering!('cancelled')).toBe(true);
      expect(query.cancelSteering!('cancelled')).toBe(false);
      expect(query.steer!({ id: 'cancelled', prompt: 'duplicate delivery' })).toBe(true);
      holdModelResponse = false;
      releaseModelResponse!();
      releaseModelResponse = undefined;
      await consume;
      expect(JSON.stringify(requests)).not.toContain('do not consume this');
      expect(JSON.stringify(requests)).not.toContain('duplicate delivery');
      expect(JSON.stringify(requests)).toContain('retained guidance');
      expect(events.filter((event) => event.type === 'steering_applied').map((event) => event.id)).toEqual(['kept']);
      expect(events.some((event) => event.type === 'result')).toBe(true);
      expect(query.cancelSteering!('kept')).toBe(false);
    } finally {
      releaseModelResponse?.();
      query.abort();
      await consume;
    }
  });

  it('replaces buffered steering in place before consuming it, preserving order and attachments', async () => {
    holdModelResponse = true;
    const started = new Promise<void>((resolve) => { modelRequestStarted = resolve; });
    const image = path.join(root, 'edit.png');
    fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
    const files = [{ path: image, mime: 'image/png', filename: 'edit.png' }];
    const provider = new NativeProvider({ model: 'local/test-model' });
    expect(provider.supportsInputEditing).toBe(true);
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'result') query.end();
      }
    })();
    try {
      await started;
      expect(query.steer!({ id: 'first', prompt: 'old guidance', files })).toBe(true);
      expect(query.steer!({ id: 'second', prompt: 'later guidance' })).toBe(true);
      expect(query.replaceSteering!({ id: 'first', prompt: 'replacement guidance', files })).toBe(true);
      expect(query.replaceSteering!({ id: 'absent', prompt: 'not queued' })).toBe(false);
      holdModelResponse = false;
      releaseModelResponse!();
      releaseModelResponse = undefined;
      await consume;
      const body = JSON.stringify(requests[1].messages);
      expect(body).toContain('replacement guidance');
      expect(body).toContain('image_url');
      expect(body).not.toContain('old guidance');
      expect(body.indexOf('replacement guidance')).toBeLessThan(body.indexOf('later guidance'));
      expect(events.filter((event) => event.type === 'steering_applied').map((event) => event.id))
        .toEqual(['first', 'second']);
      expect(query.replaceSteering!({ id: 'first', prompt: 'too late' })).toBe(false);
    } finally {
      releaseModelResponse?.();
      query.abort();
      await consume;
    }
  });

  it('locks steering before asynchronous preparation and rejects edits after Stop', async () => {
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const release = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const prepare = nativeAttachments.prepareNativeUserMessage;
    const prepareSpy = spyOn(nativeAttachments, 'prepareNativeUserMessage').mockImplementation(async (...args) => {
      if (args[0] === 'old guidance') {
        preparationStarted();
        await release;
      }
      return prepare(...args);
    });
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'assistant_message') {
          expect(query.steer!({ id: 'guidance', prompt: 'old guidance' })).toBe(true);
        }
      }
    })();
    try {
      await started;
      expect(query.replaceSteering!({ id: 'guidance', prompt: 'racing edit' })).toBe(false);
      expect(query.cancelSteering!('guidance')).toBe(false);
      query.abort('user');
      expect(query.cancelSteering!('guidance')).toBe(false);
      expect(query.replaceSteering!({ id: 'guidance', prompt: 'edit after stop' })).toBe(false);
      releasePreparation();
      await consume;
      expect(requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'steering_applied')).toBe(false);
      const continuation = events.find((event) => event.type === 'init')!.continuation;
      expect(provider.appliedSteering(continuation, ['guidance'])).toEqual([]);
    } finally {
      releasePreparation();
      query.abort();
      await consume;
      prepareSpy.mockRestore();
    }
  });

  it('lets a blocked model call finish before applying guidance to its final-text continuation', async () => {
    holdModelResponse = true;
    const started = new Promise<void>((resolve) => { modelRequestStarted = resolve; });
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'result') query.end();
      }
    })();
    try {
      await started;
      expect(query.steer!({ id: 'model-guidance', prompt: 'follow the new direction' })).toBe(true);
      expect(requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'steering_applied')).toBe(false);
      holdModelResponse = false;
      releaseModelResponse!();
      await consume;
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages)).toContain('original answer');
      expect(JSON.stringify(requests[1].messages)).toContain('follow the new direction');
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'usage_call')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'model_request')).toHaveLength(2);
      expect(events.findIndex((event) => event.type === 'model_request'))
        .toBeLessThan(events.findIndex((event) => event.type === 'usage_call'));
    } finally {
      query.abort();
      await consume;
    }
  });

  it('finishes an in-flight tool, then steers the same turn without aborting or duplicating usage', async () => {
    slowToolMode = true;
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let toolSignal: AbortSignal | undefined;
    const toolSpy = spyOn(nativeTools, 'createNativeTools').mockReturnValue({
      bash: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async (_args, options) => {
          toolSignal = options.abortSignal;
          started();
          await new Promise<void>((resolve) => { release = resolve; });
          return 'completed original action';
        },
      }),
    });
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    expect(query.steer!({ id: 'inactive', prompt: 'too early' })).toBe(false);
    const events: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'result') query.end();
      }
    })();
    try {
      await running;
      expect(query.steer!({ id: 's1', prompt: 'new direction' })).toBe(true);
      expect(query.steer!({ id: 's1', prompt: 'duplicate must not appear' })).toBe(true);
      expect(requests).toHaveLength(1);
      expect(toolSignal?.aborted).toBe(false);
      expect(events.some((event) => event.type === 'steering_applied')).toBe(false);
      await Bun.sleep(100);
      release();
      await consume;
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages)).toContain('completed original action');
      expect(JSON.stringify(requests[1].messages)).toContain('new direction');
      expect(JSON.stringify(requests[1].messages)).not.toContain('duplicate must not appear');
      expect(toolSignal?.aborted).toBe(false);
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'steering_applied')).toEqual([{ type: 'steering_applied', id: 's1' }]);
      expect(events.filter((event) => event.type === 'usage_call')).toHaveLength(2);
      expect(turnTotal(events)).toMatchObject({ input_tokens: 15, output_tokens: 5, num_turns: 2, context_tokens: 7 });
      const calls = events.filter((event) => event.type === 'usage_call');
      expect(calls.every((event) => Number.isSafeInteger(event.data.duration_api_ms))).toBe(true);
      expect(query.steer!({ id: 'late', prompt: 'too late' })).toBe(false);
      const continuation = events.find((event) => event.type === 'init')!.continuation;
      expect(provider.appliedSteering(continuation, ['s1', 'late'])).toEqual(['s1']);
    } finally {
      release?.();
      query.abort();
      await consume;
      toolSpy.mockRestore();
    }
  });

  it('resumes text-only final steps for multiple guidance inputs with attachments, keeping push queued', async () => {
    const image = path.join(root, 'guidance.png');
    fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    let boundary = 0;
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'assistant_message' && ++boundary === 1) {
        expect(query.push('queued normal message')).toBe(true);
        expect(query.steer!({ id: 'one', prompt: 'first guidance',
          files: [{ path: image, mime: 'image/png', filename: 'guidance.png' }] })).toBe(true);
        expect(query.steer!({ id: 'two', prompt: 'second guidance' })).toBe(true);
      } else if (event.type === 'assistant_message' && boundary === 2) {
        expect(query.steer!({ id: 'three', prompt: 'third guidance' })).toBe(true);
      } else if (event.type === 'result') {
        query.end();
      }
    }
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[1].messages)).toContain('first guidance');
    expect(JSON.stringify(requests[1].messages)).toContain('image_url');
    expect(JSON.stringify(requests[1].messages)).toContain('second guidance');
    expect(JSON.stringify(requests[1].messages)).not.toContain('queued normal message');
    expect(JSON.stringify(requests[2].messages)).toContain('third guidance');
    expect(JSON.stringify(requests[3].messages)).toContain('queued normal message');
    for (const [index, completed] of [0, 1, 2, 0].entries()) {
      expect(JSON.stringify(requests[index].messages)).toContain(
        `Step budget: ${completed} of ${MAX_STEPS} steps used; ${MAX_STEPS - completed} remain`,
      );
    }
    expect(events.filter((event) => event.type === 'steering_applied').map((event) => event.id)).toEqual(['one', 'two', 'three']);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(2);
    expect(turnTotal(events.slice(0, events.findIndex((event) => event.type === 'result')))).toMatchObject({
      input_tokens: 12, output_tokens: 9, num_turns: 3,
    });
  });

  it('keeps already-delivered sends and todo state while steering', async () => {
    todoToolMode = true;
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'hello', cwd: root });
    let steered = false;
    for await (const event of query.events) {
      if (event.type === 'assistant_message' && !steered) {
        steered = true;
        query.steer!({ id: 'todo-guidance', prompt: 'continue with existing checklist' });
      }
      if (event.type === 'result') query.end();
    }
    expect(JSON.stringify(requests[2].messages)).toContain('turn-one-secret');
    todoToolMode = false;
    toolMode = true;
    const sendQuery = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'send', cwd: root });
    steered = false;
    for await (const event of sendQuery.events) {
      if (event.type === 'assistant_message' && !steered) {
        steered = true;
        sendQuery.steer!({ id: 'after-send', prompt: 'do not send again' });
      }
      if (event.type === 'result') sendQuery.end();
    }
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM messages_out').get()).toMatchObject({ count: 1 });
  });

  it('leaves guidance at the total step limit unapplied instead of running another turn', async () => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    let boundary = 0;
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'assistant_message') {
        query.steer!({ id: `s${++boundary}`, prompt: `guidance ${boundary}` });
      }
      if (event.type === 'result') query.end();
    }
    expect(requests).toHaveLength(MAX_STEPS);
    expect(events.filter((event) => event.type === 'steering_applied')).toHaveLength(MAX_STEPS - 1);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(turnTotal(events)).toMatchObject({ num_turns: MAX_STEPS, input_tokens: 4 * MAX_STEPS });
    const continuation = events.find((event) => event.type === 'init')!.continuation;
    expect(provider.appliedSteering(continuation, [`s${MAX_STEPS - 1}`, `s${MAX_STEPS}`])).toEqual([`s${MAX_STEPS - 1}`]);
  }, 10_000);

  it.each(['end', 'abort'] as const)('does not consume queued guidance after %s at a boundary', async (action) => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'assistant_message') {
        expect(query.steer!({ id: 'unapplied', prompt: 'must remain pending' })).toBe(true);
        if (action === 'end') query.end();
        else query.abort('user');
      }
    }
    expect(requests).toHaveLength(1);
    expect(events.some((event) => event.type === 'steering_applied')).toBe(false);
    const continuation = events.find((event) => event.type === 'init')!.continuation;
    expect(provider.appliedSteering(continuation, ['unapplied'])).toEqual([]);
    expect(query.steer!({ id: 'late', prompt: 'rejected' })).toBe(false);
  });

  it('does not acknowledge input if steering preparation fails', async () => {
    const prepare = nativeAttachments.prepareNativeUserMessage;
    const prepareSpy = spyOn(nativeAttachments, 'prepareNativeUserMessage').mockImplementation(async (...args) => {
      if (args[0] === 'bad guidance') throw new Error('preparation failed');
      return prepare(...args);
    });
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    try {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'assistant_message') query.steer!({ id: 'bad', prompt: 'bad guidance' });
        if (event.type === 'error') query.end();
      }
      expect(requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'steering_applied')).toBe(false);
      const continuation = events.find((event) => event.type === 'init')!.continuation;
      expect(provider.appliedSteering(continuation, ['bad'])).toEqual([]);
    } finally { prepareSpy.mockRestore(); }
  });

  it('keeps accepted steering pending when Stop interrupts an already-running tool', async () => {
    slowToolMode = true;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const toolSpy = spyOn(nativeTools, 'createNativeTools').mockReturnValue({
      bash: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async (_args, options) => {
          started();
          return new Promise<string>((_resolve, reject) => {
            options.abortSignal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
          });

        },
      }),
    });
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => { for await (const event of query.events) events.push(event); })();
    try {
      await running;
      expect(query.steer!({ id: 'pending', prompt: 'next direction' })).toBe(true);
      query.abort('user');
      await consume;
      expect(events.some((event) => event.type === 'steering_applied' || event.type === 'result')).toBe(false);
      expect(requests).toHaveLength(1);
      const continuation = events.find((event) => event.type === 'init')!.continuation;
      expect(provider.appliedSteering(continuation, ['pending'])).toEqual([]);
    } finally {
      query.abort();
      await consume;
      toolSpy.mockRestore();
    }
  });

  it('stops one native tool, returns its interruption to the model, and continues to a reply', async () => {
    slowToolMode = true;
    const toolSpy = spyOn(nativeTools, 'createNativeTools').mockReturnValue({
      bash: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async (_args, options) => new Promise<string>((_resolve, reject) => {
          options.abortSignal!.addEventListener('abort', () => reject(new Error('cancelled tool')), { once: true });
        }),
      }),
    });
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'Run a tool then reply', cwd: root });
    const events: ProviderEvent[] = [];
    try {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'progress' && event.step.kind === 'tool' && event.step.status === 'running') {
          expect(query.stopTool!('stale-call')).toBe(false);
          expect(query.stopTool!(event.step.id)).toBe(true);
        }
        if (event.type === 'result' || event.type === 'error') query.end();
      }
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages)).toContain('Interrupted; outcome unknown');
      expect(events.some((event) => event.type === 'progress' && event.step.kind === 'tool' &&
        event.step.status === 'interrupted')).toBe(true);
      expect(replyTexts(events)).toEqual([['hello from stub']]);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(query.stopTool!('call_1')).toBe(false);
    } finally {
      query.abort();
      toolSpy.mockRestore();
    }
  });

  it('cancels an already-executing tool and still completes the same model turn', async () => {
    slowToolMode = true;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const toolSpy = spyOn(nativeTools, 'createNativeTools').mockReturnValue({
      bash: tool({
        inputSchema: jsonSchema({ type: 'object' }),
        execute: async (_args, options) => {
          started();
          return new Promise<string>((_resolve, reject) => {
            options.abortSignal!.addEventListener('abort', () => reject(new Error('tool stopped')), { once: true });
          });
        },
      }),
    });
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'Do work and reply', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'result' || event.type === 'error') query.end();
      }
    })();
    try {
      await running;
      expect(query.stopTool!('call_1')).toBe(true);
      await consume;
      expect(requests).toHaveLength(2);
      expect(replyTexts(events)).toEqual([['hello from stub']]);
      expect(JSON.stringify(requests[1].messages)).toContain('Interrupted; outcome unknown');
      expect(events.some((event) => event.type === 'error')).toBe(false);
    } finally {
      query.abort();
      await consume;
      toolSpy.mockRestore();
    }
  });

  it('deduplicates recovered steering across provider instances and continuation forks', async () => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    let continuation = '';
    let checkpoint = '';
    let applied = false;
    for await (const event of query.events) {
      if (event.type === 'init') continuation = event.continuation;
      if (event.type === 'assistant_message' && !applied) {
        applied = true;
        query.steer!({ id: 'persisted', prompt: 'durable guidance' });
      }
      if (event.type === 'checkpoint') checkpoint = event.ref;
      if (event.type === 'result') query.end();
    }
    const recovered = new NativeProvider({ model: 'local/test-model' });
    expect(recovered.appliedSteering(continuation, ['persisted', 'missing'])).toEqual(['persisted']);
    const fork = await recovered.forkContinuation({ continuation, anchorRef: checkpoint, cwd: root });
    expect(recovered.appliedSteering(fork!, ['persisted'])).toEqual(['persisted']);
    const retried = recovered.query({ prompt: 'follow-up', continuation: fork!, cwd: root });
    let acknowledged = 0;
    for await (const event of retried.events) {
      if (event.type === 'assistant_message') retried.steer!({ id: 'persisted', prompt: 'must not be added again' });
      if (event.type === 'steering_applied') acknowledged++;
      if (event.type === 'result') retried.end();
    }
    expect(acknowledged).toBe(1);
    expect(requests).toHaveLength(3);
    const store = new NativeStore(process.env.NATIVE_STATE_PATH);
    try {
      const history = JSON.stringify(store.messages(fork!));
      expect(history.match(/durable guidance/g)).toHaveLength(1);
      expect(history).not.toContain('must not be added again');
    } finally { store.close(); }
  });

  it('aborts a waiting model stream without retrying and closes its query', async () => {
    holdModelResponse = true;
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'waiting request', cwd: root });
    const events: ProviderEvent[] = [];
    const consume = (async () => { for await (const event of query.events) events.push(event); })();
    try {
      for (let i = 0; requests.length === 0 && i < 100; i++) await Bun.sleep(5);
      expect(requests).toHaveLength(1);
      query.abort();
      await consume;
      expect(requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'checkpoint')).toBe(true);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(events.some((event) => event.type === 'usage_call')).toBe(false);
      expect(query.push('must not run')).toBe(false);
    } finally { query.abort(); await consume; }
  });

  it.each(['openai-compatible', 'anthropic'] as const)('reports %s model usage exactly once when stopped during an unfinished tool', async (protocol) => {
    slowToolMode = true;
    if (protocol === 'anthropic') {
      process.env.NATIVE_PROTOCOL = 'anthropic-messages';
      anthropicToolMode = true;
    }
    const query = new NativeProvider({ model: 'local/test-model', modelParams: { max_tokens: 8192 } })
      .query({ prompt: 'wait then stop', cwd: root });
    const events: ProviderEvent[] = [];
    const timeout = setTimeout(() => query.abort(), 2000);
    try {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'progress' && event.step.kind === 'tool' && event.step.status === 'running') {
          await Bun.sleep(50);
          query.abort();
        }
      }
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(events.filter((event) => event.type === 'usage_call')).toEqual([
        { type: 'usage_call', data: expect.objectContaining({
          input_tokens: protocol === 'anthropic' ? 4 : 11,
          output_tokens: protocol === 'anthropic' ? 10 : 2,
          model: 'local/test-model',
        }) },
      ]);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(events.some((event) => event.type === 'progress' && event.step.kind === 'tool' &&
        event.step.status === 'completed')).toBe(false);
      expect(requests).toHaveLength(1);
    } finally {
      clearTimeout(timeout);
      query.abort();
    }
  });

  it('settles cancellation before preparation without calling the model and preserves cancelled input', async () => {
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'do not replay', cwd: root });
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'init') query.abort();
    }
    const init = events.find((event) => event.type === 'init');
    expect(init?.type).toBe('init');
    expect(events.some((event) => event.type === 'checkpoint')).toBe(true);
    expect(requests).toHaveLength(0);
    expect(query.push('closed')).toBe(false);
    const store = new NativeStore();
    try {
      const history = store.messages(init!.type === 'init' ? init!.continuation : '');
      expect(history[0].content).toBe('do not replay');
      expect(history.at(-1)?.content).toContain('cancelled, not pending');
    } finally { store.close(); }
  });

  it('keeps completed tool results when stopped and resumes without reexecuting them', async () => {
    toolMode = true;
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'send once then stop', cwd: root });
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'progress' && event.step.kind === 'tool' && event.step.status === 'completed') query.abort();
    }
    const init = events.find((event) => event.type === 'init');
    expect(init?.type).toBe('init');
    expect(events.some((event) => event.type === 'checkpoint')).toBe(true);
    const continuation = init!.type === 'init' ? init!.continuation : '';
    const store = new NativeStore();
    try {
      const history = JSON.stringify(store.messages(continuation));
      expect(history).toContain('tool-result');
      expect(history).toContain('cancelled, not pending');
      const checkpoint = [...events].reverse().find((event) => event.type === 'checkpoint');
      const fork = store.fork(continuation, checkpoint!.type === 'checkpoint' ? checkpoint!.ref : '');
      expect(fork).not.toBeNull();
      expect(store.messages(fork!)).toEqual(store.messages(continuation));
    } finally { store.close(); }
    await collect(provider, continuation);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 1 });
    const replay = JSON.stringify(requests.at(-1)?.messages);
    expect(replay).toContain('tool');
    expect(replay).toContain('cancelled, not pending');
  });

  it('formats canonical native tool activity with safe resource details', () => {
    const email = {
      toolCallId: 'email-1', toolName: 'mcp__nanoclaw__send_email',
      input: { to: 'alice@example.test', subject: 'Report', body: 'private body' },
    };
    expect(formatNativeToolStep(email, 'running')).toMatchObject({
      status: 'running', detail: 'alice@example.test', description: 'Subject: Report',
    });
    expect(formatNativeToolStep({ ...email, output: {
      isError: true, content: [{ type: 'text', text: 'Not permitted' }],
    } }, 'completed')).toEqual({
      kind: 'tool', id: 'email-1', tool: email.toolName, status: 'error',
      detail: 'alice@example.test', description: 'Subject: Report', error: 'Not permitted',
    });
    expect(formatNativeToolStep(
      { toolCallId: 'read-1', toolName: 'read', input: { path: 'src/index.ts' } },
      'running',
    )).toMatchObject({ tool: 'read', status: 'running', detail: 'src/index.ts' });
    expect(formatNativeToolStep(
      {
        toolCallId: 'patch-1',
        toolName: 'patch',
        input: { patch: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n' },
      },
      'completed',
    )).toMatchObject({ tool: 'patch', title: 'Applied patch to', detail: 'src/index.ts' });
    expect(formatNativeToolStep(
      { toolCallId: 'skill-1', toolName: 'skill', input: { name: 'deploy', path: 'references/checklist.md' } },
      'completed',
    )).toMatchObject({ tool: 'skill', title: 'Loaded skill', detail: 'deploy/references/checklist.md' });
    expect(formatNativeToolStep(
      { toolCallId: 'search-1', toolName: 'tool_search', input: { query: 'select:mcp__Fixture__echo_value' } },
      'running',
    )).toMatchObject({ tool: 'tool_search', title: 'Loading tools', detail: 'mcp__Fixture__echo_value' });
    expect(formatNativeToolStep(
      { toolCallId: 'mcp-1', toolName: 'mcp__example__lookup', input: { name: 'private-value' } },
      'completed',
    )).not.toHaveProperty('detail');
  });

  it('fingerprints complete tool input with stable object key ordering', () => {
    const first = fingerprintToolInput({
      accountId: 'account-1',
      startDate: '2026-09-20',
      endDate: '2026-09-28',
    });
    const reordered = fingerprintToolInput({
      endDate: '2026-09-28',
      accountId: 'account-1',
      startDate: '2026-09-20',
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(fingerprintToolInput({
      accountId: 'account-2',
      startDate: '2026-09-20',
      endDate: '2026-09-28',
    }));
    expect(first).not.toContain('account-1');
  });

  it('stores supported image attachments as replayable base64 message parts', async () => {
    const imagePath = path.join(root, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(await userMessage('inspect', [{ path: imagePath, mime: 'image/png', filename: 'pixel.png' }])).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'file', data: 'iVBORw==', mediaType: 'image/png', filename: 'pixel.png' },
      ],
    });
  });

  it('gates file modalities by model capability and transport protocol', async () => {
    const files = [
      { path: path.join(root, 'image.png'), mime: 'image/png', filename: 'image.png' },
      { path: path.join(root, 'document.pdf'), mime: 'application/pdf', filename: 'document.pdf' },
      { path: path.join(root, 'notes.txt'), mime: 'text/plain', filename: 'notes.txt' },
      { path: path.join(root, 'speech.mp3'), mime: 'audio/mpeg', filename: 'speech.mp3' },
      { path: path.join(root, 'clip.mp4'), mime: 'video/mp4', filename: 'clip.mp4' },
    ];
    for (const file of files) fs.writeFileSync(file.path, Buffer.from([1, 2, 3]));

    const anthropic = await userMessage('inspect', files, {
      protocol: 'anthropic-messages',
      inputModalities: ['text', 'image', 'pdf', 'audio', 'video'],
    });
    const openai = await userMessage('inspect', files, {
      protocol: 'openai-chat',
      inputModalities: ['text', 'image', 'pdf', 'audio', 'video'],
    });

    expect(JSON.stringify(anthropic)).toContain('document.pdf');
    expect(JSON.stringify(anthropic)).toContain('notes.txt');
    expect(JSON.stringify(anthropic)).toContain('adapter-does-not-support-audio');
    expect(JSON.stringify(anthropic)).not.toContain('"mediaType":"audio/');
    expect(JSON.stringify(anthropic)).not.toContain('clip.mp4');
    expect(JSON.stringify(openai)).toContain('speech.mp3');
    expect(JSON.stringify(openai)).toContain('clip.mp4');
  });

  it('only inspects audio for a known audio-capable model and supported protocol', async () => {
    const file = { path: path.join(root, 'speech.mp3'), mime: 'audio/mpeg', filename: 'speech.mp3' };
    fs.writeFileSync(file.path, Buffer.from([1, 2, 3]));
    const prompt = '[audio; audio/mpeg: speech.mp3 — saved to ' + file.path + ']';
    for (const model of [
      undefined,
      { protocol: 'openai-chat' as const },
      { protocol: 'openai-chat' as const, inputModalities: ['text'] },
      { protocol: 'anthropic-messages' as const, inputModalities: ['text', 'audio'] },
    ]) {
      const prepare = async (): Promise<never> => { throw new Error('Must not inspect disabled audio'); };
      const message = await userMessage(prompt, [file], model, { prepare });
      expect(typeof message.content).toBe('string');
      expect(message.content).toContain(prompt);
      expect(message.content).toContain('file-reference');
    }
    const audioModel = { protocol: 'openai-chat' as const, inputModalities: ['text', 'audio'] };
    const prepare: typeof nativeAudio.prepareAudio = async (attachment) => ({
      kind: 'inline', file: { ...attachment, mime: 'audio/mpeg' },
      bytes: Buffer.from([1, 2, 3]), converted: true,
    });
    expect(await userMessage(prompt, [file], audioModel, { prepare })).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining(prompt) }, { type: 'file', mediaType: 'audio/mpeg', data: 'AQID' }],
    });
    for (const mime of ['audio/ogg', 'audio/webm', 'audio/mp4']) {
      expect(await userMessage(prompt, [{ ...file, mime }], audioModel, { prepare })).toMatchObject({
        content: [{ type: 'text' }, { type: 'file', mediaType: 'audio/mpeg', data: 'AQID' }],
      });
    }
  });

  it('removes provider-private reasoning while preserving portable tool history', () => {
    expect(
      portableHistory([
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private' },
            { type: 'text', text: 'visible' },
            { type: 'text', text: '<internal>todowrite worked; continue.</internal>' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'x' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'read',
              output: { type: 'text', value: 'result' },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'visible' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'result' },
          },
        ],
      },
    ]);
  });

  it('streams a response and resumes with the complete prior exchange', async () => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const first = await collect(provider);
    const continuation = (first.find((event) => event.type === 'init') as { continuation: string }).continuation;
    expect(replyTexts(first)).toEqual([['hello from stub']]);
    expect(first.some((event) => event.type === 'usage_call')).toBe(true);
    expect(first.some((event) => event.type === 'checkpoint')).toBe(true);

    const restartedProvider = new NativeProvider({ model: 'local/test-model' });
    const second = await collect(restartedProvider, continuation);
    expect(replyTexts(second)).toEqual([['hello from stub']]);
    const messages = requests[1]?.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('executes BananaClaw built-ins directly without an MCP subprocess', async () => {
    toolMode = true;
    const provider = new NativeProvider({ model: 'local/test-model' });
    const events = await collect(provider);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'mcp__nanoclaw__send_message', status: 'completed' }),
      }),
    );
    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'chat'").get() as {
      content: string;
    };
    expect(JSON.parse(row.content).text).toBe('hello user');
    expect(requests).toHaveLength(2);
    expect(events.filter((event) => event.type === 'usage_call')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ input_tokens: 11, output_tokens: 2, context_tokens: 13 }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({ input_tokens: 4, output_tokens: 3, context_tokens: 7 }),
      }),
    ]);
  });

  it('discovers and executes a configured external MCP tool', async () => {
    externalMcpToolMode = true;
    const fixture = path.join(import.meta.dir, 'native', 'test-fixtures', 'stdio-mcp.ts');
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    const provider = new NativeProvider({
      model: 'local/test-model',
      mcpServers: { Fixture: { command: bun, args: ['run', fixture] } },
    });
    const events = await collect(provider);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'mcp__Fixture__echo_value', status: 'completed' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        toolInputFingerprint: fingerprintToolInput({ value: 'from-model' }),
        step: expect.objectContaining({ tool: 'mcp__Fixture__echo_value', status: 'running' }),
      }),
    );
    expect(requests).toHaveLength(2);
    expect(requestToolNames(0)).toContain('mcp__Fixture__echo_value');
    expect(requestToolNames(0)).not.toContain('tool_search');
    expect(JSON.stringify(requests[1]?.messages)).toContain('echo:from-model');
  });

  function fixtureProvider(mode: 'always' | 'auto' = 'always'): NativeProvider {
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    return new NativeProvider({
      model: 'local/test-model',
      modelParams: { mcp_tool_search: mode },
      mcpServers: {
        Fixture: { command: bun, args: ['run', path.join(import.meta.dir, 'native', 'test-fixtures', 'stdio-mcp.ts')] },
      },
    });
  }

  function requestToolNames(index: number): string[] {
    return ((requests[index]?.tools ?? []) as Array<{ function: { name: string } }>).map((item) => item.function.name);
  }

  it('defers external MCP tools behind tool_search and loads them for the next step', async () => {
    scriptedToolCalls = [
      ['tool_search', '{"query":"echo value"}'],
      ['mcp__Fixture__echo_value', '{"value":"deferred"}'],
    ];
    const provider = fixtureProvider();
    const events = await collect(provider);

    expect(requests).toHaveLength(3);
    expect(requestToolNames(0)).toContain('tool_search');
    expect(requestToolNames(0)).not.toContain('mcp__Fixture__echo_value');
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '**Fixture** (3 tools, prefix `mcp__Fixture__`): echo_value, wait, image',
    );
    expect(requestToolNames(1)).toContain('mcp__Fixture__echo_value');
    expect(requestToolNames(1)).not.toContain('mcp__Fixture__wait');
    expect(JSON.stringify(requests[2]?.messages)).toContain('echo:deferred');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'mcp__Fixture__echo_value', status: 'completed' }),
      }),
    );

    // The loaded set is rebuilt from history on the next turn.
    const continuation = events.find((event) => event.type === 'init')!.continuation;
    await collect(provider, continuation);
    expect(requests).toHaveLength(4);
    expect(requestToolNames(3)).toContain('mcp__Fixture__echo_value');
    expect(requestToolNames(3)).not.toContain('mcp__Fixture__wait');
  });

  it('turns a direct call to an unloaded MCP tool into a tool_search load', async () => {
    scriptedToolCalls = [
      ['mcp__Fixture__echo_value', '{"value":"early"}'],
      ['mcp__Fixture__echo_value', '{"value":"retried"}'],
    ];
    const events = await collect(fixtureProvider());

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'tool_search', status: 'completed' }),
      }),
    );
    expect(JSON.stringify(requests[1]?.messages)).toContain('select:mcp__Fixture__echo_value');
    expect(requestToolNames(1)).toContain('mcp__Fixture__echo_value');
    expect(JSON.stringify(requests[2]?.messages)).toContain('echo:retried');
    expect(JSON.stringify(requests[2]?.messages)).not.toContain('echo:early');
  });

  it('indexes and progressively loads a group-local skill through the model tool loop', async () => {
    skillToolMode = true;
    const shared = path.join(root, 'shared-skills');
    const local = path.join(root, 'local-skills');
    fs.mkdirSync(path.join(local, 'local-guide'), { recursive: true });
    fs.writeFileSync(
      path.join(local, 'local-guide', 'SKILL.md'),
      '---\nname: local-guide\ndescription: Use the local workflow.\n---\n# Secret workflow\nReturn SKILL-LOADED.',
    );
    process.env.NATIVE_SHARED_SKILLS_ROOT = shared;
    process.env.NATIVE_LOCAL_SKILLS_ROOT = local;

    const events = await collect(new NativeProvider({ model: 'local/test-model' }));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({
          tool: 'skill',
          status: 'completed',
          title: 'Loaded skill',
          detail: 'local-guide',
        }),
      }),
    );
    expect(JSON.stringify(requests[0]?.messages)).toContain('**local-guide** (`local-guide`) — Use the local workflow.');
    expect(JSON.stringify(requests[1]?.messages)).toContain('Return SKILL-LOADED.');
  });

  it('keeps todo state across model steps but out of the next turn', async () => {
    todoToolMode = true;
    const provider = new NativeProvider({ model: 'local/test-model' });
    const first = await collect(provider);
    const continuation = (first.find((event) => event.type === 'init') as { continuation: string }).continuation;

    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'todowrite', status: 'completed' }),
      }),
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'todoread', status: 'completed' }),
      }),
    );
    expect(JSON.stringify(requests[2]?.messages)).toContain('turn-one-secret');

    todoToolMode = false;
    await collect(new NativeProvider({ model: 'local/test-model' }), continuation);
    expect(JSON.stringify(requests[3]?.messages)).not.toContain('turn-one-secret');
    expect((requests[3]?.tools as Array<{ function?: { name?: string } }>).some((item) => item.function?.name === 'todowrite')).toBe(true);
  });

  it('does not advertise todos when tools are disabled for a pushed turn', async () => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'hello', cwd: root });
    expect(query.push('without tools', undefined, { tools: 'disabled' })).toBe(true);
    query.end();
    for await (const _event of query.events) {
      // Drain both queued turns.
    }

    expect(JSON.stringify(requests[0]?.tools)).toContain('todowrite');
    expect(JSON.stringify(requests[0]?.messages)).toContain('## In-turn todos');
    expect(requests[1]?.tools).toBeUndefined();
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('## In-turn todos');
    expect(JSON.stringify(requests[0]?.messages)).toContain('## Turn budget');
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('## Turn budget');
  });

  it('requires todo initialization for explicitly multi-step work', async () => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'Perform this in three steps: inspect, edit, and test.', cwd: root });
    query.end();
    for await (const _event of query.events) {
      // Drain the turn.
    }

    expect(requests[0]?.tool_choice).toEqual({ type: 'function', function: { name: 'todowrite' } });
    const toolNames = (requests[0]?.tools as Array<{ function: { name: string } }>).map((item) => item.function.name);
    expect(toolNames).toEqual(['todowrite']);
    expect(JSON.stringify(requests[0]?.messages)).toContain('planning-only step');
  });

  it('sends and resumes image attachments through OpenAI-compatible Chat', async () => {
    const imagePath = path.join(root, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const attachment = [{ path: imagePath, mime: 'image/png', filename: 'pixel.png' }];
    const provider = new NativeProvider({ model: 'local/test-model' });
    const first = await collect(provider, undefined, attachment);
    const continuation = (first.find((event) => event.type === 'init') as { continuation: string }).continuation;

    expect(JSON.stringify(requests[0]?.messages)).toContain('data:image/png;base64,iVBORw==');
    await collect(new NativeProvider({ model: 'local/test-model' }), continuation);
    expect(JSON.stringify(requests[1]?.messages)).toContain('data:image/png;base64,iVBORw==');
  });

  it('encodes existing file types but omits audio bytes when custom endpoint capabilities are unknown', async () => {
    const files = [
      { path: path.join(root, 'document.pdf'), mime: 'application/pdf', filename: 'document.pdf' },
      { path: path.join(root, 'notes.txt'), mime: 'text/plain', filename: 'notes.txt' },
      { path: path.join(root, 'speech.mp3'), mime: 'audio/mpeg', filename: 'speech.mp3' },
      { path: path.join(root, 'clip.mp4'), mime: 'video/mp4', filename: 'clip.mp4' },
    ];
    fs.writeFileSync(files[0]!.path, Buffer.from([1, 2, 3]));
    fs.writeFileSync(files[1]!.path, 'hello document');
    fs.writeFileSync(files[2]!.path, Buffer.from([4, 5, 6]));
    fs.writeFileSync(files[3]!.path, Buffer.from([7, 8, 9]));

    await collect(new NativeProvider({ model: 'local/test-model' }), undefined, files);
    const body = JSON.stringify(requests[0]?.messages);
    expect(body).toContain('data:application/pdf;base64,AQID');
    expect(body).toContain('hello document');
    expect(body).not.toContain('input_audio');
    expect(body).toContain('data:video/mp4;base64,BwgJ');
  });

  it('encodes and replays native audio when the selected model declares audio input', async () => {
    const resolveModel = nativeCatalog.resolveNativeModel;
    const catalog = spyOn(nativeCatalog, 'resolveNativeModel').mockImplementation(async (id) => ({
      ...await resolveModel(id),
      inputModalities: ['text', 'audio'],
    }));
    const audio = spyOn(nativeAudio, 'prepareAudio').mockImplementation(async (file) => ({
      kind: 'inline', file: { ...file, mime: 'audio/mpeg' }, bytes: Buffer.from([4, 5, 6]),
      converted: false,
    }));
    try {
      const file = { path: path.join(root, 'speech.mp3'), mime: 'audio/mpeg', filename: 'speech.mp3' };
      fs.writeFileSync(file.path, Buffer.from([4, 5, 6]));
      const query = new NativeProvider({ model: 'local/audio-model' }).query({ prompt: 'listen', cwd: root, files: [file] });
      query.push('another voice note', [{ ...file, mime: 'audio/ogg', filename: 'voice.ogg' }]);
      query.end();
      const events: ProviderEvent[] = [];
      for await (const event of query.events) events.push(event);
      const init = events.find((event) => event.type === 'init');
      expect(init?.type).toBe('init');
      if (init?.type !== 'init') throw new Error('Missing continuation');
      await collect(new NativeProvider({ model: 'local/audio-model' }), init.continuation);
      for (const request of requests) {
        expect(JSON.stringify(request.messages)).toContain('"input_audio":{"data":"BAUG","format":"mp3"}');
      }
      expect(requests).toHaveLength(3);
      expect(audio).toHaveBeenCalledTimes(2);
    } finally {
      audio.mockRestore();
      catalog.mockRestore();
    }
  });

  describe.skipIf(!haveAudioTools)('real audio tools', () => {
    it('normalizes real Opus audio on initial and pushed turns, and replays without source files', async () => {
      catalogModels = { local: { models: { 'audio-model': { modalities: { input: ['text', 'audio'], output: ['text'] } } } } };
      const originalPath = path.join(root, 'voice.ogg');
      const fixture = Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1',
        '-c:a', 'libopus', originalPath]);
      expect(fixture.exitCode).toBe(0);
      const original = fs.readFileSync(originalPath);
      const prepareAudio = nativeAudio.prepareAudio;
      const tempDir = path.join(root, 'audio-temp');
      fs.mkdirSync(tempDir);
      const prepared: Array<Awaited<ReturnType<typeof prepareAudio>>> = [];
      const audio = spyOn(nativeAudio, 'prepareAudio').mockImplementation(async (file, options) => {
        const result = await prepareAudio(file, { ...options, tempDir });
        prepared.push(result);
        return result;
      });
      try {
        const file = { path: originalPath, filename: 'voice.ogg', mime: 'audio/ogg' };
        const query = new NativeProvider({ model: 'local/audio-model' }).query({ prompt: 'listen', cwd: root, files: [file] });
        query.push('listen again', [file]);
        query.end();
        let continuation: string | undefined;
        for await (const event of query.events) {
          expect(event.type).not.toBe('error');
          if (event.type === 'init') continuation = event.continuation;
        }
        expect(prepared).toMatchObject([
          { kind: 'inline', converted: true },
          { kind: 'inline', converted: true },
        ]);
        expect(fs.readFileSync(originalPath)).toEqual(original);
        const firstAudio = prepared[0];
        if (firstAudio?.kind !== 'inline') throw new Error('Expected real converted audio');
        expect(firstAudio.file.mime).toBe('audio/mpeg');
        expect(firstAudio.bytes.equals(original)).toBe(false);
        expect(continuation).toBeDefined();
        fs.unlinkSync(originalPath);
        expect(fs.readdirSync(tempDir)).toEqual([]);
        await collect(new NativeProvider({ model: 'local/audio-model' }), continuation);
        expect(requests).toHaveLength(3);
        for (const request of requests) {
          expect(JSON.stringify(request.messages)).toContain(JSON.stringify({
            input_audio: { data: firstAudio.bytes.toString('base64'), format: 'mp3' },
          }).slice(1, -1));
        }
        expect(prepared).toHaveLength(2);
      } finally {
        audio.mockRestore();
      }
    });
  });

  it('surfaces an audio rejection without retrying the turn as a file reference', async () => {
    rejectAudio = true;
    const catalog = spyOn(nativeCatalog, 'resolveNativeModel').mockResolvedValue({
      wireId: 'local/audio-model', providerId: 'local', modelId: 'audio-model',
      baseURL: process.env.NATIVE_BASE_URL!, protocol: 'openai-chat', inputModalities: ['text', 'audio'],
    });
    const audio = spyOn(nativeAudio, 'prepareAudio').mockImplementation(async (file) => ({
      kind: 'inline', file, bytes: Buffer.from([4, 5, 6]), converted: false,
    }));
    try {
      const events = await collect(new NativeProvider({ model: 'local/audio-model' }), undefined, [{
        path: '/voice.mp3', filename: 'voice.mp3', mime: 'audio/mpeg',
      }]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('Unsupported audio format') }));
      expect(requests).toHaveLength(1);
    } finally {
      audio.mockRestore();
      catalog.mockRestore();
    }
  });

  it('streams direct MiniMax over Anthropic Messages', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    const provider = new NativeProvider({ model: 'local/MiniMax-M3', modelParams: { max_tokens: 8192 } });
    const events = await collect(provider);

    expect(replyTexts(events)).toEqual([['hello from direct minimax']]);
    expect(new URL(requestUrls[0]!).pathname).toBe('/v1/messages');
    expect(requestHeaders[0]!.get('x-api-key')).toBe('placeholder');
    expect(requests[0]?.model).toBe('MiniMax-M3');
  });

  it('reports and prices MiniMax cache reads separately from uncached input', async () => {
    const catalog = spyOn(nativeCatalog, 'resolveNativeModel').mockResolvedValue({
      wireId: 'minimax/MiniMax-M3', providerId: 'minimax', modelId: 'MiniMax-M3',
      baseURL: process.env.NATIVE_BASE_URL!, protocol: 'anthropic-messages',
      inputCostPerMTok: 0.3, outputCostPerMTok: 1.2, cacheReadCostPerMTok: 0.06, cacheWriteCostPerMTok: 0.375,
    });
    try {
      const events = await collect(new NativeProvider({ model: 'minimax/MiniMax-M3', modelParams: { max_tokens: 8192 } }));
      const usage = { data: turnTotal(events)! };
      expect(usage.data).toMatchObject({
        input_tokens: 4,
        cache_read_tokens: 20,
        cache_write_tokens: 3,
        output_tokens: 5,
        context_tokens: 32,
      });
      expect(usage.data.cost_usd).toBeCloseTo((4 * 0.3 + 20 * 0.06 + 3 * 0.375 + 5 * 1.2) / 1_000_000, 12);
    } finally {
      catalog.mockRestore();
    }
  });

  it('sends and resumes image attachments through direct MiniMax Messages', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    const imagePath = path.join(root, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const attachment = [{ path: imagePath, mime: 'image/png', filename: 'pixel.png' }];
    const provider = new NativeProvider({ model: 'local/MiniMax-M3', modelParams: { max_tokens: 8192 } });
    const first = await collect(provider, undefined, attachment);
    const continuation = (first.find((event) => event.type === 'init') as { continuation: string }).continuation;

    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw=="}',
    );
    await collect(new NativeProvider({ model: 'local/MiniMax-M3', modelParams: { max_tokens: 8192 } }), continuation);
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      '"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw=="}',
    );
  });

  it('encodes PDF and text documents through Anthropic Messages', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    const files = [
      { path: path.join(root, 'document.pdf'), mime: 'application/pdf', filename: 'document.pdf' },
      { path: path.join(root, 'notes.txt'), mime: 'text/plain', filename: 'notes.txt' },
    ];
    fs.writeFileSync(files[0]!.path, Buffer.from([1, 2, 3]));
    fs.writeFileSync(files[1]!.path, 'hello document');

    await collect(
      new NativeProvider({ model: 'local/MiniMax-M3', modelParams: { max_tokens: 8192 } }),
      undefined,
      files,
    );
    const body = JSON.stringify(requests[0]?.messages);
    expect(body).toContain('"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"AQID"}');
    expect(body).toContain(
      '"type":"document","source":{"type":"text","media_type":"text/plain","data":"hello document"}',
    );
  });

  it('executes BananaClaw tools over direct MiniMax Messages', async () => {
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    anthropicToolMode = true;
    const provider = new NativeProvider({ model: 'local/MiniMax-M3', modelParams: { max_tokens: 8192 } });
    const events = await collect(provider);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'mcp__nanoclaw__send_message', status: 'completed' }),
      }),
    );
    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'chat'").get() as {
      content: string;
    };
    expect(JSON.parse(row.content).text).toBe('hello from direct tool');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain('tool_result');
  });
});

describe('final message', () => {
  const sendCall = (text: string): [string, string] => ['mcp__nanoclaw__send_message', JSON.stringify({ text })];
  const lastUserText = (request: Record<string, unknown>) =>
    JSON.stringify((request.messages as Array<{ role: string }>).filter((message) => message.role === 'user').at(-1));
  const systemText = (request: Record<string, unknown>) =>
    JSON.stringify(request.system ?? (request.messages as Array<{ role: string }>).filter((message) => message.role === 'system'));

  it.each(['openai-chat', 'anthropic-messages'])('reports the live step budget without persisting it (%s)', async (protocol) => {
    process.env.NATIVE_PROTOCOL = protocol;
    scriptedToolCalls = [sendCall('first update'), sendCall('second update')];
    const first = await collect(new NativeProvider({ model: 'local/test-model' }));
    const init = first.find((event) => event.type === 'init');
    if (!init) throw new Error('Missing native continuation');

    expect(requests).toHaveLength(3);
    for (let completed = 0; completed < requests.length; completed++) {
      const system = systemText(requests[completed]);
      expect(system).toContain(`at most ${MAX_STEPS} model steps`);
      expect(system).toContain('A step may contain multiple tool calls');
      expect(system).toContain('Reserve the last 10 steps');
      expect(system).toContain(
        `Step budget: ${completed} of ${MAX_STEPS} steps used; ${MAX_STEPS - completed} remain`,
      );
    }
    await collect(new NativeProvider({ model: 'local/test-model' }), init.continuation);
    expect(systemText(requests[3])).toContain(`Step budget: 0 of ${MAX_STEPS} steps used; ${MAX_STEPS} remain`);
    const store = new NativeStore();
    try {
      expect(JSON.stringify(store.contextMessages(init.continuation))).not.toContain('Step budget:');
    } finally { store.close(); }
  });

  it('delivers the final message but not text written alongside tool calls', async () => {
    scriptedToolCalls = [sendCall('mid-turn update')];
    toolCallText = 'Let me send that first.';
    scriptedTexts = ['All done.'];
    const events = await collect(new NativeProvider({ model: 'local/test-model' }));

    expect(replyTexts(events)).toEqual([['All done.']]);
    expect(events.find((event) => event.type === 'result')).not.toHaveProperty('silence');
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'no_reply' }) }),
    ]));
  });

  it('ends silently through no_reply and keeps it out of the activity trace', async () => {
    scriptedToolCalls = [['no_reply', '{"reason":"nothing new"}']];
    const events = await collect(new NativeProvider({ model: 'local/test-model' }));

    expect(requests).toHaveLength(1);
    expect(events.find((event) => event.type === 'result')).toMatchObject({ replies: [], silence: 'nothing new' });
    expect(events.some((event) => event.type === 'progress' && event.step.tool === 'no_reply')).toBe(false);
  });

  it('delivers a final message that points at undelivered text, without a retry', async () => {
    scriptedToolCalls = [sendCall('status')];
    toolCallText = 'Detailed findings. '.repeat(25);
    scriptedTexts = ['See my summary above.'];
    const events = await collect(new NativeProvider({ model: 'local/test-model' }));

    expect(requests).toHaveLength(2);
    expect(replyTexts(events)).toEqual([['See my summary above.']]);
  });

  it('asks for a final message without tools once the step limit is reached', async () => {
    scriptedToolCalls = Array.from({ length: MAX_STEPS }, (_, index) => sendCall(`update ${index}`));
    scriptedTexts = ['Progress so far.'];
    const events = await collect(new NativeProvider({ model: 'local/test-model' }));

    expect(requests).toHaveLength(MAX_STEPS + 1);
    expect(requests[MAX_STEPS - 1]?.tools).toBeDefined();
    expect(requests[MAX_STEPS]?.tools).toBeUndefined();
    expect(lastUserText(requests[MAX_STEPS]!)).toContain('step limit');
    for (let completed = 0; completed <= MAX_STEPS; completed++) {
      const system = systemText(requests[completed]);
      expect(system).toContain(
        `Step budget: ${completed} of ${MAX_STEPS} steps used; ${MAX_STEPS - completed} remain`,
      );
      expect(system.includes('Stop expanding scope')).toBe(completed >= MAX_STEPS - 10 && completed < MAX_STEPS);
    }
    expect(systemText(requests[MAX_STEPS])).toContain('Tools are now disabled');
    expect(replyTexts(events)).toEqual([['Progress so far.']]);
  }, 30_000);

  it('replaces a drafted final message when guidance arrives', async () => {
    scriptedTexts = ['draft answer', 'steered answer'];
    const query = new NativeProvider({ model: 'local/test-model' }).query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    let steered = false;
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'assistant_message' && !steered) steered = query.steer!({ id: 'g', prompt: 'guidance' });
      if (event.type === 'result') query.end();
    }

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain('draft answer');
    expect(replyTexts(events)).toEqual([['steered answer']]);
  });
});
