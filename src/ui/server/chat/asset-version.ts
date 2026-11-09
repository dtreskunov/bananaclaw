import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SHELL_ASSETS = [
  'sw.js',
  'index.html',
  'dist/appearance.js',
  'dist/app.js',
  'dist/app.css',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'manifest.webmanifest',
];

export function chatAssetVersion(directory: string): string {
  const hash = createHash('sha256');
  let files = 0;
  for (const name of SHELL_ASSETS) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(directory, name));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) throw new Error(`Chat asset is not a regular file: ${name}`);
    hash.update(JSON.stringify([name, stat.mtimeMs, stat.size]));
    files++;
  }
  if (!files) throw new Error('No chat assets are available');
  return hash.digest('hex').slice(0, 20);
}
