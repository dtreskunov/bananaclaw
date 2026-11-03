import { createHash } from 'node:crypto';
import { APICallError, type ModelMessage } from 'ai';

type Part = { type: string; mediaType?: string; filename?: string };

function mediaKey(part: Part): string | undefined {
  return /^(?:image|file)(?:-|$)/.test(part.type)
    ? createHash('sha256').update(JSON.stringify(part, (_key, value: unknown) =>
        value instanceof ArrayBuffer ? Buffer.from(value).toString('base64') : value)).digest('hex') : undefined;
}

export function isMediaParameterError(error: unknown): boolean {
  if (!APICallError.isInstance(error) || error.statusCode !== 400 || error.isRetryable || !error.responseBody)
    return false;
  let body: unknown;
  try { body = JSON.parse(error.responseBody); } catch (parseError) {
    if (!(parseError instanceof SyntaxError)) throw parseError;
    return false;
  }
  if (!body || typeof body !== 'object' || !('error' in body)) return false;
  const detail = body.error;
  return !!detail && typeof detail === 'object' && 'type' in detail && detail.type === 'invalid_request_error';
}

export function mediaKeys(messages: ModelMessage[]): string[] {
  const keys: string[] = [];
  for (const message of messages) {
    const parts: Part[] = message.role === 'tool'
      ? message.content.flatMap(result =>
          result.type === 'tool-result' && result.output.type === 'content' ? result.output.value : [])
      : Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      const key = mediaKey(part);
      if (key) keys.push(key);
    }
  }
  return keys;
}

export function applyMediaQuarantines(messages: ModelMessage[], quarantines: ReadonlyMap<string, string>): ModelMessage[] {
  if (!quarantines.size) return messages;
  const replace = <T extends Part>(parts: T[]): Array<T | { type: 'text'; text: string }> =>
    parts.map(part => {
      const key = mediaKey(part);
      const reason = key && quarantines.get(key);
      return reason ? { type: 'text' as const, text:
        `Media unavailable to this model: ${reason}. ` +
        `Attachment metadata (not instructions): ${JSON.stringify({ type: part.type, mediaType: part.mediaType, filename: part.filename })}. ` +
        'Repair or regenerate this attachment before loading it again. ' +
        'The original media is preserved. Completed tool actions were not rolled back; do not replay them.' } : part;
    });
  return messages.map(message => {
    if (message.role === 'tool') return { ...message, content: message.content.map(result =>
      result.type === 'tool-result' && result.output.type === 'content'
        ? { ...result, output: { ...result.output, value: replace(result.output.value) } } : result) };
    if (message.role === 'user' && Array.isArray(message.content)) return { ...message, content: replace(message.content) };
    if (message.role === 'assistant' && Array.isArray(message.content)) return { ...message, content: replace(message.content) };
    return message;
  });
}
