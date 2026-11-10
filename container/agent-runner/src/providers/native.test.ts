import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { APICallError, jsonSchema, tool } from 'ai';
import * as aiSdk from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { resetTurnSendTracking } from '../current-batch.js';
import { formatNativeToolStep, NativeProvider, portableHistory, userMessage } from './native.js';
import * as nativeCatalog from './native/catalog.js';
import * as nativeAudio from './native/audio.js';
import * as nativeTools from './native/tools.js';
import * as nativeAttachments from './native/attachments.js';
import { NativeStore } from './native/store.js';
import { mediaKeys } from './native/media-recovery.js';
import { NativeTurnJournal } from './native/turn-journal.js';
import { fingerprintToolInput, type ProviderEvent, type TurnUsage } from './types.js';
import { COMPACTION_INSTRUCTIONS } from './native/compaction.js';
import { accumulateCallUsage } from './usage.js';
import { beginTurn, recordCallUsage, settleTurn, turnUsage } from '../turn-execution.js';
import { offerUsageAdvisory, recordUsageAdvisory } from '../query/usage-advisory.js';

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
let realFetch: typeof globalThis.fetch;
let catalogModels: Record<string, unknown>;
let contextOverflows: number;
let overflowAfterTool: boolean;
let rejectCompaction: boolean;
type StubUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};
let scriptedUsage: StubUsage[];
let compactionUsage: StubUsage;
let scriptedCompactionTexts: string[];
let reasoningOnlyCompactions: number;
let rejectedMediaData: string[];
let mediaRejectionStatus: number;
let rejectMediaRetry: boolean;
let mediaRetryFailureStatus: number;
let apiFailures: Array<{ status: number; message: string; body?: unknown }>;

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
  realFetch = globalThis.fetch;
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
  scriptedCompactionTexts = [];
  reasoningOnlyCompactions = 0;
  rejectedMediaData = [];
  mediaRejectionStatus = 400;
  rejectMediaRetry = false;
  mediaRetryFailureStatus = 400;
  apiFailures = [];
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
      const failure = apiFailures.shift();
      if (failure) return Response.json(failure.body ?? {
        type: 'error', error: { type: 'rate_limit_error', message: failure.message },
      }, { status: failure.status });
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
      if (!isCompaction && rejectMediaRetry &&
          JSON.stringify(modelMessages).includes('Media unavailable to this model')) {
        return Response.json({ error: { message: 'Diagnostic retry failed', type: 'invalid_request_error' } }, { status: mediaRetryFailureStatus });
      }
      if (!isCompaction && rejectedMediaData.some(data => JSON.stringify(modelMessages).includes(data))) {
        return Response.json({ error: { message: 'Original media rejection', type: 'invalid_request_error' } }, { status: mediaRejectionStatus });
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
      const compactionText = isCompaction ? scriptedCompactionTexts.shift() : undefined;
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
                `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(compactionText ?? 'hello from direct minimax')}}}`,
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
            `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(isCompaction ? compactionText ?? 'Earlier work completed; continue pending requests without repeating tools.' : scriptedTexts.shift() ?? 'hello from stub')}},"finish_reason":null}]}`,
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

describe('native soft usage advisory', () => {
  async function run(threshold: number, stopBeforeAdvisory = false) {
    const turn = beginTurn({ channelType: 'web', platformId: 'chat-1', threadId: null, inReplyTo: null }, []);
    const query = new NativeProvider({ model: 'local/stub' }).query({ prompt: 'hello', cwd: root });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (stopBeforeAdvisory && event.type === 'model_request' && turn.usageAdvisory?.status === 'queued')
        query.abort('user');
      if (event.type === 'usage_call') {
        recordCallUsage(turn, event.data);
        offerUsageAdvisory(turn, query, threshold);
      } else if (event.type === 'usage_advisory') recordUsageAdvisory(turn, event);
    }
    return { turn, events };
  }

  it('uses shared accounting to inject one durable nudge after tools settle without replaying them', async () => {
    scriptedToolCalls = [
      ['bash', '{"command":"echo once >> once.txt"}'],
      ['read', '{"path":"once.txt"}'],
    ];
    const { turn, events } = await run(13);
    expect(requests).toHaveLength(3);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(JSON.stringify(requests[0].messages)).not.toContain('Turn usage advisory');
    expect(JSON.stringify(requests[1].messages)).toContain('13 reported tokens');
    expect(JSON.stringify(requests[1].messages)).toContain('wait for the user');
    expect(events.filter(event => event.type === 'usage_advisory')).toEqual([
      { type: 'usage_advisory', turnId: turn.turnId, status: 'applied', timestamp: expect.any(Number) },
    ]);
    expect(turnUsage(turn)?.reported_tokens).toBe(33);
    expect(turn.usageAdvisory).toMatchObject({ status: 'applied', reportedTokens: 13, threshold: 13 });
    const init = events.find(event => event.type === 'init');
    if (init?.type !== 'init') throw new Error('Missing native continuation');
    const store = new NativeStore();
    try {
      expect(store.messages(init.continuation).filter(message =>
        message.role === 'user' && JSON.stringify(message.content).includes('Turn usage advisory'))).toHaveLength(1);
      expect(store.appliedSteering(init.continuation, [turn.turnId])).toEqual([]);
    } finally { store.close(); }
  });

  it('skips guidance for an already final answer without another model generation', async () => {
    const { turn, events } = await run(7);
    expect(requests).toHaveLength(1);
    expect(replyTexts(events)).toEqual([['hello from stub']]);
    expect(turn.usageAdvisory).toMatchObject({ status: 'skipped', appliedAt: null });
  });

  it('does not claim application or start another call when cancelled at the advisory boundary', async () => {
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    const { turn, events } = await run(13, true);
    await settleTurn(turn, 'stopped');
    expect(requests).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(events.some(event => event.type === 'usage_advisory' && event.status === 'applied')).toBe(false);
    expect(turn.usageAdvisory).toMatchObject({ status: 'skipped', appliedAt: null });
  });

  it.each([{}, { prompt_tokens: 4 }, { completion_tokens: 3 }])(
    'does not turn missing provider usage %j into measured zero or inject guidance', async missing => {
    scriptedUsage = [missing];
    const { turn } = await run(1);
    expect(turnUsage(turn)?.reported_tokens).toBeUndefined();
    expect(turn.usageAdvisory).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('keeps measured zero distinct from absent measurements', async () => {
    scriptedUsage = [{ prompt_tokens: 0, completion_tokens: 0 }];
    const { turn } = await run(1);
    expect(turnUsage(turn)?.reported_tokens).toBe(0);
    expect(turn.usageAdvisory).toBeUndefined();
  });

  it('reports cached and reasoning tokens without double counting either bucket', async () => {
    scriptedUsage = [{
      prompt_tokens: 1000, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 10 },
    }];
    const { turn } = await run(2000);
    expect(turnUsage(turn)).toMatchObject({
      input_tokens: 200, cache_read_tokens: 800, output_tokens: 20, reasoning_tokens: 10, reported_tokens: 1020,
    });
  });
});

describe('NativeProvider', () => {
  it('calls the Groq default endpoint with the unprefixed model ID', async () => {
    delete process.env.NATIVE_BASE_URL;
    catalogModels = {
      groq: {
        npm: '@ai-sdk/groq',
        models: {
          'qwen/qwen3.8-27b': {
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    };
    catalogFetch.mockImplementation((input, init) => {
      if (String(input) === 'https://models.dev/api.json') return Promise.resolve(Response.json(catalogModels));
      expect(String(input)).toBe('https://api.groq.com/openai/v1/chat/completions');
      return realFetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, init);
    });
    toolMode = true;
    const events = await collect(new NativeProvider({ model: 'groq/qwen/qwen3.8-27b' }));
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(replyTexts(events).flat()).toEqual(['hello from stub']);
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.model).toBe('qwen/qwen3.8-27b');
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'uses the same default tool text on the %s wire and in canonical history', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      const text = 'literal "quoted" tool text\nsecond line';
      fs.writeFileSync(path.join(root, 'value.txt'), text);
      scriptedToolCalls = [['read', '{"path":"value.txt"}']];
      const events = await collect(new NativeProvider({ model: 'local/stub' }));
      const messages = requests[1].messages as Array<{
        role: string; content: string | Array<{ type: string; content?: unknown }>;
      }>;
      const wire = protocol === 'openai-chat' ? messages.find(message => message.role === 'tool')?.content :
        messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .find(part => part.type === 'tool_result')?.content;
      expect(wire).toBe(text);
      const init = events.find(event => event.type === 'init');
      if (init?.type !== 'init') throw new Error('Missing continuation');
      const store = new NativeStore();
      try {
        const result = store.messages(init.continuation).find(message => message.role === 'tool');
        expect(result).toMatchObject({ content: [{ output: { type: 'text', value: text } }] });
      } finally { store.close(); }
    },
  );

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'reports a native shell failure consistently through %s and preserves partial output', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      scriptedToolCalls = [['bash', '{"command":"printf partial; printf diagnostic >&2; exit 7"}']];
      const events = await collect(new NativeProvider({ model: 'local/stub' }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'progress', step: expect.objectContaining({ tool: 'bash', status: 'error', error: 'Command exited with 7' }),
      }));
      const history = JSON.stringify(requests[1].messages);
      expect(history).toContain('Command exited with 7');
      expect(history).toContain('partial');
      expect(history).toContain('diagnostic');
      expect(events.some(event => event.type === 'error')).toBe(false);
    },
  );

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'does not retry confirmed plan exhaustion through %s', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      apiFailures = Array.from({ length: 3 }, () => ({
        status: 429, message: 'The Token Plan usage limit has been reached. (2067)',
      }));
      const events = await collect(new NativeProvider({ model: 'local/stub' }));
      expect(requests).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'error', retryable: false, message: expect.stringContaining('Token Plan usage limit'),
      }));
    },
  );

  it('retains the SDK retry for an ordinary transient 429', async () => {
    apiFailures = [{ status: 429, message: 'Too many requests; retry shortly' }];
    const events = await collect(new NativeProvider({ model: 'local/stub' }));
    expect(requests).toHaveLength(2);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(replyTexts(events).flat()).toContain('hello from stub');
  }, 15_000);

  it('surfaces the structured upstream cause without dumping the response body', async () => {
    apiFailures = [{
      status: 400,
      message: 'Provider returned error',
      body: { error: { message: 'Provider returned error', code: 400, metadata: {
        provider_name: 'Google AI Studio',
        raw: JSON.stringify({ error: {
          code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT',
        }, request: 'PRIVATE_REQUEST' }),
      } }, user_id: 'PRIVATE_USER' },
    }];
    const events = await collect(new NativeProvider({ model: 'local/stub' }));
    expect(requests).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'error', retryable: false,
      message: 'Google AI Studio: Request contains an invalid argument. (HTTP 400)',
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });

  it.each([401, 403])('names the API host and credential action for HTTP %i', async status => {
    apiFailures = [{
      status, message: 'Unauthorized',
      body: { error: { message: 'Unauthorized' }, private: 'PRIVATE_RESPONSE' },
    }];
    const events = await collect(new NativeProvider({ model: 'local/stub' }));
    expect(requests).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'error', retryable: false,
      message: `Unauthorized (HTTP ${status} · ${new URL(requestUrls[0]).host}). Check Credentials and this agent's access.`,
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_RESPONSE');
  });

  it.each([
    undefined,
    {},
    { raw: 'PRIVATE_RAW_RESPONSE', provider_name: 'Upstream' },
    { raw: JSON.stringify({ request: 'PRIVATE_REQUEST' }), provider_name: 'Upstream' },
    ...[null, [], { error: null }, { error: { message: 42 } }, { error: { message: ' ' } }].map(
      raw => ({ raw: JSON.stringify(raw), provider_name: 'Upstream' }),
    ),
  ])('keeps generic errors actionable when metadata has no structured cause: %j', async metadata => {
    apiFailures = [{
      status: 400, message: 'Provider returned error',
      body: { error: { message: 'Provider returned error', code: 400, metadata } },
    }];
    const events = await collect(new NativeProvider({ model: 'local/stub' }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', retryable: false, message: expect.stringContaining('Provider returned error (HTTP 400)'),
    }));
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });

  it.each([429, 503])('surfaces a terminal HTTP %i after SDK retries are exhausted', async status => {
    apiFailures = Array.from({ length: 3 }, () => ({
      status, message: 'Provider returned error',
      body: { error: { message: 'Provider returned error', code: status, metadata: {
        provider_name: 'Google AI Studio',
        ...(status === 429 ? { limit_source: 'upstream_provider_shared_pool', raw: 'PRIVATE_RAW_RESPONSE' } : {}),
      } } },
    }));
    const events = await collect(new NativeProvider({ model: 'local/stub' }));
    expect(requests).toHaveLength(3);
    expect(events).toContainEqual({
      type: 'error', retryable: false,
      message: `Google AI Studio: Provider returned error (HTTP ${status})` +
        (status === 429 ? '. The free endpoint shared upstream pool is rate-limited; retry later or select another model.' : ''),
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  }, 15_000);

  it('bounds working results while preserving the complete canonical execution history', async () => {
    const complete = `start\n${'detail '.repeat(8000)}\nUNIQUE_END_OF_LARGE_RESULT`;
    fs.writeFileSync(path.join(root, 'large-result.txt'), complete);
    scriptedToolCalls = [['read', '{"path":"large-result.txt"}']];
    const events = await collect(new NativeProvider({ model: 'local/stub' }));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests.at(-1))).toContain('Abbreviated');
    expect(JSON.stringify(requests.at(-1))).not.toContain('UNIQUE_END_OF_LARGE_RESULT');
    const results = path.join(root, 'tool-results');
    const files = fs.readdirSync(results);
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(results, files[0]), 'utf8'))).toEqual({ type: 'text', value: complete });
    const init = events.find(event => event.type === 'init');
    if (init?.type !== 'init') throw new Error('Missing continuation');
    const store = new NativeStore();
    try {
      expect(JSON.stringify(store.messages(init.continuation))).toContain('UNIQUE_END_OF_LARGE_RESULT');
    } finally { store.close(); }
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'uses finished-turn receipts only on a later turn through %s, retaining full canonical execution', async (protocol) => {
      process.env.NATIVE_PROTOCOL = protocol;
      const marker = 'PREVIOUS_TURN_COMMAND '.repeat(200);
      scriptedToolCalls = [
        ['bash', JSON.stringify({ command: `printf completed # ${marker}` })],
        ['bash', '{"command":"printf diagnostic >&2; exit 7"}'],
      ];
      const first = await collect(new NativeProvider({ model: 'local/stub' }));
      const init = first.find(event => event.type === 'init');
      if (init?.type !== 'init') throw new Error('Missing continuation');
      expect(JSON.stringify(requests[2].messages)).toContain(marker);
      expect(JSON.stringify(requests[2].messages)).not.toContain('Finished-turn tool receipt');
      const answer = protocol === 'anthropic-messages' ? 'hello from direct minimax' : 'hello from stub';
      expect(replyTexts(first).flat()).toContain(answer);
      const store = new NativeStore();
      const original = store.messages(init.continuation);
      expect(JSON.stringify(original)).toContain(marker);
      try {
        await collect(new NativeProvider({ model: 'local/stub' }), init.continuation);
        const next = JSON.stringify(requests.at(-1)?.messages);
        expect(next).toContain('Finished-turn tool receipt');
        expect(next).not.toContain(marker);
        expect(next).toContain('Command exited with 7');
        expect(next).toContain(answer);
        expect(next).toContain('follow up');
        expect(store.messages(init.continuation).slice(0, original.length)).toEqual(original);
        expect(JSON.stringify(original)).not.toContain('Finished-turn tool receipt');
      } finally { store.close(); }
    },
  );

  it('projects only after a result boundary in a warm query without repeating the completed command', async () => {
    const marker = 'WARM_QUERY_COMMAND '.repeat(200);
    scriptedToolCalls = [['bash', JSON.stringify({ command: `echo once >> ran.txt # ${marker}` })]];
    const query = new NativeProvider({ model: 'local/stub' }).query({ prompt: 'first input', cwd: root });
    expect(query.push('next input')).toBe(true);
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1].messages)).toContain(marker);
    expect(JSON.stringify(requests[2].messages)).not.toContain(marker);
    expect(JSON.stringify(requests[2].messages)).toContain('Finished-turn tool receipt');
    expect(events.filter(event => event.type === 'result')).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, 'ran.txt'), 'utf8')).toBe('once\n');
  });

  it('keeps canonical details when the consumer closes at an unacknowledged result', async () => {
    const marker = 'UNACKNOWLEDGED_COMMAND '.repeat(200);
    scriptedToolCalls = [['bash', JSON.stringify({ command: `printf completed # ${marker}` })]];
    const query = new NativeProvider({ model: 'local/stub' }).query({ prompt: 'first input', cwd: root });
    query.end();
    let continuation: string | undefined;
    for await (const event of query.events) {
      if (event.type === 'init') continuation = event.continuation;
      if (event.type === 'result') break;
    }
    if (!continuation) throw new Error('Missing continuation');
    const store = new NativeStore();
    try { expect(store.contextEntries(continuation).some(entry => entry.finished)).toBe(false); }
    finally { store.close(); }
    await collect(new NativeProvider({ model: 'local/stub' }), continuation);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(marker);
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Finished-turn tool receipt');
  });

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

  const rejectedBytes = Buffer.from('opaque rejected attachment').toString('base64');
  function rejectedHistory(mime = 'image/png', earlier = false): string {
    rejectedMediaData = [rejectedBytes];
    const store = new NativeStore();
    const continuation = store.createConversation();
    if (earlier) store.append(continuation, Array.from({ length: 5 }, () => [
      { role: 'user' as const, content: 'Earlier requirements '.repeat(100) },
      { role: 'assistant' as const, content: 'Earlier completed work '.repeat(100) },
    ]).flat());
    store.append(continuation, [{ role: 'user', content: [
      { type: 'text', text: 'Inspect the attachment' },
      { type: 'file', mediaType: mime, data: rejectedBytes },
    ] }]);
    store.close();
    return continuation;
  }

  it.each([
    ['openai-chat', 'image/png'], ['openai-chat', 'image/jpeg'], ['openai-chat', 'application/pdf'],
    ['openai-chat', 'audio/wav'], ['openai-chat', 'video/mp4'],
    ['anthropic-messages', 'image/png'], ['anthropic-messages', 'application/pdf'],
  ] as const)(
    'recovers %s/%s rejection once, preserving history and provider-scoped quarantines across resume',
    async (protocol, mime) => {
      const provider = vision(protocol);
      const continuation = rejectedHistory(mime);
      const events = await collect(provider, continuation);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0].messages)).toContain(rejectedBytes);
      expect(JSON.stringify(requests[1].messages)).not.toContain(rejectedBytes);
      expect(JSON.stringify(requests[1].messages)).toContain('Media unavailable to this model');
      expect(events.some(event => event.type === 'progress' && event.step.kind === 'notification' &&
        event.step.text.includes('retry succeeded'))).toBe(true);
      const resumed = await collect(new NativeProvider({ model: 'local/vision-model' }), continuation);
      expect(resumed.some(event => event.type === 'error')).toBe(false);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2].messages)).not.toContain(rejectedBytes);
      const switched = await collect(new NativeProvider({ model: 'local/other-model' }), continuation);
      expect(switched.some(event => event.type === 'error')).toBe(false);
      expect(requests).toHaveLength(5);
      expect(JSON.stringify(requests[3].messages)).toContain(rejectedBytes);
      const store = new NativeStore();
      expect(JSON.stringify(store.messages(continuation)[0])).toContain(rejectedBytes);
      store.close();
    },
  );

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'does not replay completed tools or discard other content during %s media recovery',
    async (protocol) => {
      const provider = vision(protocol);
      let executions = 0;
      const tools = spyOn(nativeTools, 'createNativeTools').mockImplementation(() => ({
        produce_media: tool({
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: async () => { executions++; return 'completed action'; },
          toModelOutput: () => ({ type: 'content', value: [
            { type: 'text', text: 'Other completed work' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: rejectedBytes } },
          ] }),
        }),
      }));
      rejectedMediaData = [rejectedBytes];
      scriptedToolCalls = [['produce_media', '{}']];
      try {
        const events = await collect(provider);
        expect(events.some(event => event.type === 'error')).toBe(false);
        expect(executions).toBe(1);
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[2].messages)).toContain('Other completed work');
        expect(JSON.stringify(requests[2].messages)).toContain(png);
        expect(JSON.stringify(requests[2].messages)).not.toContain(rejectedBytes);
      } finally { tools.mockRestore(); }
    },
  );

  it.each([400, 429, 503])('surfaces the original rejection after retry status %i without SDK retries or a quarantine', async status => {
    const provider = vision('openai-chat');
    const continuation = rejectedHistory();
    rejectMediaRetry = true;
    mediaRetryFailureStatus = status;
    const quarantine = spyOn(NativeStore.prototype, 'quarantineMedia');
    try {
      const events = await collect(provider, continuation);
      expect(requests).toHaveLength(2);
      expect(events.some(event => event.type === 'error' && event.message === 'Original media rejection')).toBe(true);
      expect(events.some(event => event.type === 'progress' && event.step.kind === 'notification' &&
        event.step.detail === 'Diagnostic retry failed')).toBe(true);
      expect(quarantine).not.toHaveBeenCalled();
    } finally { quarantine.mockRestore(); }
  });

  it('does not attempt media recovery for a parameter rejection without media', async () => {
    const provider = vision('openai-chat');
    const store = new NativeStore();
    const continuation = store.createConversation();
    store.append(continuation, [{ role: 'user', content: rejectedBytes }]);
    store.close();
    rejectedMediaData = [rejectedBytes];
    const events = await collect(provider, continuation);
    expect(requests).toHaveLength(1);
    expect(events.some(event => event.type === 'error' && event.message === 'Original media rejection')).toBe(true);
  });

  it('does not discard media already accepted in an earlier successful model step', async () => {
    const provider = vision('openai-chat');
    const continuation = rejectedHistory();
    rejectedMediaData = [];
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    const query = provider.query({ prompt: 'follow up', continuation, cwd: root });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'progress' && event.step.tool === 'bash' && event.step.status === 'completed')
        rejectedMediaData = [rejectedBytes];
    }
    expect(requests).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.some(event => event.type === 'progress' && event.step.kind === 'notification' &&
      event.step.text.includes('retrying once'))).toBe(false);
  });

  it('caps media rejection recovery at one diagnostic attempt for the entire turn', async () => {
    const provider = vision('openai-chat');
    const secondBytes = Buffer.from('different rejected attachment').toString('base64');
    let executions = 0;
    const tools = spyOn(nativeTools, 'createNativeTools').mockImplementation(() => ({
      produce_media: tool({
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => ++executions,
        toModelOutput: ({ output }) => ({ type: 'content', value: [
          { type: 'file', mediaType: 'image/png', data: {
            type: 'data', data: output === 1 ? rejectedBytes : secondBytes,
          } },
        ] }),
      }),
    }));
    rejectedMediaData = [rejectedBytes, secondBytes];
    scriptedToolCalls = [['produce_media', '{}'], ['produce_media', '{}']];
    try {
      const events = await collect(provider);
      expect(executions).toBe(2);
      expect(requests).toHaveLength(4);
      expect(events.some(event => event.type === 'error')).toBe(true);
      expect(events.filter(event => event.type === 'progress' && event.step.kind === 'notification' &&
        event.step.text.includes('retrying once'))).toHaveLength(1);
    } finally { tools.mockRestore(); }
  });

  it('excludes quarantined bytes from the exact inline-media budget before preparing new attachments', async () => {
    const provider = vision('openai-chat');
    const model = await nativeCatalog.resolveNativeModel('local/vision-model');
    const scope = JSON.stringify([model.providerId, model.modelId, model.baseURL, model.protocol]);
    const store = new NativeStore();
    const continuation = store.createConversation();
    const huge: ModelMessage = { role: 'user', content: [
      { type: 'file', mediaType: 'image/png', data: 'A'.repeat(nativeAttachments.MAX_INLINE_BYTES) },
    ] };
    store.append(continuation, [huge]);
    const confirmed = store.append(continuation, [{ role: 'assistant', content: 'Previous diagnostic succeeded' }]);
    store.quarantineMedia(continuation, scope, mediaKeys([huge])[0], confirmed, 'Previous rejection');
    store.close();
    fs.writeFileSync(path.join(root, 'new.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const events = await collect(provider, continuation, [
      { path: path.join(root, 'new.png'), mime: 'image/png', filename: 'new.png' },
    ]);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].messages)).toContain('data:image/png;base64,iVBORw==');
    expect(events.some(event => event.type === 'progress' && event.step.kind === 'compaction')).toBe(false);
  });

  it('does not recover authentication failures even when unconfirmed media exists', async () => {
    const provider = vision('openai-chat');
    const continuation = rejectedHistory();
    mediaRejectionStatus = 401;
    const events = await collect(provider, continuation);
    expect(requests).toHaveLength(1);
    expect(events.some(event => event.type === 'error')).toBe(true);
  });

  it.each(['text', 'reasoning', 'tool-input'])('does not recover after partial %s output', async kind => {
    const provider = vision('openai-chat');
    const continuation = rejectedHistory();
    const error = new APICallError({ message: 'Original media rejection', url: 'http://stub',
      requestBodyValues: {}, statusCode: 400, isRetryable: false,
      responseBody: '{"error":{"type":"invalid_request_error"}}' });
    const mock = new MockLanguageModelV4({ doStream: async () => ({
      warnings: [], stream: new ReadableStream({ start(controller) {
        if (kind === 'tool-input') {
          controller.enqueue({ type: 'tool-input-start', id: 'partial', toolName: 'bash' });
          controller.enqueue({ type: 'tool-input-delta', id: 'partial', delta: '{"command":' });
        } else {
          controller.enqueue({ type: `${kind}-start`, id: 'partial' });
          controller.enqueue({ type: `${kind}-delta`, id: 'partial', delta: 'Already emitted' });
        }
        controller.enqueue({ type: 'error', error });
        controller.close();
      } }),
    }) });
    const streamText = aiSdk.streamText;
    const stream = spyOn(aiSdk, 'streamText').mockImplementation(options => streamText({ ...options, model: mock }));
    try {
      const events = await collect(provider, continuation);
      expect(events.some(event => event.type === 'error' && event.message === error.message)).toBe(true);
      expect(mock.doStreamCalls).toHaveLength(1);
    } finally { stream.mockRestore(); }
  });

  it('does not retry when a tool execution was journaled before the failed call emitted stream output', async () => {
    const provider = vision('openai-chat');
    const continuation = rejectedHistory();
    let executions = 0;
    let wrapped: ReturnType<NativeTurnJournal['wrap']> | undefined;
    const tools = spyOn(nativeTools, 'createNativeTools').mockImplementation(() => ({
      side_effect: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => { executions++; return 'completed'; } }),
    }));
    const wrap = NativeTurnJournal.prototype.wrap;
    const capture = spyOn(NativeTurnJournal.prototype, 'wrap').mockImplementation(function (this: NativeTurnJournal, ...args) {
      return (wrapped = wrap.apply(this, args));
    });
    const error = new APICallError({ message: 'Original media rejection', url: 'http://stub',
      requestBodyValues: {}, statusCode: 400, isRetryable: false,
      responseBody: '{"error":{"type":"invalid_request_error"}}' });
    const mock = new MockLanguageModelV4({ doStream: async () => {
      if (!wrapped?.side_effect.execute) throw new Error('Missing journaled tool');
      await wrapped.side_effect.execute({}, { toolCallId: 'started', messages: [] });
      throw error;
    } });
    const streamText = aiSdk.streamText;
    const stream = spyOn(aiSdk, 'streamText').mockImplementation(options => streamText({ ...options, model: mock }));
    try {
      const events = await collect(provider, continuation);
      expect(events.some(event => event.type === 'error' && event.message === error.message)).toBe(true);
      expect(executions).toBe(1);
      expect(mock.doStreamCalls).toHaveLength(1);
    } finally { stream.mockRestore(); capture.mockRestore(); tools.mockRestore(); }
  });

  it('honors Stop before a media-free retry without confirming a quarantine', async () => {
    const provider = vision('openai-chat');
    const query = provider.query({ prompt: 'follow up', continuation: rejectedHistory(), cwd: root });
    query.end();
    const quarantine = spyOn(NativeStore.prototype, 'quarantineMedia');
    try {
      for await (const event of query.events) {
        if (event.type === 'progress' && event.step.kind === 'notification' &&
            event.step.text.includes('retrying once')) query.abort('user');
      }
      expect(requests).toHaveLength(1);
      expect(quarantine).not.toHaveBeenCalled();
    } finally { quarantine.mockRestore(); }
  });

  it('reapplies media quarantines after proactive compaction reloads original retained media', async () => {
    const provider = vision('anthropic-messages');
    catalogModels = { local: { models: { 'vision-model': {
      modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1_000_000 },
    } } } };
    const continuation = rejectedHistory('image/png', true);
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
    const events = await collect(provider, continuation);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.some(event => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'completed')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(rejectedBytes);
    const store = new NativeStore();
    expect(JSON.stringify(store.contextMessages(continuation))).toContain(rejectedBytes);
    store.close();
  });

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

  // TODO: Re-enable media-budget recovery tests once Bun timeouts reliably stop them.
  it.skip('recovers PDF tool media pressure without replaying completed actions', async () => {
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

  // Large-payload recovery tests below share the same timeout issue.
  it.skip('reports protected media that cannot be compacted instead of silently dropping it', async () => {
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

  it.skip.each(['openai-chat', 'anthropic-messages'] as const)(
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

  it.skip.each(['openai-chat', 'anthropic-messages'] as const)(
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

  it.skip('surfaces media compaction failure without retrying tool side effects', async () => {
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

  it.skip('bounds recovery when the protected current image occupies the whole budget', async () => {
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

  it.skip('shares the two recovery attempts between media and token pressure', async () => {
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

  it.skip('compacts oversized tool-media history before sending the next model request', async () => {
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

  it.skip.each([false, true])('prepares media steering after compaction, preserving acknowledgement ordering (abort=%s)', async (abort) => {
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

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'starts a fresh 262K-context/output model through %s without compaction', async protocol => {
      process.env.NATIVE_PROTOCOL = protocol;
      catalogModels = { local: { models: {
        small: { modalities: { input: ['text'], output: ['text'] }, limit: { context: 262_144, output: 262_144 } },
      } } };
      const query = new NativeProvider({ model: 'local/small' }).query({
        prompt: 'First message', cwd: root, systemContext: { instructions: 's'.repeat(90_597) },
      });
      query.end();
      const events: ProviderEvent[] = [];
      for await (const event of query.events) events.push(event);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(compactions(events, 'running')).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].max_tokens).toBe(32_768);
      expect(replyTexts(events)).toEqual([[protocol === 'anthropic-messages' ? 'hello from direct minimax' : 'hello from stub']]);
    },
  );

  it.each([
    ['catalog output', 1_000_000, 8192, 8192],
    ['context quarter', 100_000, 100_000, 25_000],
    ['unknown context', undefined, 64_000, 32_768],
    ['unknown output', 262_144, undefined, 32_768],
    ['unknown limits', undefined, undefined, 32_768],
  ] as const)('bounds the default output allowance for %s', async (_name, context, output, expected) => {
    catalogModels = { local: { models: {
      'test-model': { modalities: { input: ['text'], output: ['text'] }, limit: { context, output } },
    } } };
    const events = await collect(new NativeProvider({ model: 'local/test-model' }));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(compactions(events, 'running')).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].max_tokens).toBe(expected);
  });

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'preserves an explicit output allowance above the default through %s', async protocol => {
      process.env.NATIVE_PROTOCOL = protocol;
      catalogModels = { local: { models: {
        small: { modalities: { input: ['text'], output: ['text'] }, limit: { context: 262_144, output: 262_144 } },
      } } };
      const events = await collect(new NativeProvider({ model: 'local/small', modelParams: { max_tokens: 65_536 } }));
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(compactions(events, 'running')).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].max_tokens).toBe(65_536);
    },
  );

  it.each([
    ['whole context', 262_144, 'Short instructions'],
    ['fixed instructions', 200_000, 's'.repeat(90_597)],
  ] as const)('rejects an explicit output allowance that conflicts with %s without compaction or transcript loss', async (_name, output, instructions) => {
    catalogModels = { local: { models: {
      small: { modalities: { input: ['text'], output: ['text'] }, limit: { context: 262_144, output: 262_144 } },
    } } };
    const continuation = history();
    const store = new NativeStore();
    const original = store.messages(continuation);
    store.close();
    const query = new NativeProvider({ model: 'local/small', modelParams: { max_tokens: output } }).query({
      prompt: 'Keep this pending request', continuation, cwd: root, systemContext: { instructions },
    });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', retryable: false, message: expect.stringContaining('reduce max_tokens'),
    }));
    expect(compactions(events, 'running')).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(events.filter(event => event.type === 'usage_call')).toHaveLength(0);
    const reopened = new NativeStore();
    try {
      expect(reopened.messages(continuation)).toEqual([...original, { role: 'user', content: 'Keep this pending request' }]);
      expect(reopened.contextMessages(continuation)).toEqual(reopened.messages(continuation));
    } finally { reopened.close(); }
  });

  function preflightContext() {
    catalogModels = { local: { models: {
      large: { modalities: { input: ['text'], output: ['text'] }, limit: { context: 1_000_000, output: 524_288 } },
      small: { modalities: { input: ['text'], output: ['text'] }, limit: { context: 262_144, output: 262_144 } },
    } } };
    const continuation = history();
    const store = new NativeStore();
    try {
      store.updateMessage(continuation, store.contextEntries(continuation)[0].ref!, {
        role: 'user', content: 'Earlier requirements '.repeat(16_000),
      });
    } finally { store.close(); }
    return continuation;
  }

  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'preflights a 1M-to-262K model switch before sending the long history through %s', async protocol => {
      process.env.NATIVE_PROTOCOL = protocol;
      const continuation = preflightContext();
      const large = await collect(new NativeProvider({ model: 'local/large' }), continuation);
      expect(compactions(large, 'running')).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].max_tokens).toBe(32_768);
      requests.length = 0;
      const small = new NativeProvider({ model: 'local/small' });
      const events = await collect(small, continuation);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(compactions(events, 'completed')).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain(COMPACTION_INSTRUCTIONS);
      const normal = requests.filter(request => !JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS));
      expect(normal).toHaveLength(1);
      expect(normal[0].max_tokens).toBe(32_768);
      expect(Buffer.byteLength(JSON.stringify(normal[0])) + 32768 + 1024).toBeLessThan(262_144);
      expect(JSON.stringify(normal[0].messages)).toContain('follow up');
      expect(replyTexts(events)).toEqual([[protocol === 'anthropic-messages' ? 'hello from direct minimax' : 'hello from stub']]);
      expect(events.filter(event => event.type === 'usage_call')).toHaveLength(requests.length);
      const store = new NativeStore();
      try {
        expect(JSON.stringify(store.messages(continuation))).toContain('Earlier requirements '.repeat(16_000));
        expect(JSON.stringify(store.contextMessages(continuation))).not.toContain('Earlier requirements '.repeat(16_000));
      } finally { store.close(); }
      const resumed = await collect(new NativeProvider({ model: 'local/small' }), continuation);
      expect(resumed.some(event => event.type === 'error')).toBe(false);
      expect(compactions(resumed, 'running')).toHaveLength(0);
    },
  );

  it('preflights existing history after a same-model container restart without prior usage', async () => {
    const continuation = preflightContext();
    const events = await collect(new NativeProvider({ model: 'local/small' }), continuation);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(compactions(events, 'completed')).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(COMPACTION_INSTRUCTIONS);
  });

  it.each(['input', 'instructions', 'schema'] as const)(
    'fails an irreducible oversized %s without sending a normal request or losing input', async component => {
      preflightContext();
      const huge = 'x'.repeat(300_000);
      const fixture = component === 'schema' ? spyOn(nativeTools, 'createNativeTools').mockImplementation(() => ({
        huge: tool({ description: huge, inputSchema: jsonSchema({ type: 'object', properties: {} }) }),
      })) : undefined;
      try {
        const prompt = component === 'input' ? huge : 'Keep this pending request';
        const provider = new NativeProvider({ model: 'local/small' });
        const query = provider.query({
          prompt, cwd: root,
          ...(component === 'instructions' ? { systemContext: { instructions: huge } } : {}),
        });
        query.end();
        const events: ProviderEvent[] = [];
        for await (const event of query.events) events.push(event);
        expect(requests).toHaveLength(0);
        expect(events.filter(event => event.type === 'usage_call')).toHaveLength(0);
        expect(events).toContainEqual(expect.objectContaining({
          type: 'error', retryable: false, message: expect.stringContaining('cannot be compacted'),
        }));
        const init = events.find(event => event.type === 'init');
        if (init?.type !== 'init') throw new Error('Missing continuation');
        const store = new NativeStore();
        try { expect(store.messages(init.continuation)).toEqual([{ role: 'user', content: prompt }]); }
        finally { store.close(); }
      } finally { fixture?.mockRestore(); }
    },
  );

  it('preserves the transcript when preflight summarization fails instead of sending the oversized request', async () => {
    const continuation = preflightContext();
    const store = new NativeStore();
    const original = store.contextMessages(continuation);
    store.close();
    rejectCompaction = true;
    const events = await collect(new NativeProvider({ model: 'local/small' }), continuation);
    expect(compactions(events, 'error')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', message: expect.stringContaining('Summary service rejected'),
    }));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS))).toBe(true);
    const reopened = new NativeStore();
    try { expect(reopened.contextMessages(continuation).slice(0, original.length)).toEqual(original); }
    finally { reopened.close(); }
  });

  it('does not compact an unrelated generic HTTP 400 when preflight fits', async () => {
    const provider = knownContext();
    apiFailures = [{
      status: 400, message: 'Provider returned error',
      body: { error: { message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio',
        raw: '{"error":{"message":"Request contains an invalid argument."}}' } } },
    }];
    const events = await collect(provider, history());
    expect(compactions(events, 'running')).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', message: 'Google AI Studio: Request contains an invalid argument. (HTTP 400)',
    }));
  });

  it('does not replay a completed tool when the next request schema exceeds the context budget', async () => {
    preflightContext();
    let executions = 0;
    const fixture = spyOn(nativeTools, 'createNativeTools').mockImplementation(() => ({
      once: tool({
        description: executions ? 'd'.repeat(300_000) : 'Perform the action once',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => {
          executions++;
          fs.appendFileSync(path.join(root, 'once.txt'), 'once\n');
          return 'Action completed';
        },
      }),
    }));
    try {
      scriptedToolCalls = [['once', '{}']];
      const continuation = history();
      const events = await collect(new NativeProvider({ model: 'local/small' }), continuation);
      expect(executions).toBe(1);
      expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
      expect(requests.filter(request => !JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS))).toHaveLength(1);
      expect(compactions(events, 'running').length).toBeLessThanOrEqual(2);
      expect(events.some(event => event.type === 'error')).toBe(true);
      const store = new NativeStore();
      try {
        expect(JSON.stringify(store.messages(continuation))).toContain('Action completed');
        expect(JSON.stringify(store.contextMessages(continuation))).toContain('follow up');
      } finally { store.close(); }
    } finally { fixture.mockRestore(); }
  });

  it('can stop preflight compaction before any provider call while preserving the original transcript', async () => {
    const continuation = preflightContext();
    const query = new NativeProvider({ model: 'local/small' }).query({
      prompt: 'Current protected input', continuation, cwd: root,
    });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'progress' && event.step.kind === 'compaction' && event.step.status === 'running')
        query.abort('user');
    }
    expect(requests).toHaveLength(0);
    expect(events.some(event => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'interrupted')).toBe(true);
    const store = new NativeStore();
    try {
      expect(JSON.stringify(store.contextMessages(continuation))).toContain('Earlier requirements '.repeat(16_000));
      expect(JSON.stringify(store.contextMessages(continuation))).toContain('Current protected input');
    } finally { store.close(); }
  });

  function miniMaxFlash(maxOutputTokens = 512_000, modelId = 'MiniMax-M3.1-Flash-Preview') {
    catalogModels = { local: { models: { [modelId]: {
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1_000_000, output: maxOutputTokens },
    } } } };
    return new NativeProvider({ model: `local/${modelId}` });
  }

  it.each([
    ['openai-chat', 'MiniMax-M3.1-Flash-Preview'], ['anthropic-messages', 'MiniMax-M3.1-Flash-Preview'],
    ['openai-chat', 'MiniMax-M3.1-Flash'], ['anthropic-messages', 'MiniMax-M3.1-Flash'],
  ] as const)(
    'recovers a reasoning-only MiniMax compaction through %s/%s without duplicate billing', async (protocol, modelId) => {
      process.env.NATIVE_PROTOCOL = protocol;
      contextOverflows = 1;
      reasoningOnlyCompactions = 1;
      const events = await collect(miniMaxFlash(512_000, modelId), history());
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

  it.each([
    ['openai-chat', false], ['anthropic-messages', false],
    ['openai-chat', true], ['anthropic-messages', true],
  ] as const)(
    'recovers an oversized summary through %s with reasoning=%s and accounts for both attempts exactly once', async (protocol, reasoning) => {
      process.env.NATIVE_PROTOCOL = protocol;
      contextOverflows = 1;
      scriptedCompactionTexts = ['x'.repeat(32_001), 'Earlier work completed; continue pending requests.'];
      const continuation = history();
      const events = await collect(reasoning ? miniMaxFlash() : knownContext(), continuation);
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(compactions(events, 'completed')).toHaveLength(1);
      expect(compactions(events, 'error')).toHaveLength(0);
      const summaries = requests.filter(request => JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS));
      expect(summaries.map(request => request.max_tokens)).toEqual(reasoning ? [16_000, 16_000] : [8000, 8000]);
      expect(JSON.stringify(summaries[1].messages)).toContain('The previous summary exceeded');
      expect(JSON.stringify(summaries[1].messages)).toContain('x'.repeat(32_001));
      expect(JSON.stringify(summaries[1].messages)).not.toContain('Earlier requirements '.repeat(250));
      expect(events.filter(event => event.type === 'usage_call')).toHaveLength(3);
      expect(turnTotal(events)?.num_turns).toBe(3);
      expect(replyTexts(events)).toEqual([[protocol === 'anthropic-messages' ? 'hello from direct minimax' : 'hello from stub']]);
      const store = new NativeStore();
      try {
        expect(JSON.stringify(store.messages(continuation))).toContain('Earlier requirements '.repeat(250));
        expect(JSON.stringify(store.contextMessages(continuation))).toContain('Earlier work completed; continue pending requests.');
        expect(JSON.stringify(store.contextMessages(continuation))).not.toContain('x'.repeat(32_001));
      } finally { store.close(); }
    },
  );

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

  it.each([100_000, 749_999])('does not compact a 1M-token window at %s context tokens', async (contextTokens) => {
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: contextTokens - 2, completion_tokens: 2 }];
    const events = await collect(knownContext(), history());
    expect(compactions(events, 'running')).toHaveLength(0);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Earlier requirements '.repeat(250));
  });

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

  it('surfaces a proactive failure without continuing costly calls or repeating completed actions', async () => {
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
    expect(events.some((event) => event.type === 'error' && event.message.includes('Summary service rejected'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'once.txt'), 'utf8')).toBe('once\n');
    expect(requests).toHaveLength(2);
    rejectCompaction = false;
    scriptedToolCalls = [];
    contextOverflows = 1;
    const recovered = await collect(provider, continuation);
    expect(compactions(recovered, 'completed')).toHaveLength(1);
    expect(recovered.some((event) => event.type === 'error')).toBe(false);
  });

  it('allows more than two proactive compactions in one task', async () => {
    const provider = knownContext();
    scriptedToolCalls = Array.from({ length: 4 }, () => ['bash', '{"command":"echo once >> once.txt"}']);
    scriptedUsage = Array.from({ length: 4 }, () => ({ prompt_tokens: 800_000, completion_tokens: 2 }));
    const events = await collect(provider, history());
    expect(compactions(events, 'completed')).toHaveLength(4);
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

  it('reports the specific blocker when protected or recent history cannot be compacted', async () => {
    const provider = knownContext();
    scriptedToolCalls = [['bash', '{"command":"echo once >> once.txt"}']];
    scriptedUsage = [{ prompt_tokens: 749_998, completion_tokens: 2 }];
    const events = await collect(provider);
    expect(compactions(events, 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error' && event.message.includes('cannot be compacted'))).toBe(true);
    expect(replyTexts(events)).toEqual([]);
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

  it('accepts steering past 100 model steps and stops only when the caller ends the query', async () => {
    const provider = new NativeProvider({ model: 'local/test-model' });
    const query = provider.query({ prompt: 'original', cwd: root });
    const events: ProviderEvent[] = [];
    let boundary = 0;
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'assistant_message') {
        if (++boundary <= 105) query.steer!({ id: `s${boundary}`, prompt: `guidance ${boundary}` });
        else query.end();
      }
      if (event.type === 'result') query.end();
    }
    expect(requests).toHaveLength(106);
    expect(events.filter((event) => event.type === 'steering_applied')).toHaveLength(105);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(turnTotal(events)).toMatchObject({ num_turns: 106, input_tokens: 4 * 106 });
    const continuation = events.find((event) => event.type === 'init')!.continuation;
    expect(provider.appliedSteering(continuation, ['s100', 's105', 's106'])).toEqual(['s100', 's105']);
  }, 30_000);

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

  it.each(['never', false] as const)('discovers and executes a configured external MCP tool with %s', async (mode) => {
    externalMcpToolMode = true;
    const fixture = path.join(import.meta.dir, 'native', 'test-fixtures', 'stdio-mcp.ts');
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    const provider = new NativeProvider({
      model: 'local/test-model',
      modelParams: { mcp_tool_search: mode },
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

  function fixtureProvider(): NativeProvider {
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    return new NativeProvider({
      model: 'local/test-model',
      mcpServers: {
        Fixture: { command: bun, args: ['run', path.join(import.meta.dir, 'native', 'test-fixtures', 'stdio-mcp.ts')] },
      },
    });
  }

  function requestToolNames(index: number): string[] {
    return ((requests[index]?.tools ?? []) as Array<{ function: { name: string } }>).map((item) => item.function.name);
  }

  function brokerNudges(index: number): string[] {
    const messages = requests[index]?.messages as Array<{ role: string; content: unknown }>;
    return messages.flatMap((message) =>
      message.role === 'user' && typeof message.content === 'string' &&
      message.content.includes('Agent Vault broker guidance:') ? [message.content] : []);
  }

  function brokerFixture(body: object, callOnly = false, toolSearch = 'always') {
    const web = Bun.serve({
      port: 0,
      async fetch(request) {
        const message = request.method === 'POST' ? await request.clone().json() as { method?: string } : undefined;
        if (!callOnly || message?.method === 'tools/call')
          return Response.json(body, { status: 403, headers: { 'X-Agent-Vault-Proxy-Error': 'true' } });
        const instance = new McpServer({ name: 'broker-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
        instance.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: 'remote_echo', inputSchema: { type: 'object', properties: {} } }],
        }));
        const transport = new WebStandardStreamableHTTPServerTransport();
        await instance.connect(transport);
        return transport.handleRequest(request);
      },
    });
    const provider = new NativeProvider({
      model: 'local/test-model', modelParams: { mcp_tool_search: toolSearch },
      mcpServers: { Remote: { type: 'http', url: `http://127.0.0.1:${web.port}/mcp` } },
    });
    return { web, provider };
  }

  it('injects broker discovery guidance once per turn, without persisting it as input', async () => {
    const help = `${'Broker-defined recovery guidance. '.repeat(20)}GET http://127.0.0.1:14321/discover`;
    const { web, provider } = brokerFixture({ error: 'service_disabled', message: 'Remote is disabled for this vault.', help });
    const query = provider.query({ prompt: 'hello', cwd: root });
    scriptedToolCalls = [
      ['tool_search', '{"query":"web search"}'],
      ['tool_search', '{"query":"web search"}'],
    ];
    const events: ProviderEvent[] = [];
    let turns = 0;
    try {
      for await (const event of query.events) {
        events.push(event);
        if (event.type !== 'result') continue;
        turns++;
        if (turns === 1) {
          scriptedToolCalls = [['tool_search', '{"query":"web search"}']];
          query.push('again');
          query.end();
        }
      }
      expect(turns).toBe(2);
      expect(requests).toHaveLength(5);
      expect(brokerNudges(0)).toEqual([]);
      expect(brokerNudges(1)).toHaveLength(1);
      expect(brokerNudges(1)[0]).toContain(help);
      expect(brokerNudges(2)).toEqual([]);
      expect(brokerNudges(3)).toEqual([]);
      expect(brokerNudges(4)).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({ tool: 'tool_search', status: 'error', error: expect.stringContaining('service_disabled') }),
      }));
      const continuation = events.find((event) => event.type === 'init')!.continuation;
      expect(JSON.stringify(new NativeStore().contextMessages(continuation))).not.toContain('Agent Vault broker guidance:');
    } finally {
      query.abort();
      web.stop(true);
    }
  });

  it('includes eager discovery broker guidance in the first model step', async () => {
    const { web, provider } = brokerFixture(
      { error: 'credential_not_found', message: 'Ask the user to provide the credential.' }, false, 'never');
    try {
      const events = await collect(provider);
      expect(requests).toHaveLength(1);
      expect(brokerNudges(0)).toHaveLength(1);
      expect(brokerNudges(0)[0]).toContain('Ask the user to provide the credential.');
      expect(replyTexts(events)).toEqual([['hello from stub']]);
    } finally {
      web.stop(true);
    }
  });

  it('injects broker tool-call guidance before the next model step and retains the tool failure', async () => {
    const { web, provider } = brokerFixture(
      { error: 'oauth_refresh_failed', help: 'Reconnect the account before retrying.' }, true);
    try {
      scriptedToolCalls = [
        ['tool_search', '{"query":"remote echo","server":"Remote"}'],
        ['mcp__Remote__remote_echo', '{}'],
      ];
      const events = await collect(provider);
      expect(requests).toHaveLength(3);
      expect(brokerNudges(0)).toEqual([]);
      expect(brokerNudges(1)).toEqual([]);
      expect(brokerNudges(2)).toHaveLength(1);
      expect(brokerNudges(2)[0]).toContain('Reconnect the account before retrying.');
      expect(events).toContainEqual(expect.objectContaining({
        type: 'progress',
        step: expect.objectContaining({
          tool: 'mcp__Remote__remote_echo', status: 'error', error: expect.stringContaining('oauth_refresh_failed'),
        }),
      }));
    } finally {
      web.stop(true);
    }
  });

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
      '**Fixture** (discover on demand, prefix `mcp__Fixture__`)',
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

    // A resumed query does not reconnect just to restore tools from history.
    const continuation = events.find((event) => event.type === 'init')!.continuation;
    await collect(provider, continuation);
    expect(requests).toHaveLength(4);
    expect(requestToolNames(3)).toContain('tool_search');
    expect(requestToolNames(3)).not.toContain('mcp__Fixture__echo_value');
    expect(requestToolNames(3)).not.toContain('mcp__Fixture__wait');
  });

  it.each([undefined, 'always', true] as const)(
    'starts the first model request without MCP discovery with mode %s', async (mode) => {
    let discoveryRequests = 0;
    const hanging = Bun.serve({
      port: 0,
      async fetch() {
        discoveryRequests++;
        return new Promise<Response>(() => {});
      },
    });
    try {
      const provider = new NativeProvider({
        model: 'local/test-model', modelParams: { mcp_tool_search: mode },
        mcpServers: { Hanging: { type: 'http', url: `http://127.0.0.1:${hanging.port}/mcp` } },
      });
      const events = await collect(provider);
      expect(requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'model_request')).toBe(true);
      expect(replyTexts(events)).toEqual([['hello from stub']]);
      expect(discoveryRequests).toBe(0);
      const continuation = events.find((event) => event.type === 'init')!.continuation;
      await collect(provider, continuation);
      expect(discoveryRequests).toBe(0);
    } finally {
      hanging.stop(true);
    }
  });

  it('keeps discovered and loaded tools available on warm follow-ups without another search', async () => {
    scriptedToolCalls = [
      ['tool_search', '{"query":"echo value","server":"Fixture"}'],
      ['mcp__Fixture__echo_value', '{"value":"initial"}'],
    ];
    const query = fixtureProvider().query({ prompt: 'hello', cwd: root });
    let turns = 0;
    try {
      for await (const event of query.events) {
        if (event.type !== 'result') continue;
        turns++;
        if (turns === 1) {
          scriptedToolCalls = [['mcp__Fixture__echo_value', '{"value":"followup"}']];
          query.push('again');
          query.end();
        }
      }
      expect(turns).toBe(2);
      expect(requests).toHaveLength(5);
      expect(requestToolNames(3)).toContain('mcp__Fixture__echo_value');
      expect(JSON.stringify(requests[4]?.messages)).toContain('echo:followup');
    } finally {
      query.abort();
    }
  });

  it('scopes tool_search to one server without touching an unrelated hanging server', async () => {
    let discoveryRequests = 0;
    const hanging = Bun.serve({
      port: 0,
      async fetch() {
        discoveryRequests++;
        return new Promise<Response>(() => {});
      },
    });
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    try {
      scriptedToolCalls = [
        ['tool_search', '{"query":"echo value","server":"Fixture"}'],
        ['mcp__Fixture__echo_value', '{"value":"scoped"}'],
      ];
      const events = await collect(new NativeProvider({
        model: 'local/test-model', modelParams: { mcp_tool_search: 'always' },
        mcpServers: {
          Fixture: { command: bun, args: ['run', path.join(import.meta.dir, 'native', 'test-fixtures', 'stdio-mcp.ts')] },
          Hanging: { type: 'http', url: `http://127.0.0.1:${hanging.port}/mcp` },
        },
      }));
      expect(discoveryRequests).toBe(0);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2]?.messages)).toContain('echo:scoped');
      expect(events.some((event) => event.type === 'model_request')).toBe(true);
    } finally {
      hanging.stop(true);
    }
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

  it('recovers an audio rejection with an explicit media-unavailable note, not a file-reference fallback', async () => {
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
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.messages)).toContain('Media unavailable to this model: Unsupported audio format');
      expect(JSON.stringify(requests[1]?.messages)).not.toContain('input_audio');
      expect(JSON.stringify(requests[1]?.messages)).not.toContain('file-reference');
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
  const systemText = (request: Record<string, unknown>) =>
    JSON.stringify(request.system ?? (request.messages as Array<{ role: string }>).filter((message) => message.role === 'system'));

  it.each(['openai-chat', 'anthropic-messages'])('keeps system instructions stable across model steps and resume (%s)', async (protocol) => {
    process.env.NATIVE_PROTOCOL = protocol;
    scriptedToolCalls = [sendCall('first update'), sendCall('second update')];
    const first = await collect(new NativeProvider({ model: 'local/test-model' }));
    const init = first.find((event) => event.type === 'init');
    if (!init) throw new Error('Missing native continuation');

    expect(requests).toHaveLength(3);
    for (let completed = 0; completed < requests.length; completed++) {
      const system = systemText(requests[completed]);
      expect(system).toBe(systemText(requests[0]));
      expect(system).not.toContain('Step budget');
    }
    await collect(new NativeProvider({ model: 'local/test-model' }), init.continuation);
    expect(systemText(requests[3])).toBe(systemText(requests[0]));
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

  it('completes 120 model tool steps and four compactions without forcing a handoff', async () => {
    catalogModels = { local: { models: { 'test-model': {
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 1_000_000, output: 8192 },
    } } } };
    scriptedToolCalls = Array.from({ length: 120 }, (_, index) => sendCall(`update ${index}`));
    scriptedUsage = Array.from({ length: 120 }, (_, index) => ({
      prompt_tokens: (index + 1) % 30 === 0 ? 749_998 : 4, completion_tokens: 2,
    }));
    scriptedTexts = ['All 120 steps completed.'];
    const events = await collect(new NativeProvider({ model: 'local/test-model' }));

    expect(requests).toHaveLength(125);
    const normal = requests.filter(request => !JSON.stringify(request).includes(COMPACTION_INSTRUCTIONS));
    expect(normal).toHaveLength(121);
    expect(normal.every(request => request.tools !== undefined)).toBe(true);
    expect(events.filter(event => event.type === 'progress' && event.step.kind === 'compaction' &&
      event.step.status === 'completed')).toHaveLength(4);
    expect(getOutboundDb().prepare("SELECT COUNT(*) AS count FROM messages_out WHERE kind='chat'").get())
      .toMatchObject({ count: 120 });
    expect(replyTexts(events)).toEqual([['All 120 steps completed.']]);
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
