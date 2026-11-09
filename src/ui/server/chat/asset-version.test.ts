import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatAssetVersion } from './asset-version.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-assets-'));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'index.html'), 'shell');
  fs.writeFileSync(path.join(root, 'dist/app.js'), 'before');
  fs.writeFileSync(path.join(root, 'dist/app.css'), 'styles');
  for (const name of ['index.html', 'dist/app.js', 'dist/app.css']) fs.utimesSync(path.join(root, name), 1000, 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true });
});

describe('chat asset versions', () => {
  it('is stable for unchanged files and changes on a same-size rebuild without a host restart', () => {
    const before = chatAssetVersion(root);
    expect(chatAssetVersion(root)).toBe(before);
    fs.writeFileSync(path.join(root, 'dist/app.js'), 'after!');
    fs.utimesSync(path.join(root, 'dist/app.js'), 1001, 1001);
    expect(chatAssetVersion(root)).not.toBe(before);
  });

  it('detects size changes even when deployment preserves mtimes', () => {
    const before = chatAssetVersion(root);
    fs.writeFileSync(path.join(root, 'dist/app.js'), 'a different bundle size');
    fs.utimesSync(path.join(root, 'dist/app.js'), 1000, 1000);
    expect(chatAssetVersion(root)).not.toBe(before);
  });

  it.each(['dist/app.css', 'dist/appearance.js', 'sw.js', 'icon.svg'])(
    'tracks %s independently of the app bundle',
    (name) => {
      const before = chatAssetVersion(root);
      fs.writeFileSync(path.join(root, name), 'updated');
      expect(chatAssetVersion(root)).not.toBe(before);
    },
  );

  it('tolerates optional missing assets but refuses empty or invalid asset directories', () => {
    expect(chatAssetVersion(root)).toMatch(/^[a-f0-9]{20}$/);
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    expect(() => chatAssetVersion(empty)).toThrow('No chat assets');
    fs.unlinkSync(path.join(root, 'dist/app.js'));
    fs.mkdirSync(path.join(root, 'dist/app.js'));
    expect(() => chatAssetVersion(root)).toThrow('not a regular file');
  });

  it('does not silently hide permission or IO errors', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    });
    expect(() => chatAssetVersion(root)).toThrow('Denied');
  });
});
