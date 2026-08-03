// Composer "+" menu — popover anchored to the + button in the chat composer.
// Items: Quick capture (when getUserMedia exists) · Upload file ·
// (conditionally) Record audio attachment.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  disabled?: boolean;
  title?: string;
  showRecordAudio: boolean;
  showQuickCapture: boolean;
  onUploadFile: () => void;
  onQuickCapture: () => void;
  onRecordAudio: () => void;
}

export function ComposerPlusMenu({
  disabled,
  title,
  showRecordAudio,
  showQuickCapture,
  onUploadFile,
  onQuickCapture,
  onRecordAudio,
}: Props): JSX.Element {
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

  const pick = (fn: () => void) => (ev: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    ev.stopPropagation();
    setOpen(false);
    fn();
  };

  return (
    <div class={'composer-plus' + (open ? ' open' : '')} ref={wrapRef}>
      <button
        type="button"
        id="chat-attach"
        class="composer-plus-trigger"
        title={title || 'Add\u2026'}
        aria-label="Add"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
          ev.stopPropagation();
          setOpen((o) => !o);
        }}
      ><span class="plus-glyph" aria-hidden="true">{'\u002B'}</span></button>
      {open ? (
        <div class="composer-plus-panel flush-menu-panel" role="menu">
          {showQuickCapture ? (
            <button type="button" class="composer-plus-item" role="menuitem" onClick={pick(onQuickCapture)}>
              <span class="ico">{'\uD83D\uDCF7'}</span>
              <span class="lbl">Take photo</span>
            </button>
          ) : null}
          <button type="button" class="composer-plus-item" role="menuitem" onClick={pick(onUploadFile)}>
            <span class="ico">{'\uD83D\uDCCE'}</span>
            <span class="lbl">Upload file</span>
          </button>
          {showRecordAudio ? (
            <button type="button" class="composer-plus-item" role="menuitem" onClick={pick(onRecordAudio)}>
              <span class="ico">{'\uD83C\uDF99\uFE0F'}</span>
              <span class="lbl">Record audio attachment</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
