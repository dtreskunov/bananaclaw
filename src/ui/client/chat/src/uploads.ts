// Admin write operations + upload progress strip.
import { groupId, isAdmin, uploadItems, threadId, treePath, pinnedContext } from './state';
import { postJson } from './api';
import { loadTree } from './actions';
import { requestInput, requestConfirm } from './components/PromptModal';
import { showToast } from './components/Toast';
import type { TreeEntry, UploadItem } from './types';

function curDir(): string {
  return treePath.value || '';
}
function joinPath(dir: string, name: string): string {
  return dir ? dir + '/' + name : name;
}

interface ApiError {
  error?: string;
}

function dropPinned(paths: string[]): void {
  if (paths.length === 0) return;
  pinnedContext.value = pinnedContext.value.filter((p) => !paths.some((d) => p === d || p.startsWith(d + '/')));
}

interface WriteFileResponse extends ApiError {
  ok?: boolean;
  size?: number;
  mtime?: string;
}

/**
 * Overwrite an existing file's text content. Returns the new size/mtime on
 * success, or null on failure (a toast is shown).
 */
export async function saveFile(relPath: string, content: string): Promise<{ size?: number; mtime?: string } | null> {
  if (!groupId.value || !isAdmin.value) return null;
  const r = await postJson<WriteFileResponse>(`api/groups/${groupId.value}/write`, { path: relPath, content });
  if (!r.ok || !r.data.ok) {
    showToast('save failed: ' + (r.data.error || r.status), 'err');
    return null;
  }
  return { size: r.data.size, mtime: r.data.mtime };
}

export async function mkdirPrompt(): Promise<void> {
  if (!groupId.value || !isAdmin.value) return;
  const name = await requestInput({ title: 'New folder', placeholder: 'folder name', okLabel: 'Create' });
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const target = joinPath(curDir(), trimmed);
  const r = await postJson<ApiError>(`api/groups/${groupId.value}/mkdir`, { path: target });
  if (!r.ok) {
    showToast('mkdir failed: ' + (r.data.error || r.status), 'err');
    return;
  }
  await loadTree(treePath.value);
}

export async function touchPrompt(): Promise<void> {
  if (!groupId.value || !isAdmin.value) return;
  const name = await requestInput({ title: 'New file', placeholder: 'file name', okLabel: 'Create' });
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const target = joinPath(curDir(), trimmed);
  const r = await postJson<ApiError>(`api/groups/${groupId.value}/touch`, { path: target });
  if (!r.ok) {
    showToast('create file failed: ' + (r.data.error || r.status), 'err');
    return;
  }
  await loadTree(treePath.value);
}

export async function renameEntry(entry: TreeEntry): Promise<void> {
  if (!isAdmin.value || !groupId.value) return;
  const next = await requestInput({
    title: 'Rename',
    placeholder: entry.name,
    initialValue: entry.name,
    okLabel: 'Rename',
  });
  if (!next) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === entry.name) return;
  const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
  const toPath = joinPath(dir, trimmed);
  const r = await postJson<ApiError>(`api/groups/${groupId.value}/rename`, { from: entry.path, to: toPath });
  if (!r.ok) {
    showToast('rename failed: ' + (r.data.error || r.status), 'err');
    return;
  }
  pinnedContext.value = pinnedContext.value.map((p) =>
    p === entry.path ? toPath : p.startsWith(entry.path + '/') ? toPath + p.slice(entry.path.length) : p,
  );
  await loadTree(treePath.value);
}

export async function deleteEntry(entry: TreeEntry): Promise<void> {
  if (!isAdmin.value || !groupId.value) return;
  const ok = await requestConfirm({
    title: `Delete ${entry.type === 'dir' ? 'folder' : 'file'}`,
    message: `Delete ${entry.type === 'dir' ? 'folder' : 'file'} "${entry.name}"?`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const r = await postJson<ApiError>(`api/groups/${groupId.value}/delete`, { path: entry.path });
  if (!r.ok) {
    showToast('delete failed: ' + (r.data.error || r.status), 'err');
    return;
  }
  dropPinned([entry.path]);
  await loadTree(treePath.value);
}

export async function deletePaths(paths: string[]): Promise<void> {
  if (!isAdmin.value || !groupId.value || paths.length === 0) return;
  const ok = await requestConfirm({
    title: 'Delete items',
    message: `Delete ${paths.length} item${paths.length === 1 ? '' : 's'}?`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const errors: string[] = [];
  const succeeded: string[] = [];
  for (const p of paths) {
    const r = await postJson<ApiError>(`api/groups/${groupId.value}/delete`, { path: p });
    if (!r.ok) errors.push(`${p}: ${r.data.error || r.status}`);
    else succeeded.push(p);
  }
  if (errors.length) showToast('Some deletes failed:\n' + errors.join('\n'), 'err');
  dropPinned(succeeded);
  await loadTree(treePath.value);
}

export function downloadPaths(paths: string[], entries?: TreeEntry[] | null): void {
  if (!groupId.value || paths.length === 0) return;
  if (paths.length === 1) {
    const single = paths[0]!;
    const entry = entries?.find((e) => e.path === single);
    if (entry && entry.type !== 'dir') {
      const segs = String(single || '')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent);
      const url = `api/groups/${encodeURIComponent(groupId.value)}/files/${segs.join('/')}`;
      triggerDownload(url, entry.name);
      return;
    }
  }
  const qs = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
  triggerDownload(`api/groups/${groupId.value}/zip?${qs}`);
}

function triggerDownload(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── upload + progress strip ─────────────────────────────────────────
function updateItem(idx: number, patch: Partial<UploadItem>): void {
  const next = uploadItems.value.slice();
  const cur = next[idx];
  if (!cur) return;
  next[idx] = { ...cur, ...patch };
  uploadItems.value = next;
}

export function clearUploadStrip(): void {
  uploadItems.value = [];
}

export function resolveConflict(idx: number, action: 'overwrite' | 'rename' | 'skip'): void {
  if (action === 'skip') {
    updateItem(idx, { status: 'error', statusText: 'skipped' });
    return;
  }
  updateItem(idx, { status: 'uploading', pct: 0, statusText: 'uploading\u2026' });
  uploadOne(idx, action).catch((err: unknown) =>
    updateItem(idx, {
      status: 'error',
      statusText: String((err as Error)?.message || err),
    }),
  );
}

interface UploadResultRow {
  status?: string;
  reason?: string;
  path?: string;
}
interface UploadResponse {
  results?: UploadResultRow[];
}

function uploadOne(idx: number, mode: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const item = uploadItems.value[idx];
    if (!item) {
      resolve();
      return;
    }
    const fd = new FormData();
    fd.append('file', item.file, item.name);
    const xhr = new XMLHttpRequest();
    const url = `api/groups/${groupId.value}/upload?path=${encodeURIComponent(curDir())}&mode=${encodeURIComponent(mode)}`;
    xhr.open('POST', url);
    xhr.upload.onprogress = (ev: ProgressEvent) => {
      if (ev.lengthComputable) updateItem(idx, { pct: (ev.loaded / ev.total) * 100 });
    };
    xhr.onload = () => {
      let body: UploadResponse = {};
      try {
        body = JSON.parse(xhr.responseText || '{}') as UploadResponse;
      } catch {
        /* ignore */
      }
      const r: UploadResultRow = (body.results && body.results[0]) || {};
      if (xhr.status >= 200 && xhr.status < 300 && r.status === 'ok') {
        updateItem(idx, { status: 'ok', statusText: 'uploaded', path: r.path ?? null });
      } else if (r.status === 'conflict') {
        updateItem(idx, { status: 'conflict', statusText: 'file exists' });
      } else {
        updateItem(idx, { status: 'error', statusText: r.reason || r.status || 'http ' + xhr.status });
      }
      resolve();
    };
    xhr.onerror = () => {
      updateItem(idx, { status: 'error', statusText: 'network error' });
      resolve();
    };
    xhr.send(fd);
  });
}

export async function uploadFiles(fileList: FileList | File[] | null | undefined): Promise<void> {
  if (!groupId.value || !isAdmin.value || !fileList || fileList.length === 0) return;
  uploadItems.value = Array.from(fileList).map((file) => ({
    file,
    name: file.name,
    size: file.size,
    status: 'uploading' as const,
    pct: 0,
    statusText: 'uploading\u2026',
    path: null,
  }));
  for (let i = 0; i < uploadItems.value.length; i++) {
    await uploadOne(i, 'skip').catch((err: unknown) =>
      updateItem(i, {
        status: 'error',
        statusText: String((err as Error)?.message || err),
      }),
    );
  }
  await loadTree(treePath.value);
}

export async function notifyAgent(paths: string[]): Promise<void> {
  if (!threadId.value || !groupId.value || paths.length === 0) return;
  const list = paths
    .slice(0, 20)
    .map((p) => '`' + p + '`')
    .join(', ');
  const more = paths.length > 20 ? ` (and ${paths.length - 20} more)` : '';
  const text = `Files updated via web UI: ${list}${more}`;
  const r = await postJson<ApiError>(`api/groups/${groupId.value}/chat/${threadId.value}/send`, { text });
  if (!r.ok) {
    showToast('notify failed: ' + (r.data.error || r.status), 'err');
    return;
  }
  clearUploadStrip();
}
