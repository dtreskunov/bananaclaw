// Generic in-app text prompt and confirmation — replace window.prompt()
// and window.confirm() which aren't available in some browsing contexts.
import './Settings.css';
import type { JSX } from 'preact';
import { signal, type Signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MobileDialog, MobileDialogFooter } from './MobileDialog';

interface PromptRequest {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  okLabel?: string;
  resolve: (value: string | null) => void;
}

const promptRequest: Signal<PromptRequest | null> = signal<PromptRequest | null>(null);

export function requestInput(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    promptRequest.value = { ...opts, resolve };
  });
}

export function PromptModal() {
  const req = promptRequest.value;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.initialValue || '');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [req]);

  if (!req) return null;

  function close(result: string | null): void {
    const r = promptRequest.value;
    promptRequest.value = null;
    r?.resolve(result);
  }
  function onSubmit(e: JSX.TargetedEvent<HTMLFormElement>): void {
    e.preventDefault();
    const trimmed = value.trim();
    close(trimmed ? trimmed : null);
  }
  function onKey(e: JSX.TargetedKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') close(null);
  }

  return (
    <MobileDialog title={req.title} onClose={() => close(null)} maxWidth="420px">
      <form class="mobile-dialog-form" onSubmit={onSubmit}>
        <div class="settings-body">
          {req.label ? <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--muted)">{req.label}</label> : null}
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={req.placeholder || ''}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setValue(e.currentTarget.value)}
            onKeyDown={onKey}
            style="width:100%"
          />
        </div>
        <MobileDialogFooter>
          <button type="button" onClick={() => close(null)}>Cancel</button>
          <button type="submit" class="primary">{req.okLabel || 'OK'}</button>
        </MobileDialogFooter>
      </form>
    </MobileDialog>
  );
}

interface ConfirmRequest {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (value: boolean) => void;
}

const confirmRequest: Signal<ConfirmRequest | null> = signal<ConfirmRequest | null>(null);

export function requestConfirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmRequest.value = { ...opts, resolve };
  });
}

export function ConfirmModal() {
  const req = confirmRequest.value;
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!req) return;
    requestAnimationFrame(() => okRef.current?.focus());
  }, [req]);

  if (!req) return null;

  function close(result: boolean): void {
    const r = confirmRequest.value;
    confirmRequest.value = null;
    r?.resolve(result);
  }
  function onKey(e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') close(false);
    else if (e.key === 'Enter') close(true);
  }

  return (
    <MobileDialog
      title={req.title}
      onClose={() => close(false)}
      maxWidth="420px"
      role="alertdialog"
      onKeyDown={onKey}
    >
        <div class="settings-body" style="white-space:pre-wrap">{req.message}</div>
        <MobileDialogFooter>
          <button type="button" onClick={() => close(false)}>{req.cancelLabel || 'Cancel'}</button>
          <button
            ref={okRef}
            type="button"
            class={req.danger ? 'danger' : 'primary'}
            onClick={() => close(true)}
          >
            {req.okLabel || 'OK'}
          </button>
        </MobileDialogFooter>
    </MobileDialog>
  );
}
