// Unified actions menu. Three modes:
//   - 'header'  bulk on pinnedContext + create file/folder in current dir
//   - 'row'     single entry
//   - 'preview' acts on the currently-previewed file
import './ActionsMenu.css';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  pinnedContext, isAdmin, treeEntries, filePath, previewBlock, groupId, shareModalRequest,
} from '../state';
import { showToast } from './Toast';
import { clearPinnedContext } from '../actions';
import {
  mkdirPrompt, renameEntry, deleteEntry,
  deletePaths, downloadPaths,
} from '../uploads';
import type { TreeEntry } from '../types';

function fileUrl(gid: string, relPath: string): string {
  const segs = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent);
  return `api/groups/${encodeURIComponent(gid)}/files/${segs.join('/')}`;
}

function privateViewUrl(gid: string, relPath: string): string {
  const segs = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent);
  return `/ui/view/${encodeURIComponent(gid)}/${segs.join('/')}`;
}

function isHtmlPath(relPath: string): boolean {
  return /\.html?$/i.test(relPath);
}

function openInNewTab(gid: string | null, relPath: string | null): void {
  if (!gid || !relPath) return;
  window.open(isHtmlPath(relPath) ? privateViewUrl(gid, relPath) : fileUrl(gid, relPath), '_blank', 'noopener');
}

export async function sharePrivate(gid: string | null, entry: { path?: string; name?: string } | null | undefined): Promise<void> {
  if (!gid || !entry?.path) return;
  const relativeUrl = isHtmlPath(entry.path) ? privateViewUrl(gid, entry.path) : fileUrl(gid, entry.path);
  const url = new URL(relativeUrl, window.location.href).toString();
  const title = entry.name || entry.path.slice(entry.path.lastIndexOf('/') + 1);
  const navAny = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (navAny.share) {
    try { await navAny.share({ title, url }); return; } catch (err) {
      if (err && (err as { name?: string }).name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch {
    showToast('Copy failed', 'err');
  }
}

export const shareFile = sharePrivate;

export function shareWithToken(gid: string | null, entry: { path?: string; name?: string; type?: string } | null | undefined): void {
  if (!gid || !entry?.path) return;
  shareModalRequest.value = { groupId: gid, entry: { path: entry.path, name: entry.name || '', type: entry.type } };
}

function entriesByPath(paths: string[]): TreeEntry[] {
  const set = new Set(paths);
  return treeEntries.value.filter((e) => set.has(e.path));
}

interface ItemDef {
  ico: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

type Sep = '---';
type Item = ItemDef | Sep;

interface Props {
  mode: 'header' | 'row' | 'preview';
  entry?: TreeEntry;
  onUpload?: () => void;
}

export function ActionsMenu({ mode, entry, onUpload }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (ev: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = buildItems(mode, entry, onUpload);
  if (items.length === 0) return null;

  return (
    <div class={'action-menu' + (open ? ' open' : '')} ref={wrapRef}>
      <button
        type="button"
        class="text-btn action-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => { ev.stopPropagation(); setOpen((o) => !o); }}
      >{'\u22EF'}</button>
      {open ? (
        <div class="action-panel" role="menu">
          {items.map((it, i) => it === '---'
            ? <div class="action-sep" key={'s' + i}></div>
            : (
              <button
                type="button"
                class={'action-item' + (it.danger ? ' danger' : '')}
                role="menuitem"
                key={it.label}
                disabled={it.disabled}
                onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => { ev.stopPropagation(); setOpen(false); it.onClick(); }}
              >
                <span class="ico">{it.ico}</span>
                <span class="lbl">{it.label}</span>
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function buildItems(mode: 'header' | 'row' | 'preview', entry: TreeEntry | undefined, onUpload?: () => void): Item[] {
  const admin = isAdmin.value;
  const gid = groupId.value;
  if (mode === 'row' && entry) {
    const items: Item[] = [];
    items.push({ ico: '\u2B07', label: 'Download', onClick: () => downloadPaths([entry.path], [entry]) });
    if (entry.type !== 'dir') {
      items.push({ ico: '\u2197', label: 'Open in new tab', onClick: () => openInNewTab(gid, entry.path) });
      items.push({ ico: '\u21AA', label: 'Share privately', onClick: () => sharePrivate(gid, entry) });
      items.push({ ico: '\uD83D\uDD17', label: 'Share with link\u2026', onClick: () => shareWithToken(gid, entry) });
    }
    if (admin) {
      items.push('---');
      items.push({ ico: '\u270E', label: 'Rename', onClick: () => renameEntry(entry) });
      items.push({ ico: '\uD83D\uDDD1', label: 'Delete', danger: true, onClick: () => deleteEntry(entry) });
    }
    return items;
  }

  if (mode === 'preview') {
    const p = previewBlock.value;
    const fp = filePath.value;
    if (!p) return [];
    const entryForPath: TreeEntry | null = treeEntries.value.find((e) => e.path === fp)
      || (fp ? { path: fp, name: p.name || '', type: 'file' } : null);
    const items: Item[] = [];
    items.push({ ico: '\u21AA', label: 'Share privately', onClick: () => sharePrivate(gid, entryForPath), disabled: !fp || !gid });
    items.push({ ico: '\uD83D\uDD17', label: 'Share with link\u2026', onClick: () => shareWithToken(gid, entryForPath), disabled: !fp || !gid });
    items.push({ ico: '\u2197', label: 'Open in new tab', onClick: () => openInNewTab(gid, fp), disabled: !fp || !gid });
    items.push({ ico: '\u2B07', label: 'Download', onClick: () => { if (fp && entryForPath) downloadPaths([fp], [entryForPath]); }, disabled: !fp });
    if (admin && entryForPath) {
      items.push('---');
      items.push({ ico: '\u270E', label: 'Rename', onClick: () => renameEntry(entryForPath) });
      items.push({ ico: '\uD83D\uDDD1', label: 'Delete', danger: true, onClick: () => deleteEntry(entryForPath) });
    }
    return items;
  }

  // header
  const sel = pinnedContext.value;
  const selEntries = entriesByPath(sel);
  const items: Item[] = [];
  if (admin) {
    items.push({ ico: '\uD83D\uDCC1', label: 'New folder', onClick: mkdirPrompt });
    if (onUpload) items.push({ ico: '\u2B06', label: 'Upload files\u2026', onClick: onUpload });
  }
  if (sel.length > 0) {
    if (items.length) items.push('---');
    items.push({ ico: '\u2B07', label: sel.length > 1 ? `Download ${sel.length} (zip)` : 'Download', onClick: () => downloadPaths(sel, selEntries) });
    if (admin) {
      if (sel.length === 1 && selEntries.length === 1) {
        items.push({ ico: '\u270E', label: 'Rename', onClick: () => renameEntry(selEntries[0]!) });
      }
      items.push({ ico: '\uD83D\uDDD1', label: sel.length > 1 ? `Delete ${sel.length}` : 'Delete', danger: true, onClick: () => deletePaths(sel) });
    }
    items.push('---');
    items.push({ ico: '\u2715', label: 'Clear selection', onClick: clearPinnedContext });
  }
  return items;
}
