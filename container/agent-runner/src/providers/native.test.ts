import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { NativeProvider, portableHistory, userMessage } from './native.js';
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-provider-'));
  requests = [];
  requestUrls = [];
  requestHeaders = [];
  toolMode = false;
  anthropicToolMode = false;
  externalMcpToolMode = false;
  skillToolMode = false;
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
      const shouldCallTool =
        (toolMode || externalMcpToolMode || skillToolMode) && !messages.some((message) => message.role === 'tool');
      const toolName = skillToolMode
        ? 'load_skill'
        : externalMcpToolMode
          ? 'mcp__Fixture__echo_value'
          : 'mcp__nanoclaw__send_message';
      const toolArguments = skillToolMode
        ? '{"name":"local-guide"}'
        : externalMcpToolMode
          ? '{"value":"from-model"}'
          : '{"text":"hello user"}';
      const body = shouldCallTool
        ? [
            `data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${toolName}","arguments":${JSON.stringify(toolArguments)}}}]},"finish_reason":null}]}`,
            '',
            'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
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
  it('stores supported image attachments as replayable base64 message parts', () => {
    const imagePath = path.join(root, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(userMessage('inspect', [{ path: imagePath, mime: 'image/png', filename: 'pixel.png' }])).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'file', data: 'iVBORw==', mediaType: 'image/png', filename: 'pixel.png' },
      ],
    });
  });

  it('gates file modalities by model capability and transport protocol', () => {
    const files = [
      { path: path.join(root, 'image.png'), mime: 'image/png', filename: 'image.png' },
      { path: path.join(root, 'document.pdf'), mime: 'application/pdf', filename: 'document.pdf' },
      { path: path.join(root, 'notes.txt'), mime: 'text/plain', filename: 'notes.txt' },
      { path: path.join(root, 'speech.mp3'), mime: 'audio/mpeg', filename: 'speech.mp3' },
      { path: path.join(root, 'clip.mp4'), mime: 'video/mp4', filename: 'clip.mp4' },
    ];
    for (const file of files) fs.writeFileSync(file.path, Buffer.from([1, 2, 3]));

    const anthropic = userMessage('inspect', files, {
      protocol: 'anthropic-messages',
      inputModalities: ['text', 'image', 'pdf', 'audio', 'video'],
    });
    const openai = userMessage('inspect', files, {
      protocol: 'openai-chat',
      inputModalities: ['text', 'image', 'pdf', 'audio', 'video'],
    });

    expect(JSON.stringify(anthropic)).toContain('document.pdf');
    expect(JSON.stringify(anthropic)).toContain('notes.txt');
    expect(JSON.stringify(anthropic)).not.toContain('speech.mp3');
    expect(JSON.stringify(anthropic)).not.toContain('clip.mp4');
    expect(JSON.stringify(openai)).toContain('speech.mp3');
    expect(JSON.stringify(openai)).toContain('clip.mp4');
  });

  it('removes provider-private reasoning while preserving portable tool history', () => {
    expect(
      portableHistory([
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private' },
            { type: 'text', text: 'visible' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'x' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'read_file',
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
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read_file',
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
        step: expect.objectContaining({ tool: 'load_skill', status: 'completed' }),
      }),
    );
    expect(JSON.stringify(requests[0]?.messages)).toContain('**local-guide** (`local-guide`) — Use the local workflow.');
    expect(JSON.stringify(requests[1]?.messages)).toContain('Return SKILL-LOADED.');
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

  it('encodes PDF, text, audio, and video through OpenAI-compatible Chat', async () => {
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
    expect(body).toContain('"input_audio":{"data":"BAUG","format":"mp3"}');
    expect(body).toContain('data:video/mp4;base64,BwgJ');
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
