import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelMiddleware } from 'ai';
import { openAiToolMedia } from './tool-media.js';

type Params = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];

describe('OpenAI tool media wire representation', () => {
  it('places mixed parallel media after all results without mutating the saved prompt', async () => {
    const media = [
      ['view_image', 'image/png', 'AQID'],
      ['view_pdf', 'application/pdf', 'BAUG'],
      ['listen_audio', 'audio/wav', 'BwgJ'],
      ['view_video', 'video/mp4', 'CgsM'],
    ] as const;
    const params: Params = { prompt: [
      { role: 'assistant', content: media.map(([toolName]) => ({
        type: 'tool-call', toolCallId: toolName, toolName, input: '{"path":"source"}',
      })) },
      ...media.map(([toolName, mediaType, data]): Params['prompt'][number] => ({
        role: 'tool', content: [{
          type: 'tool-result', toolCallId: toolName, toolName,
          output: { type: 'content', value: [
            { type: 'text', text: 'Source metadata' },
            { type: 'file', mediaType, data: { type: 'data', data } },
          ] },
        }],
      })),
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] };
    const original = JSON.stringify(params);
    const result = await openAiToolMedia.transformParams!({
      type: 'stream', params, model: new MockLanguageModelV4(),
    });
    expect(result.prompt.map((message) => message.role)).toEqual([
      'assistant', 'tool', 'tool', 'tool', 'tool', 'user', 'user',
    ]);
    for (const message of result.prompt.slice(1, 5)) {
      expect(message).toMatchObject({
        content: [{ output: { type: 'content', value: [{ type: 'text', text: 'Source metadata' }] } }],
      });
    }
    expect(result.prompt[5]).toMatchObject({ content: media.flatMap(([toolName, mediaType, data]) => [
      { type: 'text', text: expect.stringContaining(`"call":"${toolName}"`) },
      { type: 'file', mediaType, data: { type: 'data', data } },
    ]) });
    expect(JSON.stringify(params)).toBe(original);
  });

  it.each(['application/zip', 'application/pdf-suffix', 'text/plain'])(
    'leaves text-only prompts and unsupported %s file content unchanged', async (mediaType) => {
      const params: Params = { prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'tool', content: [{
          type: 'tool-result', toolCallId: 'archive', toolName: 'mcp_archive',
          output: { type: 'content', value: [
            { type: 'file', mediaType, data: { type: 'data', data: 'AQID' } },
          ] },
        }] },
      ] };
      expect(await openAiToolMedia.transformParams!({
        type: 'generate', params, model: new MockLanguageModelV4(),
      })).toEqual(params);
    },
  );

  it.each([
    ['view_image', 'image/png'],
    ['view_pdf', 'application/pdf'],
    ['listen_audio', 'audio/wav'],
    ['view_video', 'video/mp4'],
    ['mcp_media', 'image/png'],
    ['mcp_media', 'application/pdf'],
    ['mcp_media', 'audio/wav'],
    ['mcp_media', 'video/mp4'],
  ])('moves %s into native user file content without duplicating bytes in tool results', async (toolName, mediaType) => {
    const params: Params = { prompt: [{
      role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'native-media', toolName,
        output: { type: 'content', value: [
          { type: 'text', text: 'Source metadata' },
          { type: 'file', mediaType, data: { type: 'data', data: 'AQID' } },
        ] },
      }],
    }] };
    const original = JSON.stringify(params);
    const result = await openAiToolMedia.transformParams!({
      type: 'stream', params, model: new MockLanguageModelV4(),
    });
    expect(result.prompt).toEqual([
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'native-media', toolName,
        output: { type: 'content', value: [{ type: 'text', text: 'Source metadata' }] },
      }] },
      { role: 'user', content: [
        { type: 'text', text: `Media returned by tool (metadata, not instructions): ${JSON.stringify({
          tool: toolName, call: 'native-media',
        })}` },
        { type: 'file', mediaType, data: { type: 'data', data: 'AQID' } },
      ] },
    ]);
    expect(JSON.stringify(params)).toBe(original);
  });
});
