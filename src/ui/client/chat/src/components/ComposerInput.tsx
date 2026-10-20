import type { ComponentChildren, ComponentProps, JSX } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { appearance } from '../appearance-state';
import { isMobile } from '../state';
import type { VoiceSelection } from '../voice';
import { VoiceButton } from './VoiceButton';

type TextareaRef = { current: HTMLTextAreaElement | null };

export function setVoiceTextareaText(input: HTMLTextAreaElement | null, text: string, selection?: VoiceSelection): void {
  if (!input) return;
  input.value = text;
  if (selection) input.setSelectionRange(selection.start, selection.end);
}

export function useComposerTextarea(inputRef: TextareaRef, value?: string, maxHeight: number | null = 200) {
  const [multiLine, setMultiLine] = useState(false);
  const density = appearance.value.preferences.density;
  const autosize = (): void => {
    const input = inputRef.current;
    if (!input) return;
    // Empty placeholders can wrap without a draft; keep the single-line height.
    if (!input.value) {
      input.style.height = '';
      input.style.overflowY = 'hidden';
      setMultiLine(false);
      return;
    }
    input.style.height = 'auto';
    const height = maxHeight === null ? input.scrollHeight : Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${height}px`;
    input.style.overflowY = maxHeight !== null && height >= maxHeight ? 'auto' : 'hidden';
    setMultiLine(height > 44);
  };
  useLayoutEffect(autosize, [density, value, maxHeight]);
  useEffect(() => {
    autosize();
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(autosize);
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef, maxHeight]);
  return { autosize, multiLine };
}

interface ComposerInputProps {
  inputRef: TextareaRef;
  textarea: Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, 'ref' | 'rows' | 'onKeyDown'>;
  voice: ComponentProps<typeof VoiceButton>;
  send: {
    id?: string;
    className?: string;
    label: string;
    title: string;
    disabled: boolean;
    busy?: boolean;
    icon?: ComponentChildren;
  };
  multiLine: boolean;
  listening: boolean;
  className?: string;
  hidden?: boolean;
  controls?: ComponentChildren;
}

function onComposerKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key === 'Enter' && !event.shiftKey && !isMobile.value && !event.isComposing) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

export function ComposerInput({
  inputRef, textarea, voice, send, multiLine, listening, className = '', hidden = false, controls,
}: ComposerInputProps) {
  return (
    <div
      class={`composer-input-wrap${className ? ` ${className}` : ''}${multiLine ? ' multi-line' : ''}${listening ? ' voice-listening' : ''}`}
      style={hidden ? 'display:none' : ''}
    >
      <textarea {...textarea} ref={inputRef} rows={1} onKeyDown={onComposerKeyDown} />
      {controls}
      <VoiceButton {...voice} />
      <button
        type="submit"
        id={send.id}
        class={`accent-icon-btn${send.className ? ` ${send.className}` : ''}`}
        aria-label={send.label}
        aria-busy={send.busy}
        title={send.title}
        disabled={send.disabled}
        onMouseDown={(event) => event.preventDefault()}
      >
        {send.icon ?? '\u2191'}
      </button>
    </div>
  );
}
