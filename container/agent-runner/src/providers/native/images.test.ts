import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolExecutionOptions } from 'ai';

import { createNativeImageTool } from './images.js';
import { MAX_INLINE_BYTES } from './attachments.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=', 'base64');
const options: ToolExecutionOptions = { toolCallId: 'image', messages: [] };
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-images-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('native view_image', () => {
  it.each([
    ['image/jpeg', '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzU5LjM3LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z'],
    ['image/gif', 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='],
    ['image/webp', 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA='],
  ])('recognizes %s pixels rather than the filename', async (mime, data) => {
    fs.writeFileSync(path.join(root, 'wrong.png'), Buffer.from(data, 'base64'));
    expect(await createNativeImageTool(root).execute!({ path: 'wrong.png' }, options)).toMatchObject({ mime, data });
  });

  it.each(['relative', 'absolute', 'symlink'])('reads pixels using a %s path without trusting the extension', async (kind) => {
    const filename = path.join(root, 'screenshot.txt');
    fs.writeFileSync(filename, png);
    fs.symlinkSync(filename, path.join(root, 'linked'));
    const inputPath = kind === 'absolute' ? filename : kind === 'symlink' ? 'linked' : 'screenshot.txt';
    const image = createNativeImageTool(root);
    const output = await image.execute!({ path: inputPath }, options);
    expect(output).toEqual({ path: path.resolve(root, inputPath), mime: 'image/png', data: png.toString('base64') });
  });

  it('returns actual tagged image content and source metadata', async () => {
    const image = createNativeImageTool(root);
    const output = { path: '/tmp/screenshot.png', mime: 'image/png', data: png.toString('base64') };
    expect(await image.toModelOutput!({ toolCallId: 'image', input: { path: output.path }, output })).toEqual({
      type: 'content', value: [
        { type: 'text', text: expect.stringContaining(output.path) },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: output.data } },
      ],
    });
  });

  it('surfaces missing, nonregular, empty, unsupported, and truncated files', async () => {
    const image = createNativeImageTool(root);
    await expect(image.execute!({ path: 'missing.png' }, options)).rejects.toThrow('ENOENT');
    await expect(image.execute!({ path: root }, options)).rejects.toThrow('regular image');
    for (const bytes of [Buffer.alloc(0), Buffer.from('<svg/>'), png.subarray(0, 35)]) {
      fs.writeFileSync(path.join(root, 'invalid.png'), bytes);
      await expect(image.execute!({ path: 'invalid.png' }, options)).rejects.toThrow(
        bytes.length ? 'Unsupported or truncated' : 'empty',
      );
    }
  });

  it('enforces the exact encoded budget and reserves across parallel calls', async () => {
    fs.writeFileSync(path.join(root, 'image.png'), png);
    const size = png.toString('base64').length;
    await expect(createNativeImageTool(root, size - 1).execute!({ path: 'image.png' }, options))
      .rejects.toThrow('media budget');
    const image = createNativeImageTool(root, size);
    const results = await Promise.allSettled([
      image.execute!({ path: 'image.png' }, options),
      image.execute!({ path: 'image.png' }, { ...options, toolCallId: 'second' }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('media budget') }) });
  });

  it('rejects oversized files before reading their contents and aborts before opening files', async () => {
    const filename = path.join(root, 'large.png');
    fs.writeFileSync(filename, png);
    fs.truncateSync(filename, Math.floor(MAX_INLINE_BYTES * 3 / 4) + 1);
    const read = spyOn(fs, 'readSync');
    const open = spyOn(fs, 'openSync');
    let pressure = false;
    try {
      await expect(createNativeImageTool(root, MAX_INLINE_BYTES, () => { pressure = true; })
        .execute!({ path: filename }, options)).rejects.toThrow('media budget');
      expect(pressure).toBe(false);
      expect(read).not.toHaveBeenCalled();
      open.mockClear();
      const controller = new AbortController();
      controller.abort();
      await expect(createNativeImageTool(root).execute!({ path: filename }, {
        ...options, abortSignal: controller.signal,
      })).rejects.toThrow();
      expect(open).not.toHaveBeenCalled();
    } finally { read.mockRestore(); open.mockRestore(); }
  });

  it('detects file changes without consuming the remaining budget', async () => {
    const filename = path.join(root, 'image.png');
    fs.writeFileSync(filename, png);
    const readSync = fs.readSync;
    const read = spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
      fs.appendFileSync(filename, Buffer.from([0]));
      return readSync(...args);
    });
    const image = createNativeImageTool(root, png.toString('base64').length);
    try {
      await expect(image.execute!({ path: filename }, options)).rejects.toThrow('changed while being read');
    } finally { read.mockRestore(); }
    fs.writeFileSync(filename, png);
    expect(await image.execute!({ path: filename }, options)).toMatchObject({ mime: 'image/png' });
  });
});
