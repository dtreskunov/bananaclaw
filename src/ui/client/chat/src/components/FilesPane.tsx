// Files pane: head + breadcrumb + upload strip + listing + drop hint +
// preview body.
import './FilesPane.css';
import type { ComponentChildren, JSX, VNode } from 'preact';
import { useRef, useEffect, useState } from 'preact/hooks';
import {
  treePath, treeEntries, treeError, filePath, isAdmin,
  previewBlock, uploadItems, threadId, pinnedContext,
} from '../state';
import { navTree, navFile, closePreview, togglePinnedFile, loadTree, selectFile } from '../actions';
import {
  uploadFiles, clearUploadStrip, resolveConflict, notifyAgent, saveFile,
} from '../uploads';
import { fmtBytes, renderMarkdown, parentPath } from '../utils';
import { Pane } from './Pane';
import { RelativeTime } from './RelativeTime';
import { ActionsMenu } from './ActionsMenu';
import { MediaPlayer } from './MediaPlayer';
import { LyricsPanel } from './LyricsPanel';
import { requestConfirm } from './PromptModal';
import { highlightCode } from '../highlight';
import type { TreeEntry, PreviewKind } from '../types';

function Crumb() {
  const ref = useRef<HTMLDivElement | null>(null);
  const p = treePath.value;
  const fp = filePath.value;
  const segs = p ? p.split('/').filter(Boolean) : [];
  const fileName = fp ? fp.slice(fp.lastIndexOf('/') + 1) : '';
  useEffect(() => {
    if (ref.current) requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
    });
  }, [p, fp]);
  let acc = '';
  return (
    <div class="breadcrumb" id="crumb" ref={ref}>
      <button
        type="button"
        class={'crumb root' + (segs.length === 0 && !fileName ? ' current' : '')}
        data-path=""
        title="Root"
        onClick={() => { navTree(''); }}
      >/</button>
      {segs.map((s, i) => {
        acc = acc ? acc + '/' + s : s;
        const path = acc;
        const last = i === segs.length - 1 && !fileName;
        const onClick = last ? undefined : () => { navTree(path); };
        return (
          <>
            <span class="sep" aria-hidden="true">{'\u203a'}</span>
            <button
              type="button"
              class={'crumb' + (last ? ' current' : '')}
              data-path={path}
              title={'/' + path}
              onClick={onClick}
            >{s}</button>
          </>
        );
      })}
      {fileName ? (
        <>
          <span class="sep" aria-hidden="true">{'\u203a'}</span>
          <span class="crumb file current" title={'/' + fp}>{fileName}</span>
        </>
      ) : null}
    </div>
  );
}

function Row({ e }: { e: TreeEntry }) {
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
      <div class="row-actions"><ActionsMenu mode="row" entry={e} /></div>
    </div>
  );
}

function Listing() {
  const p = treePath.value;
  const err = treeError.value;
  const entries = treeEntries.value;
  if (err) return <div class="listing" id="listing"><div class="empty">{err}</div></div>;
  return (
    <div class="listing" id="listing">
      {p ? <div class="row" onClick={() => navTree(parentPath(p))}><div class="name">..</div></div> : null}
      {entries.length === 0
        ? <div class="empty">Empty directory</div>
        : entries.map((e) => <Row key={e.path} e={e} />)}
    </div>
  );
}

function UploadStrip() {
  const items = uploadItems.value;
  if (items.length === 0) return <div class="upload-strip" id="upload-strip" hidden></div>;
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

function Preview() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const p = previewBlock.value;
  const fp = filePath.value;
  // Leave edit mode whenever the previewed file changes.
  useEffect(() => {
    setEditing(false);
    setSaving(false);
  }, [fp]);
  if (!p) return <div class="preview-body" id="preview" ref={ref}></div>;
  const pinned = !!fp && pinnedContext.value.includes(fp);
  const clippyTitle = pinned ? 'Detach from next message' : 'Attach to next message';
  const editable = isAdmin.value && (p.kind === 'text' || p.kind === 'markdown');

  const beginEdit = (): void => {
    setDraft(p.text || '');
    setEditing(true);
  };
  const cancelEdit = (): void => {
    setEditing(false);
  };
  const commitEdit = async (): Promise<void> => {
    if (!fp) return;
    setSaving(true);
    // First attempt carries the etag of the version we loaded, so the write
    // only lands if the file hasn't changed underneath us.
    let res = await saveFile(fp, draft, previewBlock.peek()?.etag);
    if (res && 'conflict' in res) {
      // Someone else changed the file since we opened it. Let the user pick
      // between reloading their copy or clobbering it.
      const overwrite = await requestConfirm({
        title: 'File changed on disk',
        message: 'This file was modified since you opened it. Overwrite the newer version with your changes, or reload it?',
        okLabel: 'Overwrite',
        cancelLabel: 'Reload',
        danger: true,
      });
      if (!overwrite) {
        setSaving(false);
        setEditing(false);
        // Reload the current on-disk version (and its fresh etag).
        if (fp) await selectFile({ path: fp, name: fp.slice(fp.lastIndexOf('/') + 1) });
        return;
      }
      // Retry against the current version reported by the 412.
      res = await saveFile(fp, draft, res.etag);
    }
    setSaving(false);
    if (!res || 'conflict' in res) return;
    const cur = previewBlock.peek();
    if (cur && cur.path === fp) {
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

  const editActions = editing ? (
    <>
      <button
        type="button"
        class="text-btn save-btn"
        onClick={() => { commitEdit().catch(console.error); }}
        disabled={saving}
        title="Save"
      >{saving ? 'Saving\u2026' : 'Save'}</button>
      <button
        type="button"
        class="text-btn cancel-btn"
        onClick={cancelEdit}
        disabled={saving}
        title="Discard changes"
      >Cancel</button>
    </>
  ) : editable ? (
    <button
      type="button"
      class="text-btn edit-btn"
      onClick={beginEdit}
      title="Edit"
      aria-label="Edit"
    >{'\u270E'}</button>
  ) : null;

  const toolbar = (
    <div class="preview-toolbar">
      <button
        class={'text-btn clippy' + (pinned ? ' active' : '')}
        onClick={() => togglePinnedFile(fp)}
        disabled={!fp || editing}
        title={clippyTitle}
        aria-pressed={pinned}
      >{'\uD83D\uDCCE'}</button>
      <span class="preview-spacer"></span>
      <span class="preview-actions">
        {editActions}
        <button
          type="button"
          class="text-btn refresh-btn"
          onClick={() => {
            if (!p.name || !fp) return;
            selectFile({ path: fp, name: p.name }).catch(console.error);
          }}
          disabled={!fp || !p.name || editing}
          title="Refresh"
          aria-label="Refresh"
        >{'\u21BB'}</button>
        <ActionsMenu mode="preview" />
        <button
          type="button"
          class="text-btn close-preview"
          onClick={closePreview}
          title="Close preview"
          aria-label="Close preview"
        >{'\u00D7'}</button>
      </span>
    </div>
  );


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
  if (editing) {
    body = (
      <textarea
        class="file-editor"
        value={draft}
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        disabled={saving}
        onInput={(ev: JSX.TargetedEvent<HTMLTextAreaElement>) => setDraft(ev.currentTarget.value)}
      />
    );
  } else if (p.kind === 'image') body = <img alt={p.name} src={p.url} />;
  else if (p.kind === 'pdf') body = <iframe src={p.url} style="width:100%;height:90vh;border:0" />;
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
      {toolbar}{meta}{isVideo ? player : null}{lyrics}{body}{isAudio ? player : null}
    </div>
  );
}

export function FilesPane() {
  const previewing = !!previewBlock.value;

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

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const headActions = (
    <div class="head-actions">
      <input
        type="file"
        id="upload-input"
        multiple
        hidden
        ref={uploadInputRef}
        onChange={(ev: JSX.TargetedEvent<HTMLInputElement>) => {
          const f = ev.currentTarget.files;
          if (f && f.length) uploadFiles(f);
          ev.currentTarget.value = '';
        }}
      />
      <button
        type="button"
        class="icon-btn refresh-btn"
        title="Refresh"
        aria-label="Refresh"
        onClick={() => { loadTree(treePath.peek()).catch(console.error); }}
      >{'\u21BB'}</button>
      <ActionsMenu mode="header" onUpload={() => uploadInputRef.current?.click()} />
    </div>
  );
  return (
    <Pane paneKey="files" name="files-pane" label="Files" extraClass={previewing ? 'previewing' : ''} headActions={headActions}>
      <div class="files-body" ref={bodyRef}>
        <Crumb />
        <UploadStrip />
        <Listing />
        <div class="drop-hint admin-only" id="dropzone">
          Drag &amp; drop files here to upload to <code id="dropzone-path">/{treePath.value}</code>
        </div>
        <Preview />
      </div>
    </Pane>
  );
}
