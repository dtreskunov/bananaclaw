import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';

type ModelToolOutput = Extract<Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-result' }>['output'];
export const MAX_TOOL_TEXT_BYTES = 16 * 1024;

function boundedOutput(output: ModelToolOutput, directory: string): ModelToolOutput {
  const text = output.type === 'content'
    ? output.value.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    : output.type === 'text' || output.type === 'error-text' ? output.value
      : output.type === 'json' || output.type === 'error-json' ? JSON.stringify(output.value) : null;
  if (text === null || Buffer.byteLength(text) <= MAX_TOOL_TEXT_BYTES) return output;
  const complete = JSON.stringify(output, null, 2);
  const filename = path.join(directory, `${createHash('sha256').update(complete).digest('hex')}.json`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, complete, { mode: 0o600 });
  const notice = `\n[Abbreviated ${Buffer.byteLength(text)} UTF-8 bytes. Complete typed result: ${filename}. ` +
    'Use ranged read or bash to extract only the needed fields; do not load the complete result.]';
  const preview = new TextDecoder().decode(
    Buffer.from(text).subarray(0, Math.max(0, MAX_TOOL_TEXT_BYTES - Buffer.byteLength(notice))), { stream: true },
  ) + notice;
  if (output.type === 'content') return {
    type: 'content', value: [{ type: 'text', text: preview }, ...output.value.filter((part) => part.type !== 'text')],
  };
  return { type: output.type === 'error-text' || output.type === 'error-json' ? 'error-text' : 'text', value: preview };
}

export function boundToolResults(messages: ModelMessage[], directory: string): ModelMessage[] {
  return messages.map((message) => message.role !== 'tool' ? message : {
    ...message,
    content: message.content.map((part) => part.type !== 'tool-result' ? part : {
      ...part, output: boundedOutput(part.output, directory),
    }),
  });
}
