// Unified actions menu for a directory context or a single file-system entry.
import './ActionsMenu.css';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  pinnedContext, isAdmin, treeEntries, groupId, shareModalRequest,
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

function buildEntryItems(entry: TreeEntry, gid: string | null, admin: boolean, onEdit?: () => void, onEntryChanged?: () => void): Item[] {
  const items: Item[] = [];
  if (onEdit) items.push({ ico: '\u270E', label: 'Edit', onClick: onEdit });
  items.push({ ico: '\u2B07', label: 'Download', onClick: () => downloadPaths([entry.path], [entry]) });
  if (entry.type !== 'dir') {
    items.push({ ico: '\u2197', label: 'Open in new tab', onClick: () => openInNewTab(gid, entry.path) });
    items.push({ ico: '\u21AA', label: 'Share privately', onClick: () => sharePrivate(gid, entry) });
    items.push({ ico: '\uD83D\uDD17', label: 'Share with link\u2026', onClick: () => shareWithToken(gid, entry) });
  }
  if (admin) {
    items.push('---');
    items.push({ ico: '\u270E', label: 'Rename', onClick: () => { renameEntry(entry).then(onEntryChanged).catch(console.error); } });
    items.push({ ico: '\uD83D\uDDD1', label: 'Delete', danger: true, onClick: () => { deleteEntry(entry).then(onEntryChanged).catch(console.error); } });
  }
  return items;
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
  mode: 'create' | 'directory' | 'entry';
  entry?: TreeEntry;
  onNewFile?: () => void;
  onUpload?: () => void;
  onEdit?: () => void;
  onEntryChanged?: () => void;
  includeSelection?: boolean;
  triggerClassName?: string;
  triggerTitle?: string;
  triggerContent?: ComponentChildren;
  showWhenEmpty?: boolean;
  onAction?: () => void;
  panelAlign?: 'start' | 'end';
}

export function ActionsMenu({
  mode,
  entry,
  onNewFile,
  onUpload,
  onEdit,
  onEntryChanged,
  includeSelection = mode === 'directory',
  triggerClassName = 'text-btn',
  triggerTitle = 'Actions',
  triggerContent = '\u22EF',
  showWhenEmpty = false,
  onAction,
  panelAlign = 'end',
}: Props) {
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

  const items = buildItems(mode, entry, onNewFile, onUpload, onEdit, onEntryChanged, includeSelection);
  if (items.length === 0 && !showWhenEmpty) return null;

  return (
    <div class={`action-menu align-${panelAlign}${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        class={`${triggerClassName} action-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerTitle}
        aria-label={triggerTitle}
        disabled={items.length === 0}
        onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
          ev.stopPropagation();
          setOpen(!open);
        }}
      >{triggerContent}</button>
      {open ? (
        <div class="action-panel flush-menu-panel" role="menu">
          {items.map((it, i) => it === '---'
            ? <div class="action-sep" key={'s' + i}></div>
            : (
              <button
                type="button"
                class={'action-item' + (it.danger ? ' danger' : '')}
                role="menuitem"
                key={`${i}:${it.label}`}
                disabled={it.disabled}
                onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
                  ev.stopPropagation();
                  setOpen(false);
                  onAction?.();
                  it.onClick();
                }}
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

function appendGroup(items: Item[], group: Item[]): void {
  if (group.length === 0) return;
  if (items.length > 0) items.push('---');
  items.push(...group);
}

function buildItems(
  mode: 'create' | 'directory' | 'entry',
  entry: TreeEntry | undefined,
  onNewFile?: () => void,
  onUpload?: () => void,
  onEdit?: () => void,
  onEntryChanged?: () => void,
  includeSelection = true,
): Item[] {
  const admin = isAdmin.value;
  const gid = groupId.value;
  if (mode === 'entry') return entry ? buildEntryItems(entry, gid, admin, onEdit, onEntryChanged) : [];

  if (mode === 'create') {
    if (!admin) return [];
    const items: Item[] = [];
    if (onNewFile) items.push({ ico: '\uD83D\uDCC4', label: 'New file', onClick: onNewFile });
    items.push({ ico: '\uD83D\uDCC1', label: 'New folder', onClick: () => mkdirPrompt(entry?.path) });
    if (onUpload) items.push({ ico: '\u2B06', label: 'Upload files\u2026', onClick: onUpload });
    return items;
  }

  const sel = pinnedContext.value;
  const selEntries = entriesByPath(sel);
  const items: Item[] = [];
  if (entry) appendGroup(items, buildEntryItems(entry, gid, admin, undefined, onEntryChanged));
  if (includeSelection && sel.length > 0) {
    const selectionItems: Item[] = [
      { ico: '\u2B07', label: sel.length > 1 ? `Download ${sel.length} (zip)` : 'Download selection', onClick: () => downloadPaths(sel, selEntries) },
    ];
    if (admin) {
      if (sel.length === 1 && selEntries.length === 1) {
        selectionItems.push({ ico: '\u270E', label: 'Rename selection', onClick: () => renameEntry(selEntries[0]!) });
      }
      selectionItems.push({ ico: '\uD83D\uDDD1', label: sel.length > 1 ? `Delete ${sel.length}` : 'Delete selection', danger: true, onClick: () => deletePaths(sel) });
    }
    selectionItems.push('---');
    selectionItems.push({ ico: '\u2715', label: 'Clear selection', onClick: clearPinnedContext });
    appendGroup(items, selectionItems);
  }
  return items;
}
