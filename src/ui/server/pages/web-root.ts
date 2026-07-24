import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { resolveSafe } from '../chat/classify.js';
import { fileEtag, ifMatchSatisfied, parseIfMatch } from '../chat/etag.js';
import { siteMimeFor } from './site.js';

const writeLocks = new Map<string, Promise<void>>();

export interface WebRootPolicy {
  filesystemRoot: string;
  cacheControl: string;
  maxFileBytes: number;
  maxWriteBytes?: number;
  capabilities: ReadonlySet<'read' | 'replace'>;
  headers?: (absolutePath: string) => http.OutgoingHttpHeaders;
  canRead?: (relativePath: string) => boolean;
  onRead?: (relativePath: string) => void;
  onReplace?: (args: { relativePath: string; oldContent: Buffer; newContent: Buffer }) => void;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function hasSymlinkSegment(root: string, relativePath: string): boolean {
  let current = root;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function readRelativePath(req: http.IncomingMessage): string | null {
  const rawPath = (req.url || '/').split('?')[0].split('#')[0];
  const decodedSegments: string[] = [];
  for (const segment of rawPath.split('/')) {
    if (!segment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\0') ||
      decoded.includes('/') ||
      decoded.includes('\\')
    ) {
      return null;
    }
    decodedSegments.push(decoded);
  }
  return decodedSegments.join('/');
}

function openVerifiedFile(
  root: string,
  relativePath: string,
): { absolutePath: string; fd: number; stat: fs.Stats } | null {
  const canonicalRoot = fs.realpathSync(root);
  if (hasSymlinkSegment(canonicalRoot, relativePath)) return null;
  const absolutePath = resolveSafe(canonicalRoot, relativePath);
  if (!absolutePath) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    const currentStat = fs.statSync(absolutePath);
    if (
      !stat.isFile() ||
      fs.realpathSync(absolutePath) !== absolutePath ||
      currentStat.dev !== stat.dev ||
      currentStat.ino !== stat.ino
    ) {
      fs.closeSync(fd);
      return null;
    }
    return { absolutePath, fd, stat };
  } catch {
    if (fd !== null) fs.closeSync(fd);
    return null;
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  writeLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  }
}

async function replaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: WebRootPolicy,
  relativePath: string,
): Promise<void> {
  if (!policy.capabilities.has('replace')) {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  if (!relativePath || (policy.canRead && !policy.canRead(relativePath))) return notFound(res);
  const parsedIfMatch = parseIfMatch(req.headers['if-match']);
  if (parsedIfMatch == null || parsedIfMatch === '*') {
    res.writeHead(428, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('If-Match required');
    return;
  }

  const root = fs.realpathSync(policy.filesystemRoot);
  if (hasSymlinkSegment(root, relativePath)) return notFound(res);
  const lexicalPath = path.resolve(root, ...relativePath.split('/'));
  const lexicalRelative = path.relative(root, lexicalPath);
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) return notFound(res);

  const content = await readBody(req, policy.maxWriteBytes ?? policy.maxFileBytes);
  if (!content) {
    res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Payload too large');
    return;
  }

  await withWriteLock(lexicalPath, async () => {
    let before: fs.Stats;
    try {
      before = await fs.promises.lstat(lexicalPath);
    } catch {
      return notFound(res);
    }
    if (before.isSymbolicLink() || !before.isFile()) return notFound(res);
    const currentEtag = fileEtag(before);
    if (ifMatchSatisfied(req.headers['if-match'], currentEtag) !== true) {
      res.writeHead(412, { 'Content-Type': 'text/plain; charset=utf-8', ETag: currentEtag });
      res.end('Precondition failed');
      return;
    }

    const oldContent = await fs.promises.readFile(lexicalPath);
    const tempPath = `${lexicalPath}.private-web-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    try {
      await fs.promises.writeFile(tempPath, content, { flag: 'wx' });
      const [parentRealPath, targetRealPath, revalidated] = await Promise.all([
        fs.promises.realpath(path.dirname(lexicalPath)),
        fs.promises.realpath(lexicalPath),
        fs.promises.lstat(lexicalPath),
      ]);
      if (
        parentRealPath !== path.dirname(lexicalPath) ||
        targetRealPath !== lexicalPath ||
        revalidated.isSymbolicLink() ||
        !revalidated.isFile() ||
        hasSymlinkSegment(root, relativePath) ||
        (policy.canRead && !policy.canRead(relativePath))
      ) {
        throw new Error('write target changed');
      }
      if (fileEtag(revalidated) !== currentEtag) {
        res.writeHead(412, { 'Content-Type': 'text/plain; charset=utf-8', ETag: fileEtag(revalidated) });
        res.end('Precondition failed');
        return;
      }
      await fs.promises.rename(tempPath, lexicalPath);
    } catch (err) {
      if (err instanceof Error && err.message === 'write target changed') {
        res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Write target changed');
        return;
      }
      throw err;
    } finally {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
    const after = await fs.promises.stat(lexicalPath);
    policy.onReplace?.({ relativePath, oldContent, newContent: content });
    res.writeHead(204, { ETag: fileEtag(after), 'Cache-Control': policy.cacheControl });
    res.end();
  });
}

export async function serveWebRoot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: WebRootPolicy,
): Promise<void> {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT') {
    const allow = policy.capabilities.has('replace') ? 'GET, HEAD, PUT' : 'GET, HEAD';
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: allow });
    res.end('Method not allowed');
    return;
  }

  let relativePath = readRelativePath(req);
  if (relativePath === null) {
    notFound(res);
    return;
  }
  if (method === 'PUT') return replaceFile(req, res, policy, relativePath);
  if (!policy.capabilities.has('read')) return notFound(res);
  if (hasSymlinkSegment(policy.filesystemRoot, relativePath)) return notFound(res);

  const requestedPath = resolveSafe(policy.filesystemRoot, relativePath);
  if (!requestedPath) {
    notFound(res);
    return;
  }

  let requestedStat: fs.Stats;
  try {
    requestedStat = fs.lstatSync(requestedPath);
  } catch {
    notFound(res);
    return;
  }

  if (requestedStat.isSymbolicLink()) return notFound(res);
  if (requestedStat.isDirectory()) {
    relativePath = relativePath ? `${relativePath}/index.html` : 'index.html';
  }

  if (policy.canRead && !policy.canRead(relativePath)) return notFound(res);
  const opened = openVerifiedFile(policy.filesystemRoot, relativePath);
  if (!opened) return notFound(res);
  const { absolutePath, fd, stat } = opened;
  let ownsFd = true;
  const closeFd = (): void => {
    if (!ownsFd) return;
    ownsFd = false;
    fs.closeSync(fd);
  };
  if (!stat.isFile() || stat.size > policy.maxFileBytes || (policy.canRead && !policy.canRead(relativePath))) {
    closeFd();
    notFound(res);
    return;
  }

  const baseHeaders: http.OutgoingHttpHeaders = {
    'Content-Type': siteMimeFor(absolutePath),
    'Last-Modified': stat.mtime.toUTCString(),
    ETag: fileEtag(stat),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': policy.cacheControl,
    'Accept-Ranges': 'bytes',
    ...policy.headers?.(absolutePath),
  };
  policy.onRead?.(relativePath);

  const stream = (options?: { start: number; end: number }): void => {
    ownsFd = false;
    const input = fs.createReadStream(absolutePath, { ...options, fd, autoClose: true });
    input.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Read failed');
      } else {
        res.destroy(err);
      }
    });
    input.pipe(res);
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      const size = stat.size;
      let start = match[1] ? parseInt(match[1], 10) : NaN;
      let end = match[2] ? parseInt(match[2], 10) : NaN;
      if (Number.isNaN(start)) {
        start = Math.max(0, size - end);
        end = size - 1;
      } else if (Number.isNaN(end)) {
        end = size - 1;
      }
      if (start > end || start >= size) {
        closeFd();
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      if (method === 'HEAD') {
        closeFd();
        res.end();
        return;
      }
      stream({ start, end });
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
  if (method === 'HEAD') {
    closeFd();
    res.end();
    return;
  }
  stream();
}
