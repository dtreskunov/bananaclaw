import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelMiddleware } from 'ai';
import { openAiToolImages } from './tool-images.js';

type Params = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];

describe('OpenAI tool image wire representation', () => {
  it('places parallel images after all results without mutating the saved prompt', async () => {
    const params: Params = { prompt: [
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'one', toolName: 'view_image', input: '{"path":"one.png"}' },
        { type: 'tool-call', toolCallId: 'two', toolName: 'view_image', input: '{"path":"two.png"}' },
      ] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'one', toolName: 'view_image',
        output: { type: 'content', value: [
          { type: 'text', text: '/tmp/one.png' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        ] },
      }] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'two', toolName: 'view_image',
        output: { type: 'content', value: [
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'BAUG' } },
        ] },
      }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ] };
    const original = JSON.stringify(params);
    const result = await openAiToolImages.transformParams!({
      type: 'stream', params, model: new MockLanguageModelV4(),
    });
    expect(result.prompt.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user']);
    expect(result.prompt[1]).toMatchObject({
      content: [{ output: { type: 'content', value: [{ type: 'text', text: '/tmp/one.png' }] } }],
    });
    expect(result.prompt[3]).toMatchObject({ content: [
      { type: 'text', text: expect.stringContaining('"call":"one"') },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
      { type: 'text', text: expect.stringContaining('"call":"two"') },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'BAUG' } },
    ] });
    expect(JSON.stringify(params)).toBe(original);
  });

  it('leaves text-only prompts and non-image tool content unchanged', async () => {
    const params: Params = { prompt: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'audio', toolName: 'mcp_audio',
        output: { type: 'content', value: [
          { type: 'file', mediaType: 'audio/mpeg', data: { type: 'data', data: 'AQID' } },
        ] },
      }] },
    ] };
    expect(await openAiToolImages.transformParams!({
      type: 'generate', params, model: new MockLanguageModelV4(),
    })).toEqual(params);
  });
});
