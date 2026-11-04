import type { ModelMessage } from 'ai';
import type { NativeContextEntry } from './store.js';
import { toolActivityFields } from '../tool-activity.js';

type ModelToolOutput = Extract<Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-result' }>['output'];
export const MAX_TOOL_TEXT_BYTES = 16 * 1024;

function boundedOutput(output: ModelToolOutput, archive: (complete: string) => string): ModelToolOutput {
  const text = output.type === 'content'
    ? output.value.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    : output.type === 'text' || output.type === 'error-text' ? output.value
      : output.type === 'json' || output.type === 'error-json' ? JSON.stringify(output.value) : null;
  if (text === null || Buffer.byteLength(text) <= MAX_TOOL_TEXT_BYTES) return output;
  const filename = archive(JSON.stringify(output, null, 2));
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

export function boundToolResults(messages: ModelMessage[], archive: (complete: string) => string): ModelMessage[] {
  return messages.map((message) => message.role !== 'tool' ? message : {
    ...message,
    content: message.content.map((part) => part.type !== 'tool-result' ? part : {
      ...part, output: boundedOutput(part.output, archive),
    }),
  });
}

function successfulOutput(output: ModelToolOutput): boolean {
  if (output.type === 'content') return output.value.every((part) => part.type === 'text');
  if (output.type === 'json' && output.value && typeof output.value === 'object' && !Array.isArray(output.value)) {
    if ('isError' in output.value && output.value.isError === true) return false;
    if ('status' in output.value) return output.value.status === 'completed';
  }
  return output.type === 'text' || output.type === 'json';
}

function completedExchange(group: NativeContextEntry[]) {
  const assistant = group[0].message;
  if (!group.every(item => item.finished) || assistant.role !== 'assistant' || !Array.isArray(assistant.content) ||
      assistant.content.some(part => part.type !== 'text' && part.type !== 'tool-call')) return null;
  const calls = assistant.content.filter(part => part.type === 'tool-call');
  const results = group.flatMap(({ message }) => message.role === 'tool' ? message.content : []);
  if (!calls.length || results.length !== calls.length || new Set(calls.map(call => call.toolCallId)).size !== calls.length)
    return null;
  const safe = calls.every(call => {
    const result = results.find(part => part.type === 'tool-result' && part.toolCallId === call.toolCallId);
    return result?.type === 'tool-result' && result.toolName === call.toolName && successfulOutput(result.output) &&
      call.toolName !== 'skill' && call.toolName !== 'tool_search' &&
      !call.toolName.startsWith('mcp__nanoclaw__') &&
      (call.toolName !== 'bash' || result.output.type === 'json');
  });
  return safe ? { assistant, calls, text: assistant.content.filter(part => part.type === 'text') } : null;
}

export function finishedToolReceipts(entries: NativeContextEntry[], archive: (complete: string) => string): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const group = [entries[i]];
    while (entries[i + group.length]?.message.role === 'tool') group.push(entries[i + group.length]);
    const original = group.map(item => item.message);
    const complete = completedExchange(group);
    i += group.length - 1;
    if (!complete) { messages.push(...original); continue; }
    const details = complete.calls.map(call => {
      const { detail } = toolActivityFields(call.toolName, call.input);
      return `- ${call.toolName} (${call.toolCallId}): completed${detail ? `; ${detail.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    }).join('\n');
    const serialized = JSON.stringify({ type: 'json', value: original }, null, 2);
    if (Buffer.byteLength(serialized) <= Buffer.byteLength(details) + 512) {
      messages.push(...original);
    } else {
      const filename = archive(serialized);
      messages.push({ ...complete.assistant, content: [
        ...complete.text,
        { type: 'text', text: `[Finished-turn tool receipt; execution already completed. Do not repeat completed actions.]\n` +
          `${details}\nFull arguments/results: ${filename}. Retrieve only the relevant lines or fields before relying on omitted details.` },
      ] });
    }
  }
  return messages;
}
