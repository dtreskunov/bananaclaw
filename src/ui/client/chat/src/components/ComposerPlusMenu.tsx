// Composer "+" menu — popover anchored to the + button in the chat composer.
// Attachments and next-message thinking settings.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ThinkingLevelSlider, type ThinkingLevelSliderProps } from './ThinkingLevelSlider';

interface Props {
  disabled?: boolean;
  title?: string;
  showRecordAudio: boolean;
  showQuickCapture: boolean;
  onUploadFile: () => void;
  onQuickCapture: () => void;
  onRecordAudio: () => void;
  thinking?: ThinkingLevelSliderProps;
}

export function ComposerPlusMenu({
  disabled,
  title,
  showRecordAudio,
  showQuickCapture,
  onUploadFile,
  onQuickCapture,
  onRecordAudio,
  thinking,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const expanded = open && !disabled;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!expanded) return undefined;
    wrapRef.current?.querySelector<HTMLButtonElement>('.composer-plus-item')?.focus();
    const onDoc = (ev: PointerEvent): void => {
      if (ev.target instanceof Node && !wrapRef.current?.contains(ev.target)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const pick = (fn: () => void) => (ev: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    ev.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
    fn();
  };

  return (
    <div class={'composer-plus' + (expanded ? ' open' : '')} ref={wrapRef}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !wrapRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}>
      <button
        type="button"
        id="chat-attach"
        ref={triggerRef}
        class="composer-plus-trigger"
        title={title || 'Add\u2026'}
        aria-label="Add"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        disabled={disabled}
        onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
          ev.stopPropagation();
          setOpen((o) => !o);
        }}
      ><span class="plus-glyph" aria-hidden="true">{'\u002B'}</span></button>
      {expanded ? (
        <div class="composer-plus-panel flush-menu-panel" role="dialog" aria-label="Add to message">
          {showQuickCapture ? (
            <button type="button" class="composer-plus-item" onClick={pick(onQuickCapture)}>
              <span class="ico">{'\uD83D\uDCF7'}</span>
              <span class="lbl">Take photo</span>
            </button>
          ) : null}
          <button type="button" class="composer-plus-item" onClick={pick(onUploadFile)}>
            <span class="ico">{'\uD83D\uDCCE'}</span>
            <span class="lbl">Upload file</span>
          </button>
          {showRecordAudio ? (
            <button type="button" class="composer-plus-item" onClick={pick(onRecordAudio)}>
              <span class="ico">{'\uD83C\uDF99\uFE0F'}</span>
              <span class="lbl">Record audio attachment</span>
            </button>
          ) : null}
          {thinking ? <div class="composer-plus-thinking" title="Next message only">
            <ThinkingLevelSlider {...thinking} />
          </div> : null}
        </div>
      ) : null}
    </div>
  );
}
