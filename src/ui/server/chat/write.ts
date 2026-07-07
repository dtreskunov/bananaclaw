/**
 * Write operations for the file browser: upload, mkdir, rename, delete.
 *
 * All ops require admin privilege over the group. `canWrite()` from
 * classify.ts gates the target path on top of that. Path safety always
 * goes through `resolveSafe()`.
 */
import Busboy from 'busboy';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { URL } from 'url';

import { GROUPS_DIR } from '../../../config.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import { listAccessibleAgentGroups } from '../../../modules/permissions/access.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { recordAccess } from '../auth.js';
import { canWrite, resolveSafe } from './classify.js';

const UPLOAD_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB per file
const UPLOAD_MAX_FILES = 50;
const UPLOAD_MAX_FILENAME = 255;
const WRITE_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB per in-place edit

type Mode = 'skip' | 'overwrite' | 'rename';

interface UploadResult {
  name: string;
  path?: string;
  status: 'ok' | 'conflict' | 'forbidden' | 'too_large' | 'invalid_name' | 'error';
  size?: number;
  reason?: string;
}

/** Match `/api/groups/<groupId>/<op>` for write ops. Returns null if not matched. */
export function matchWritePath(
  pathname: string,
): { kind: 'upload' | 'mkdir' | 'touch' | 'rename' | 'delete' | 'write'; groupId: string } | null {
  const m = pathname.match(/^\/api\/groups\/([^/]+)\/(upload|mkdir|touch|rename|delete|write)$/);
  if (!m) return null;
  return { kind: m[2] as 'upload' | 'mkdir' | 'touch' | 'rename' | 'delete' | 'write', groupId: m[1] };
}

/** Dispatch a write op. Returns true if handled. */
export async function handleWriteRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  userId: string,
): Promise<boolean> {
  const m = matchWritePath(pathname);
  if (!m) return false;
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  const group = resolveGroupAccess(userId, m.groupId);
  if (!group) {
    writeJson(res, 403, { error: 'forbidden' });
    return true;
  }
  const isAdmin = hasAdminPrivilege(userId, group.id);
  if (!isAdmin) {
    writeJson(res, 403, { error: 'admin_required' });
    return true;
  }
  const groupDir = path.resolve(GROUPS_DIR, group.folder);

  try {
    if (m.kind === 'upload') return handleUpload(req, res, url, userId, group.id, groupDir);
    if (m.kind === 'mkdir') return handleMkdir(req, res, userId, group.id, groupDir);
    if (m.kind === 'touch') return handleTouch(req, res, userId, group.id, groupDir);
    if (m.kind === 'write') return handleFileWrite(req, res, userId, group.id, groupDir);
    if (m.kind === 'rename') return handleRename(req, res, userId, group.id, groupDir);
    if (m.kind === 'delete') return handleDelete(req, res, userId, group.id, groupDir);
  } catch (err) {
    log.error('file write op failed', { groupId: group.id, op: m.kind, err });
    writeJson(res, 500, { error: 'internal_error' });
    return true;
  }
  return true;
}

// ── upload ────────────────────────────────────────────────────────────────

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  userId: string,
  groupId: string,
  groupDir: string,
): Promise<boolean> {
  const dir = url.searchParams.get('path') ?? '';
  const mode = (url.searchParams.get('mode') ?? 'skip') as Mode;
  if (!['skip', 'overwrite', 'rename'].includes(mode)) {
    writeJson(res, 400, { error: 'invalid_mode' });
    return true;
  }
  // Validate the directory (must exist and be a directory).
  const dirAbs = resolveSafe(groupDir, dir);
  if (!dirAbs) {
    writeJson(res, 400, { error: 'invalid_path' });
    return true;
  }
  try {
    const st = fs.statSync(dirAbs);
    if (!st.isDirectory()) {
      writeJson(res, 400, { error: 'not_a_directory' });
      return true;
    }
  } catch {
    writeJson(res, 404, { error: 'not_found' });
    return true;
  }

  const ctype = (req.headers['content-type'] || '').toLowerCase();
  if (!ctype.startsWith('multipart/form-data')) {
    writeJson(res, 400, { error: 'expected_multipart' });
    return true;
  }

  const results: UploadResult[] = await new Promise((resolve, reject) => {
    const out: UploadResult[] = [];
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: {
          fileSize: UPLOAD_MAX_FILE_SIZE,
          files: UPLOAD_MAX_FILES,
          fieldNameSize: 64,
        },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const pending: Promise<void>[] = [];

    bb.on('file', (_field, stream, info) => {
      const rawName = (info.filename || 'upload').slice(0, UPLOAD_MAX_FILENAME);
      const name = sanitizeBasename(rawName);
      if (!name) {
        stream.resume();
        out.push({ name: rawName, status: 'invalid_name' });
        return;
      }
      const targetRel = dir ? `${dir}/${name}` : name;
      const writeCheck = canWrite(targetRel, { isAdmin: true });
      if (!writeCheck.ok) {
        stream.resume();
        out.push({ name, status: 'forbidden', reason: writeCheck.reason });
        return;
      }
      const targetAbs = resolveSafe(groupDir, targetRel);
      if (!targetAbs) {
        stream.resume();
        out.push({ name, status: 'invalid_name' });
        return;
      }

      pending.push(
        writeOneFile(stream, targetAbs, mode).then(
          (r) => {
            out.push({ name, status: r.status, path: r.finalRel ?? targetRel, size: r.size, reason: r.reason });
            if (r.status === 'ok') {
              recordAccess({ userId, groupId, path: r.finalRel ?? targetRel, action: 'upload', req });
            }
          },
          (err) => {
            log.warn('upload write failed', { name, err: (err as Error).message });
            out.push({ name, status: 'error', reason: (err as Error).message });
          },
        ),
      );
    });
    bb.on('filesLimit', () => out.push({ name: '', status: 'error', reason: 'too_many_files' }));
    bb.on('error', (err) => reject(err));
    bb.on('close', () => {
      Promise.all(pending).then(() => resolve(out), reject);
    });
    req.pipe(bb);
  });

  writeJson(res, 200, { results });
  return true;

  /** Internal: stream `stream` to disk, applying `mode` for existing targets. */
  async function writeOneFile(
    stream: NodeJS.ReadableStream,
    targetAbs: string,
    writeMode: Mode,
  ): Promise<{ status: UploadResult['status']; size?: number; finalRel?: string; reason?: string }> {
    let finalAbs = targetAbs;
    const exists = safeExists(finalAbs);
    if (exists) {
      if (writeMode === 'skip') {
        stream.resume();
        return { status: 'conflict' };
      }
      if (writeMode === 'rename') {
        finalAbs = nextAvailableName(targetAbs);
      }
      // overwrite: write straight to finalAbs via tmp.
    }
    const tmpAbs = `${finalAbs}.upload-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.promises.mkdir(path.dirname(finalAbs), { recursive: true });
      let limitHit = false;
      stream.on('limit', () => {
        limitHit = true;
      });
      const ws = fs.createWriteStream(tmpAbs, { flags: 'wx' });
      await new Promise<void>((resolve2, reject2) => {
        stream.pipe(ws);
        ws.on('finish', () => resolve2());
        ws.on('error', reject2);
        stream.on('error', reject2);
      });
      if (limitHit) {
        await fs.promises.unlink(tmpAbs).catch(() => undefined);
        return { status: 'too_large' };
      }
      await fs.promises.rename(tmpAbs, finalAbs);
      const st = await fs.promises.stat(finalAbs);
      const finalRel = path.relative(groupDir, finalAbs).split(path.sep).join('/');
      return { status: 'ok', size: st.size, finalRel };
    } catch (err) {
      await fs.promises.unlink(tmpAbs).catch(() => undefined);
      throw err;
    }
  }
}

// ── mkdir ─────────────────────────────────────────────────────────────────

async function handleMkdir(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  groupId: string,
  groupDir: string,
): Promise<boolean> {
  const body = await readJsonBody(req);
  const relPath = stringField(body, 'path');
  if (!relPath) {
    writeJson(res, 400, { error: 'missing_path' });
    return true;
  }
  const check = canWrite(relPath, { isAdmin: true });
  if (!check.ok) {
    writeJson(res, 403, { error: 'forbidden', reason: check.reason });
    return true;
  }
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) {
    writeJson(res, 400, { error: 'invalid_path' });
    return true;
  }
  if (safeExists(abs)) {
    writeJson(res, 409, { error: 'exists' });
    return true;
  }
  try {
    await fs.promises.mkdir(abs, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      writeJson(res, 400, { error: 'parent_missing' });
      return true;
    }
    throw err;
  }
  recordAccess({ userId, groupId, path: relPath, action: 'mkdir', req });
  writeJson(res, 200, { ok: true, path: relPath });
  return true;
}

// ── touch (create empty file) ────────────────────────────────────────

async function handleTouch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  groupId: string,
  groupDir: string,
): Promise<boolean> {
  const body = await readJsonBody(req);
  const relPath = stringField(body, 'path');
  if (!relPath) {
    writeJson(res, 400, { error: 'missing_path' });
    return true;
  }
  const check = canWrite(relPath, { isAdmin: true });
  if (!check.ok) {
    writeJson(res, 403, { error: 'forbidden', reason: check.reason });
    return true;
  }
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) {
    writeJson(res, 400, { error: 'invalid_path' });
    return true;
  }
  if (safeExists(abs)) {
    writeJson(res, 409, { error: 'exists' });
    return true;
  }
  try {
    const fh = await fs.promises.open(abs, 'wx');
    await fh.close();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      writeJson(res, 400, { error: 'parent_missing' });
      return true;
    }
    if (code === 'EEXIST') {
      writeJson(res, 409, { error: 'exists' });
      return true;
    }
    throw err;
  }
  recordAccess({ userId, groupId, path: relPath, action: 'touch', req });
  writeJson(res, 200, { ok: true, path: relPath });
  return true;
}

// ── write (overwrite an existing file's content) ─────────────────────

async function handleFileWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  groupId: string,
  groupDir: string,
): Promise<boolean> {
  const body = await readJsonBody(req, WRITE_MAX_BODY_SIZE);
  const relPath = stringField(body, 'path');
  if (!relPath) {
    writeJson(res, 400, { error: 'missing_path' });
    return true;
  }
  const content = (body as Record<string, unknown>)?.content;
  if (typeof content !== 'string') {
    writeJson(res, 400, { error: 'missing_content' });
    return true;
  }
  const check = canWrite(relPath, { isAdmin: true });
  if (!check.ok) {
    writeJson(res, 403, { error: 'forbidden', reason: check.reason });
    return true;
  }
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) {
    writeJson(res, 400, { error: 'invalid_path' });
    return true;
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch {
    writeJson(res, 404, { error: 'not_found' });
    return true;
  }
  if (!st.isFile()) {
    writeJson(res, 400, { error: 'not_a_file' });
    return true;
  }
  const buf = Buffer.from(content, 'utf8');
  if (buf.length > WRITE_MAX_BODY_SIZE) {
    writeJson(res, 413, { error: 'too_large' });
    return true;
  }
  // Write via a sibling tmp file + atomic rename so a partial write never
  // clobbers the original on error.
  const tmpAbs = `${abs}.write-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmpAbs, buf, { flag: 'wx' });
    await fs.promises.rename(tmpAbs, abs);
  } catch (err) {
    await fs.promises.unlink(tmpAbs).catch(() => undefined);
    throw err;
  }
  const after = await fs.promises.stat(abs);
  recordAccess({ userId, groupId, path: relPath, action: 'write', req });
  writeJson(res, 200, { ok: true, path: relPath, size: after.size, mtime: after.mtime.toISOString() });
  return true;
}

// ── rename ────────────────────────────────────────────────────────────────

async function handleRename(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  groupId: string,
  groupDir: string,
): Promise<boolean> {
  const body = await readJsonBody(req);
  const fromRel = stringField(body, 'from');
  const toRel = stringField(body, 'to');
  if (!fromRel || !toRel) {
    writeJson(res, 400, { error: 'missing_from_or_to' });
    return true;
  }
  for (const p of [fromRel, toRel]) {
    const c = canWrite(p, { isAdmin: true });
    if (!c.ok) {
      writeJson(res, 403, { error: 'forbidden', reason: c.reason, path: p });
      return true;
    }
  }
  const fromAbs = resolveSafe(groupDir, fromRel);
  const toAbs = resolveSafe(groupDir, toRel);
  if (!fromAbs || !toAbs) {
    writeJson(res, 400, { error: 'invalid_path' });
    return true;
  }
  if (!safeExists(fromAbs)) {
    writeJson(res, 404, { error: 'not_found' });
    return true;
  }
  if (safeExists(toAbs)) {
    writeJson(res, 409, { error: 'exists' });
    return true;
  }
  await fs.promises.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.promises.rename(fromAbs, toAbs);
  recordAccess({ userId, groupId, path: `${fromRel} -> ${toRel}`, action: 'rename', req });
  writeJson(res, 200, { ok: true, path: toRel });
  return true;
}

// ── delete ────────────────────────────────────────────────────────────────

async function handleDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  groupId: string,
  groupDir: string,
): Promise<boolean> {
  const body = await readJsonBody(req);
  const relPath = stringField(body, 'path');
  if (!relPath) {
    writeJson(res, 400, { error: 'missing_path' });
    return true;
  }
  const check = canWrite(relPath, { isAdmin: true });
  if (!check.ok) {
    writeJson(res, 403, { error: 'forbidden', reason: check.reason });
    return true;
  }
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) {
    writeJson(res, 400, { error: 'invalid_path' });
    return true;
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch {
    writeJson(res, 404, { error: 'not_found' });
    return true;
  }
  if (st.isDirectory()) {
    // Recursive delete, but only after a safety check: refuse if the dir
    // contains hidden/protected names. Forces the user to clean those up
    // through the proper channel first.
    if (hasProtectedDescendant(abs, groupDir)) {
      writeJson(res, 409, { error: 'contains_protected' });
      return true;
    }
    await fs.promises.rm(abs, { recursive: true, force: true });
  } else {
    await fs.promises.unlink(abs);
  }
  recordAccess({ userId, groupId, path: relPath, action: 'delete', req });
  writeJson(res, 200, { ok: true, path: relPath });
  return true;
}

// ── helpers ───────────────────────────────────────────────────────────────

function resolveGroupAccess(userId: string, groupId: string): { id: string; folder: string } | null {
  const groups = listAccessibleAgentGroups(userId);
  const match = groups.find((g) => g.id === groupId);
  if (!match) return null;
  const full = getAgentGroup(groupId);
  return full ? { id: full.id, folder: full.folder } : null;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function stringField(body: unknown, key: string): string | null {
  const v = (body as Record<string, unknown>)?.[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
}

function safeExists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function nextAvailableName(abs: string): string {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${stem}-${n}${ext}`);
    if (!safeExists(candidate)) return candidate;
  }
  // Fall back to a random suffix; extremely unlikely.
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** Reject basename if it contains path separators or is reserved. */
function sanitizeBasename(name: string): string | null {
  const base = path.basename(name);
  if (!base || base === '.' || base === '..') return null;
  if (base.includes('/') || base.includes('\\')) return null;
  if (base.startsWith('.')) return null; // no dotfiles via upload
  return base;
}

function hasProtectedDescendant(abs: string, groupDir: string): boolean {
  // Cheap scan: walk one level; if anything resolves to hidden/protected per
  // canWrite (admin context), bail.
  const stack: string[] = [abs];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childAbs = path.join(cur, e.name);
      const childRel = path.relative(groupDir, childAbs).split(path.sep).join('/');
      const check = canWrite(childRel, { isAdmin: true });
      if (!check.ok) return true;
      if (e.isDirectory()) stack.push(childAbs);
    }
  }
  return false;
}
