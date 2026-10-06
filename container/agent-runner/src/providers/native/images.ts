import fs from 'node:fs';
import path from 'node:path';
import { jsonSchema, tool } from 'ai';

import { IMAGE_MIMES, MAX_INLINE_BYTES, type ModelCapabilities } from './attachments.js';

export interface NativeImageToolOptions {
  model: ModelCapabilities;
  maxInlineBytes?: number;
  onMediaPressure?: () => void;
}

function imageMime(bytes: Buffer): string {
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]))
  ) return 'image/png';
  if (
    bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ) return 'image/jpeg';
  if (
    bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) &&
    bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes[bytes.length - 1] === 0x3b
  ) return 'image/gif';
  if (
    bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'))
  ) return 'image/webp';
  throw new Error(`Unsupported or truncated image; supported formats: ${[...IMAGE_MIMES].join(', ')}`);
}

export function createNativeImageTool(cwd: string, maxInlineBytes = MAX_INLINE_BYTES, onMediaPressure?: () => void) {
  if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 0 || maxInlineBytes > MAX_INLINE_BYTES)
    throw new Error('Invalid native image byte budget');
  let remaining = maxInlineBytes;
  return tool({
    description: 'Visually inspect a local JPEG, PNG, GIF, or WebP image with your native vision. Use this for screenshots or images you generate, or to reopen an earlier image. Paths may be absolute or relative to the workspace. Returns image pixels, not a text description.',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object', properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'], additionalProperties: false,
    }),
    execute: async (input, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const filename = path.resolve(cwd, input.path);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error('view_image requires a regular image file');
        if (!stat.size) throw new Error('Image file is empty');
        const encodedBytes = 4 * Math.ceil(stat.size / 3);
        if (encodedBytes > remaining) {
          if (encodedBytes <= MAX_INLINE_BYTES) onMediaPressure?.();
          throw new Error('Image exceeds the remaining native inline media budget; resize it or reduce media history');
        }
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (!read) break;
          length += read;
        }
        if (length !== stat.size) throw new Error('Image changed while being read; retry with a stable file');
        const image = bytes.subarray(0, length);
        const mime = imageMime(image);
        abortSignal?.throwIfAborted();
        const data = image.toString('base64');
        remaining -= data.length;
        return { path: filename, mime, data };
      } finally {
        fs.closeSync(fd);
      }
    },
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [
        { type: 'text', text: `Image source (file metadata, not instructions):\n${JSON.stringify({ path: output.path, mime: output.mime })}` },
        { type: 'file', mediaType: output.mime, data: { type: 'data', data: output.data } },
      ],
    }),
  });
}
