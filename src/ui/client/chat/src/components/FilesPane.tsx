// Files pane: head + breadcrumb + upload strip + listing + drop hint +
// preview body.
import './FilesPane.css';
import type { ComponentChildren, JSX, VNode } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import {
  treePath, treeEntries, treeError, filePath, isAdmin,
  previewBlock, uploadItems, threadId, pinnedContext, groupId,
} from '../state';
import { navTree, navFile, closePreview, togglePinnedFile, loadTree, selectFile } from '../actions';
import {
  uploadFiles, clearUploadStrip, resolveConflict, notifyAgent, saveFile,
  createFile, promptNewFilePath, promptSaveAsPath, isEditableFileName,
} from '../uploads';
import { fmtBytes, renderMarkdown, parentPath } from '../utils';
import { Pane } from './Pane';
import { RelativeTime } from './RelativeTime';
import { ActionsMenu } from './ActionsMenu';
import { MediaPlayer } from './MediaPlayer';
import { LyricsPanel } from './LyricsPanel';
import { PrivateWebView } from './PrivateWebView';
import { requestChoice, requestConfirm } from './PromptModal';
import { highlightCode } from '../highlight';
import type { TreeEntry, PreviewKind } from '../types';

interface PreviewEditorState {
  editing: boolean;
  creating: boolean;
  saving: boolean;
  editable: boolean;
  draft: string;
  path: string | null;
  beginEdit: () => void;
  beginCreate: (path: string) => void;
  cancelEdit: () => Promise<boolean>;
  commitEdit: () => Promise<void>;
  setDraft: (value: string) => void;
}

function usePreviewEditor(): PreviewEditorState {
  const [editing, setEditing] = useState(false);
  const [createPath, setCreatePath] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const initialDraft = useRef('');
  const p = previewBlock.value;
  const fp = filePath.value;
  const editable = !!p && isAdmin.value && (p.kind === 'text' || p.kind === 'markdown' || p.kind === 'html');

  useEffect(() => {
    setEditing(false);
    setCreatePath(null);
    setSaving(false);
  }, [fp]);

  useEffect(() => {
    if (!editing || draft === initialDraft.current) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editing, draft]);

  const beginEdit = (): void => {
    const text = previewBlock.peek()?.text || '';
    initialDraft.current = text;
    setCreatePath(null);
    setDraft(text);
    setEditing(true);
  };
  const beginCreate = (path: string): void => {
    initialDraft.current = '';
    setCreatePath(path);
    setDraft('');
    setEditing(true);
  };
  const cancelEdit = async (): Promise<boolean> => {
    if (draft !== initialDraft.current) {
      const discard = await requestConfirm({
        title: 'Discard unsaved changes?',
        message: 'Your changes have not been saved.',
        okLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      if (!discard) return false;
    }
    setEditing(false);
    setCreatePath(null);
    return true;
  };
  const createDraft = async (initialPath: string): Promise<string | null> => {
    let targetPath: string | null = initialPath;
    while (targetPath) {
      const created = await createFile(targetPath, draft);
      if (!created) return null;
      if (!('exists' in created)) return targetPath;
      targetPath = await promptSaveAsPath(targetPath, 'File already exists');
    }
    return null;
  };
  const openCreatedFile = async (path: string): Promise<void> => {
    await loadTree(parentPath(path));
    await navFile({ path, name: path.slice(path.lastIndexOf('/') + 1) });
    setCreatePath(null);
    setEditing(false);
  };
  const commitEdit = async (): Promise<void> => {
    const targetPath = createPath || fp;
    if (!targetPath) return;
    setSaving(true);
    if (createPath) {
      const createdPath = await createDraft(createPath);
      setSaving(false);
      if (!createdPath) return;
      await openCreatedFile(createdPath);
      return;
    }
    let res = await saveFile(targetPath, draft, previewBlock.peek()?.etag);
    if (res && 'conflict' in res) {
      const resolution = await requestChoice({
        title: 'File changed on disk',
        message: 'This file was modified since you opened it. Save your draft as a separate file, overwrite the newer version, or keep editing.',
        options: [
          { value: 'keep', label: 'Keep editing' },
          { value: 'overwrite', label: 'Overwrite', tone: 'danger' },
          { value: 'copy', label: 'Save a copy', tone: 'primary' },
        ],
      });
      if (!resolution || resolution === 'keep') {
        setSaving(false);
        return;
      }
      if (resolution === 'copy') {
        const copyPath = await promptSaveAsPath(targetPath);
        if (!copyPath) {
          setSaving(false);
          return;
        }
        const createdPath = await createDraft(copyPath);
        setSaving(false);
        if (!createdPath) return;
        await openCreatedFile(createdPath);
        return;
      }
      res = await saveFile(targetPath, draft, res.etag);
    }
    setSaving(false);
    if (!res || 'conflict' in res) return;
    const cur = previewBlock.peek();
    if (cur && cur.path === targetPath) {
      previewBlock.value = {
        ...cur,
        text: draft,
        size: res.size ?? cur.size,
        mtime: res.mtime ?? cur.mtime,
        etag: res.etag ?? cur.etag,
      };
    }
    setEditing(false);
  };

  return {
    editing,
    creating: !!createPath,
    saving,
    editable,
    draft,
    path: createPath || fp,
    beginEdit,
    beginCreate,
    cancelEdit,
    commitEdit,
    setDraft,
  };
}

function Crumb({ editor }: { editor: PreviewEditorState }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const p = treePath.value;
  const fp = editor.creating ? editor.path : filePath.value;
  const preview = previewBlock.value;
  const currentDirectory = p
    ? { path: p, name: p.slice(p.lastIndexOf('/') + 1), type: 'dir' as const }
    : undefined;
  const previewEntry = fp
    ? { path: fp, name: preview?.name || fp.slice(fp.lastIndexOf('/') + 1), type: 'file' as const }
    : undefined;
  const pinned = !!fp && pinnedContext.value.includes(fp);
  const segs = p ? p.split('/').filter(Boolean) : [];
  const fileName = fp ? fp.slice(fp.lastIndexOf('/') + 1) : '';
  useEffect(() => {
    if (ref.current) requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
    });
  }, [p, fp]);
  const navigateTree = (path: string): void => {
    if (!editor.editing) {
      navTree(path);
      return;
    }
    editor.cancelEdit()
      .then((discarded) => { if (discarded) return navTree(path); })
      .catch(console.error);
  };
  let acc = '';
  return (
    <>
      <div class="files-actions rail-actions-row rail-divider-row">
        <input
          type="file"
          id="upload-input"
          multiple
          hidden
          ref={uploadInputRef}
          onChange={(ev: JSX.TargetedEvent<HTMLInputElement>) => {
            const files = ev.currentTarget.files;
            if (files && files.length) uploadFiles(files);
            ev.currentTarget.value = '';
          }}
        />
        {editor.editing ? (
          <>
            <button
              type="button"
              class="rail-control-btn save-btn"
              title={editor.saving ? 'Saving' : 'Save'}
              aria-label={editor.saving ? 'Saving' : 'Save'}
              disabled={editor.saving}
              onClick={() => { editor.commitEdit().catch(console.error); }}
            >{editor.saving ? '\u2026' : '\u2713'}</button>
            <button
              type="button"
              class="rail-control-btn cancel-btn"
              title="Discard changes"
              aria-label="Discard changes"
              disabled={editor.saving}
              onClick={() => { editor.cancelEdit().catch(console.error); }}
            >{'\u00D7'}</button>
          </>
        ) : previewEntry ? (
          <>
            <button
              type="button"
              class={'rail-control-btn attach-btn' + (pinned ? ' active' : '')}
              title={pinned ? 'Detach from next message' : 'Attach to next message'}
              aria-label={pinned ? 'Detach from next message' : 'Attach to next message'}
              aria-pressed={pinned}
              onClick={() => togglePinnedFile(fp)}
            >{'\uD83D\uDCCE'}</button>
            <button
              type="button"
              class="rail-control-btn refresh-btn"
              title="Refresh file"
              aria-label="Refresh file"
              onClick={() => { selectFile(previewEntry).catch(console.error); }}
            >{'\u21BB'}</button>
            <ActionsMenu
              mode="entry"
              entry={previewEntry}
              onEdit={editor.editable ? editor.beginEdit : undefined}
              triggerClassName="rail-control-btn"
              triggerTitle={`Actions for ${previewEntry.name}`}
            />
            <button
              type="button"
              class="rail-control-btn close-preview"
              title="Close preview"
              aria-label="Close preview"
              onClick={closePreview}
            >{'\u00D7'}</button>
          </>
        ) : (
          <>
            <button
              type="button"
              class="rail-control-btn refresh-btn"
              title="Refresh folder"
              aria-label="Refresh folder"
              onClick={() => { loadTree(treePath.peek()).catch(console.error); }}
            >{'\u21BB'}</button>
            <ActionsMenu
              mode="directory"
              entry={currentDirectory}
              onNewFile={() => {
                promptNewFilePath()
                  .then((path) => { if (path) editor.beginCreate(path); })
                  .catch(console.error);
              }}
              triggerClassName="rail-control-btn"
              triggerTitle={currentDirectory ? `Actions for ${currentDirectory.name}` : 'Root folder actions'}
              onUpload={() => uploadInputRef.current?.click()}
            />
          </>
        )}
      </div>
      <div class="breadcrumb rail-divider-row" id="crumb">
        <div class="breadcrumb-path" ref={ref}>
          <button
            type="button"
            class={'crumb root' + (segs.length === 0 && !fileName ? ' current' : '')}
            data-path=""
            title="Root"
            onClick={() => navigateTree('')}
          >/</button>
          {segs.map((s, i) => {
            acc = acc ? acc + '/' + s : s;
            const path = acc;
            const last = i === segs.length - 1 && !fileName;
            const onClick = last ? undefined : () => navigateTree(path);
            return (
              <span class="crumb-node" key={path}>
                <span class="sep" aria-hidden="true">{'\u203a'}</span>
                <button
                  type="button"
                  class={'crumb' + (last ? ' current' : '')}
                  data-path={path}
                  title={'/' + path}
                  onClick={onClick}
                >{s}</button>
              </span>
            );
          })}
          {fileName ? (
            <>
              <span class="sep" aria-hidden="true">{'\u203a'}</span>
              <span class="crumb file current" title={'/' + fp}>{fileName}</span>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

interface RowProps {
  e: TreeEntry;
  onEdit: (entry: TreeEntry) => void;
  onNewFile: (directory: string) => void;
  onUpload: (directory: string) => void;
}

function Row({ e, onEdit, onNewFile, onUpload }: RowProps) {
  const active = e.path === filePath.value;
  const selected = pinnedContext.value.includes(e.path);
  const onClick = (ev: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    const t = ev.target as HTMLElement;
    if (t.closest('.row-sel') || t.closest('.action-menu')) return;
    if (e.type === 'dir') navTree(e.path);
    else navFile(e).catch(console.error);
  };
  return (
    <div class={'row tier-' + e.tier + (active ? ' active' : '') + (selected ? ' selected' : '')} data-path={e.path} onClick={onClick}>
      <label class="row-sel" onClick={(ev: JSX.TargetedMouseEvent<HTMLLabelElement>) => ev.stopPropagation()} title={selected ? 'Detach from next message' : 'Attach to next message'}>
        <input type="checkbox" checked={selected} onChange={() => togglePinnedFile(e.path)} />
      </label>
      <div>{e.type === 'dir' ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}</div>
      <div class="name">{e.name}</div>
      <div class="size">{fmtBytes(e.size)}</div>
      <div class="meta"><RelativeTime ts={e.mtime} /></div>
      <div class="row-actions">
        <ActionsMenu
          mode={e.type === 'dir' ? 'directory' : 'entry'}
          entry={e}
          onNewFile={e.type === 'dir' ? () => onNewFile(e.path) : undefined}
          onUpload={e.type === 'dir' ? () => onUpload(e.path) : undefined}
          onEdit={e.type === 'file' && isEditableFileName(e.name) ? () => onEdit(e) : undefined}
          includeSelection={false}
          triggerTitle={`Actions for ${e.name}`}
        />
      </div>
    </div>
  );
}

function Listing({ onEdit, onNewFile, onUpload }: Omit<RowProps, 'e'>) {
  const p = treePath.value;
  const err = treeError.value;
  const entries = treeEntries.value;
  if (err) return <div class="listing" id="listing"><div class="empty">{err}</div></div>;
  return (
    <div class="listing" id="listing">
      {p ? <div class="row" onClick={() => navTree(parentPath(p))}><div class="name">..</div></div> : null}
      {entries.length === 0
        ? <div class="empty">Empty directory</div>
        : entries.map((e) => (
          <Row key={e.path} e={e} onEdit={onEdit} onNewFile={onNewFile} onUpload={onUpload} />
        ))}
    </div>
  );
}

function UploadStrip() {
  const items = uploadItems.value;
  if (items.length === 0) return null;
  const allDone = items.every((i) => i.status !== 'uploading');
  const okPaths = items.filter((i) => i.status === 'ok' && i.path).map((i) => i.path!);
  const wakeTitle = !threadId.value ? 'Open a thread first' : `Send a message to the agent listing ${okPaths.length} updated file(s)`;
  return (
    <div class="upload-strip" id="upload-strip">
      {items.map((item, i) => (
        <div class={'row ' + item.status} key={i}>
          <div class="name">{item.name}</div>
          {item.status === 'uploading'
            ? <div class="bar"><i style={`width:${Math.round(item.pct || 0)}%`}></i></div>
            : null}
          <div class="status">{item.statusText || item.status}</div>
          {item.status === 'conflict' ? (
            <div class="actions">
              <button onClick={() => resolveConflict(i, 'overwrite')} title="Replace existing file">Overwrite</button>
              <button onClick={() => resolveConflict(i, 'rename')} title="Save with a unique name">Rename</button>
              <button onClick={() => resolveConflict(i, 'skip')} title="Cancel this upload">Skip</button>
            </div>
          ) : null}
        </div>
      ))}
      {allDone ? (
        <div class="footer">
          <button
            onClick={() => notifyAgent(okPaths)}
            disabled={okPaths.length === 0 || !threadId.value}
            title={wakeTitle}
          >Notify agent</button>
          <button class="close" onClick={clearUploadStrip} title="Dismiss">{'\u2715'}</button>
        </div>
      ) : null}
    </div>
  );
}

function mimeFromKind(kind: PreviewKind): string | null {
  switch (kind) {
    case 'image': return 'image';
    case 'audio': return 'audio';
    case 'video': return 'video';
    case 'pdf': return 'application/pdf';
    case 'html': return 'text/html';
    case 'markdown': return 'text/markdown';
    case 'text': return 'text/plain';
    default: return null;
  }
}

function formatMtime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function renderMetaPanel(rows: [string, string][]): VNode {
  const summary = rows.map(([, v]) => v).join(' \u00B7 ');
  return (
    <details class="preview-meta">
      <summary class="preview-meta-summary">{summary}</summary>
      <dl class="preview-meta-rows">
        {rows.map(([k, v]) => (
          <div class="row" key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </details>
  );
}

function Preview({ editor }: { editor: PreviewEditorState }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const p = previewBlock.value ?? (editor.creating
    ? { kind: 'text' as const, text: '', name: editor.path?.slice(editor.path.lastIndexOf('/') + 1) || 'New file', path: editor.path || undefined }
    : null);
  const fp = filePath.value;
  useEffect(() => {
    if (!editor.editing) return;
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [editor.editing, editor.path]);
  if (!p) return <div class="preview-body" id="preview" ref={ref}></div>;

  const fileRows: [string, string][] = [];
  if (p.size != null) fileRows.push(['Size', fmtBytes(p.size)]);
  const mimeOrKind = p.mime || mimeFromKind(p.kind);
  if (mimeOrKind) fileRows.push(['Type', mimeOrKind]);
  if (p.mtime) fileRows.push(['Modified', formatMtime(p.mtime)]);
  const tagRows: [string, string][] = p.tags
    ? Object.entries(p.tags).map<[string, string]>(([k, v]) => [k, String(v)])
    : [];
  const metaRows: [string, string][] = [...fileRows, ...tagRows];
  const meta: ComponentChildren = metaRows.length > 0 ? renderMetaPanel(metaRows) : null;

  const isAudio = p.kind === 'audio';
  const isVideo = p.kind === 'video';
  const player = (isAudio || isVideo)
    ? <MediaPlayer kind={p.kind} url={p.url || ''} name={p.name || ''} floating={isAudio} />
    : null;
  const lyrics = p.lyrics ? <LyricsPanel text={p.lyrics} /> : null;
  let body: ComponentChildren = null;
  if (editor.editing) {
    body = (
      <textarea
        ref={editorRef}
        class="file-editor"
        value={editor.draft}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        disabled={editor.saving}
        onInput={(ev: JSX.TargetedEvent<HTMLTextAreaElement>) => editor.setDraft(ev.currentTarget.value)}
      />
    );
  } else if (p.kind === 'image') body = <img alt={p.name} src={p.url} />;
  else if (p.kind === 'pdf') body = <iframe src={p.url} style="width:100%;height:90vh;border:0" />;
  else if (p.kind === 'html' && fp && groupId.value) {
    body = <PrivateWebView key={`${p.url || ''}:${p.etag || ''}`} groupId={groupId.value} path={fp} title={p.name} />;
  }
  else if (p.kind === 'markdown') {
    const md = renderMarkdown(p.text);
    body = md != null
      ? <div class="markdown-preview" dangerouslySetInnerHTML={{ __html: md }} />
      : <pre>{p.text}</pre>;
  } else if (p.kind === 'text') {
    const hi = highlightCode(p.text || '', p.name);
    body = hi
      ? <pre class="hljs" data-lang={hi.language}><code dangerouslySetInnerHTML={{ __html: hi.html }} /></pre>
      : <pre>{p.text}</pre>;
  }
  else if (p.kind === 'binary') body = <div class="empty">Binary file ({p.mime}).</div>;
  else if (p.kind === 'error') body = <div class="empty">{p.text}</div>;
  return (
    <div class={'preview-body' + (isAudio ? ' has-floating-player' : '')} id="preview" ref={ref}>
      {meta}{isVideo ? player : null}{lyrics}{body}{isAudio ? player : null}
    </div>
  );
}

export function FilesPane() {
  const editor = usePreviewEditor();
  const previewing = !!previewBlock.value || editor.editing;
  const listingUploadRef = useRef<HTMLInputElement | null>(null);
  const listingUploadDirectory = useRef('');
  const editEntry = (entry: TreeEntry): void => {
    navFile(entry)
      .then(editor.beginEdit)
      .catch(console.error);
  };
  const beginCreateIn = (directory: string): void => {
    navTree(directory)
      .then(() => promptNewFilePath(directory))
      .then((path) => { if (path) editor.beginCreate(path); })
      .catch(console.error);
  };
  const chooseUploadTo = (directory: string): void => {
    listingUploadDirectory.current = directory;
    listingUploadRef.current?.click();
  };

  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    const zone = document.getElementById('dropzone');
    if (!body || !zone) return undefined;
    let depth = 0;
    const hasFiles = (ev: DragEvent): boolean => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    const highlight = (on: boolean): void => { zone.classList.toggle('drag-over', !!on); };
    const onEnter = (ev: DragEvent): void => { if (!isAdmin.value || !hasFiles(ev)) return; ev.preventDefault(); depth++; highlight(true); };
    const onOver = (ev: DragEvent): void => { if (!isAdmin.value || !hasFiles(ev)) return; ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; };
    const onLeave = (): void => { if (!isAdmin.value) return; depth--; if (depth <= 0) { depth = 0; highlight(false); } };
    const onDrop = (ev: DragEvent): void => {
      if (!isAdmin.value) return;
      ev.preventDefault();
      depth = 0;
      highlight(false);
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) uploadFiles(files);
    };
    body.addEventListener('dragenter', onEnter);
    body.addEventListener('dragover', onOver);
    body.addEventListener('dragleave', onLeave);
    body.addEventListener('drop', onDrop);
    return () => {
      body.removeEventListener('dragenter', onEnter);
      body.removeEventListener('dragover', onOver);
      body.removeEventListener('dragleave', onLeave);
      body.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <Pane paneKey="files" name="files-pane" label="Files" extraClass={previewing ? 'previewing' : ''}>
      <div class="files-body" ref={bodyRef}>
        <input
          type="file"
          multiple
          hidden
          ref={listingUploadRef}
          onChange={(ev: JSX.TargetedEvent<HTMLInputElement>) => {
            const files = ev.currentTarget.files;
            if (files && files.length) uploadFiles(files, listingUploadDirectory.current);
            ev.currentTarget.value = '';
          }}
        />
        <Crumb editor={editor} />
        <UploadStrip />
        <Listing onEdit={editEntry} onNewFile={beginCreateIn} onUpload={chooseUploadTo} />
        <div class="drop-hint admin-only" id="dropzone">
          Drag &amp; drop files here to upload to <code id="dropzone-path">/{treePath.value}</code>
        </div>
        <Preview editor={editor} />
      </div>
    </Pane>
  );
}
