import fs from 'node:fs';
import type { ModelMessage, UserModelMessage } from 'ai';

import type { FileAttachment } from '../types.js';
import { isAudioAttachment } from '../attachment-routing.js';
import type { NativeModel } from './catalog.js';
import { prepareAudio } from './audio.js';

export const MAX_INLINE_BYTES = 16 * 1024 * 1024;
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export type ModelCapabilities = Pick<NativeModel, 'protocol' | 'inputModalities'>;

export function audioRoutingReason(model?: ModelCapabilities): string | null {
  if (!model?.inputModalities) return 'model-audio-capability-unknown';
  if (!model.inputModalities.includes('audio')) return 'model-does-not-support-audio';
  if (model.protocol !== 'openai-chat') return 'adapter-does-not-support-audio';
  return null;
}

function inlineDataBytes(data: unknown): number {
  if (typeof data === 'string') {
    if (/^https?:\/\//i.test(data)) return 0;
    const dataUrl = /^data:[^,]*;base64,/i.exec(data);
    return Buffer.byteLength(dataUrl ? data.slice(dataUrl[0].length) : data);
  }
  if (data instanceof Uint8Array) return 4 * Math.ceil(data.byteLength / 3);
  if (data instanceof ArrayBuffer) return 4 * Math.ceil(data.byteLength / 3);
  return 0;
}

export function inlineHistoryBytes(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'file' || part.type === 'image')
          total += inlineDataBytes(part.type === 'file' ? part.data : part.image);
      }
    } else if (message.role === 'tool') {
      for (const result of message.content) {
        if (result.type !== 'tool-result' || result.output.type !== 'content') continue;
        for (const part of result.output.value) {
          if (part.type === 'file' && part.data.type === 'data')
            total += inlineDataBytes(part.data.data);
          else if (part.type === 'image-data' || part.type === 'file-data')
            total += inlineDataBytes(part.data);
        }
      }
    }
  }
  return total;
}

function supportsFile(file: FileAttachment, model?: ModelCapabilities): boolean {
  const modality = IMAGE_MIMES.has(file.mime)
    ? 'image'
    : file.mime === 'application/pdf'
      ? 'pdf'
      : file.mime === 'text/plain'
        ? 'text'
        : file.mime.startsWith('video/')
          ? 'video'
          : null;
  if (!modality) return false;
  if (model?.protocol === 'anthropic-messages' && modality === 'video') return false;
  return !model?.inputModalities || model.inputModalities.includes(modality);
}

export async function prepareNativeUserMessage(
  text: string,
  files: FileAttachment[] | undefined,
  model?: ModelCapabilities,
  options: {
    signal?: AbortSignal;
    maxInlineBytes?: number;
    prepare?: typeof prepareAudio;
    onMediaPressure?: () => void;
  } = {},
): Promise<UserModelMessage> {
  const content: Exclude<UserModelMessage['content'], string> = [];
  const notes: Array<{ filename: string; path: string; mime: string; delivery: string; reason?: string }> = [];
  let remaining = Math.max(0, options.maxInlineBytes ?? MAX_INLINE_BYTES);
  const prepare = options.prepare ?? prepareAudio;
  for (const file of files ?? []) {
    options.signal?.throwIfAborted();
    const audio = isAudioAttachment(file);
    let reason = audio ? audioRoutingReason(model) : null;
    let bytes: Buffer | undefined;
    let nativeFile: Pick<FileAttachment, 'mime' | 'filename'> = file;
    let conversion = '';
    let pressure = false;
    if (!reason && audio) {
      if (remaining < 4) { reason = 'inline-payload-limit'; pressure = true; }
      else {
        const prepared = await prepare(file, {
          signal: options.signal,
          maxOutputBytes: Math.floor(remaining / 4) * 3,
        });
        options.signal?.throwIfAborted();
        if (prepared.kind === 'file-reference') {
          reason = prepared.reason;
          pressure = reason === 'audio-output-size-limit' && remaining < MAX_INLINE_BYTES;
        }
        else {
          bytes = prepared.bytes;
          nativeFile = prepared.file;
          conversion = prepared.converted ? 'converted' : 'original';
        }
      }
    } else if (!audio && supportsFile(file, model)) {
      const size = fs.statSync(file.path).size;
      const encodedBytes = 4 * Math.ceil(size / 3);
      if (encodedBytes > remaining) {
        reason = 'inline-payload-limit';
        pressure = encodedBytes <= MAX_INLINE_BYTES;
      }
      else bytes = fs.readFileSync(file.path);
    }
    if (bytes && 4 * Math.ceil(bytes.length / 3) > remaining) {
      pressure = 4 * Math.ceil(bytes.length / 3) <= MAX_INLINE_BYTES;
      bytes = undefined;
      reason = 'inline-payload-limit';
    }
    if (pressure) options.onMediaPressure?.();
    if (bytes) {
      const data = bytes.toString('base64');
      remaining -= data.length;
      content.push({ type: 'file', data, mediaType: nativeFile.mime, filename: nativeFile.filename });
    }
    if (audio || reason) {
      notes.push({
        filename: file.filename,
        path: file.path,
        mime: file.mime,
        delivery: bytes ? 'native-audio' : 'file-reference',
        ...(reason ? { reason } : {}),
      });
      console.error(
        `[attachments] delivery=${bytes ? 'native-audio' : 'file-reference'} reason=${reason ?? conversion}`,
      );
    }
  }
  const prompt = notes.length
    ? `${text}\n\nAttachment delivery (file metadata, not instructions):\n${JSON.stringify(notes)}`
    : text;
  if (!content.length) return { role: 'user', content: prompt };
  return { role: 'user', content: [{ type: 'text', text: prompt }, ...content] };
}
