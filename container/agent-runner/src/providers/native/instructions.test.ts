import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { jsonSchema } from 'ai';

import { nativeMediaInstructions } from './instructions.js';
import { createNativeMediaBudget, createNativeMediaTools } from './media.js';

const names = ['view_image', 'view_pdf', 'listen_audio', 'view_video'];

describe('native media instructions', () => {
  it.each(['openai-chat', 'anthropic-messages'] as const)(
    'mentions exactly the tools enabled for the model and %s adapter',
    (protocol) => {
      for (const inputModalities of [
        undefined, ['text'], ['image'], ['pdf'], ['audio'], ['video'],
        ['audio', 'video'], ['image', 'pdf', 'audio', 'video'],
      ]) {
        const tools = createNativeMediaTools('/tmp', { protocol, inputModalities }, createNativeMediaBudget());
        const instructions = nativeMediaInstructions(tools);
        if (Object.keys(tools).length === 0) {
          expect(instructions).toBeNull();
        } else {
          expect(instructions).toContain('## Inspecting native media');
          for (const name of names) {
            expect(instructions?.includes(name)).toBe(name in tools);
          }
        }
      }
    },
  );

  it('omits media guidance when tools are disabled or only non-media tools are available', () => {
    expect(nativeMediaInstructions({})).toBeNull();
    expect(nativeMediaInstructions({
      read: { description: 'Read text', inputSchema: jsonSchema({ type: 'object', properties: {} }) },
    })).toBeNull();
  });

  it('does not mention media tools in unconditional core instructions', () => {
    const core = fs.readFileSync(new URL('./core.md', import.meta.url), 'utf8');
    for (const name of names) expect(core).not.toContain(name);
  });
});
