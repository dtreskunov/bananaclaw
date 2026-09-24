import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { formatNativeToolStep, NativeProvider, portableHistory, userMessage } from './native.js';
import * as nativeCatalog from './native/catalog.js';
import * as nativeAudio from './native/audio.js';
import type { ProviderEvent } from './types.js';

let root: string;
let server: ReturnType<typeof Bun.serve>;
let requests: Array<Record<string, unknown>>;
let requestUrls: string[];
let requestHeaders: Headers[];
let toolMode: boolean;
let anthropicToolMode: boolean;
let externalMcpToolMode: boolean;
let skillToolMode: boolean;
let todoToolMode: boolean;
let rejectAudio: boolean;
let catalogFetch: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let catalogModels: Record<string, unknown>;

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
  nativeCatalog.clearNativeCatalogForTest();
  catalogModels = {};
  const realFetch = globalThis.fetch;
  catalogFetch = spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
    String(input) === 'https://models.dev/api.json' ? Promise.resolve(Response.json(catalogModels)) : realFetch(input, init));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provider-'));
  requests = [];
  requestUrls = [];
  requestHeaders = [];
  toolMode = false;
  anthropicToolMode = false;
  externalMcpToolMode = false;
  skillToolMode = false;
  todoToolMode = false;
  rejectAudio = false;
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
      if (rejectAudio && JSON.stringify(requests.at(-1)?.messages).includes('input_audio')) {
        return Response.json({ error: { message: 'Unsupported audio format', type: 'invalid_request_error' } }, { status: 400 });
      }
      if (new URL(request.url).pathname.endsWith('/messages')) {
        const requestBody = requests.at(-1)!;
        const hasToolResult = JSON.stringify(requestBody.messages).includes('tool_result');
        const body =
          anthropicToolMode && !hasToolResult
            ? [
                'event: message_start',
                'data: {"type":"message_start","message":{"id":"msg_minimax_tool","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
                '',
                'event: content_block_start',
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_minimax_1","name":"mcp__nanoclaw__send_message","input":{}}}',
                '',
                'event: content_block_delta',
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"text\\":\\"hello from direct tool\\"}"}}',
                '',
                'event: content_block_stop',
                'data: {"type":"content_block_stop","index":0}',
                '',
                'event: message_delta',
                'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}',
                '',
                'event: message_stop',
                'data: {"type":"message_stop"}',
                '',
                '',
              ].join('\n')
            : [
                'event: message_start',
                'data: {"type":"message_start","message":{"id":"msg_minimax","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":0}}}',
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
                'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
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
      const shouldCallTool = todoToolMode
        ? toolResultCount < 2
        : (toolMode || externalMcpToolMode || skillToolMode) && toolResultCount === 0;
      const toolName = todoToolMode
        ? toolResultCount === 0
          ? 'todowrite'
          : 'todoread'
        : skillToolMode
          ? 'skill'
          : externalMcpToolMode
            ? 'mcp__Fixture__echo_value'
            : 'mcp__nanoclaw__send_message';
      const toolArguments = todoToolMode
        ? toolResultCount === 0
          ? '{"todos":[{"id":"inspect","content":"turn-one-secret","status":"in_progress"}]}'
          : '{}'
        : skillToolMode
          ? '{"name":"local-guide"}'
          : externalMcpToolMode
            ? '{"value":"from-model"}'
            : '{"text":"hello user"}';
      const body = shouldCallTool
        ? [
            `data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${toolName}","arguments":${JSON.stringify(toolArguments)}}}]},"finish_reason":null}]}`,
            '',
            'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}',
            '',
            'data: [DONE]',
            '',
          ].join('\n')
        : [
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello from stub"},"finish_reason":null}]}',
            '',
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
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
  it('formats canonical native tool activity with safe resource details', () => {
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
      { toolCallId: 'mcp-1', toolName: 'mcp__example__lookup', input: { name: 'private-value' } },
      'completed',
    )).not.toHaveProperty('detail');
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
    expect(first).toContainEqual(expect.objectContaining({ type: 'result', text: 'hello from stub' }));
    expect(first.some((event) => event.type === 'usage')).toBe(true);
    expect(first.some((event) => event.type === 'checkpoint')).toBe(true);

    const restartedProvider = new NativeProvider({ model: 'local/test-model' });
    const second = await collect(restartedProvider, continuation);
    expect(second).toContainEqual(expect.objectContaining({ type: 'result', text: 'hello from stub' }));
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage',
        data: expect.objectContaining({ input_tokens: 15, output_tokens: 5, context_tokens: 7, num_turns: 2 }),
      }),
    );
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
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain('echo:from-model');
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

    expect(events).toContainEqual(expect.objectContaining({ type: 'result', text: 'hello from direct minimax' }));
    expect(new URL(requestUrls[0]!).pathname).toBe('/v1/messages');
    expect(requestHeaders[0]!.get('x-api-key')).toBe('placeholder');
    expect(requests[0]?.model).toBe('MiniMax-M3');
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
