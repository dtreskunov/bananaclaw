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
  basePath?: string;
  placeholder?: string;
  initialValue?: string;
  okLabel?: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
}

const promptRequest: Signal<PromptRequest | null> = signal<PromptRequest | null>(null);

function BasePathBreadcrumb({ path }: { path: string }) {
  return (
    <nav class="prompt-path-breadcrumb path-breadcrumb" aria-label="Base path">
      <div class="path-breadcrumb-track">
        <span class="path-breadcrumb-segment root">~</span>
        {path.split('/').filter(Boolean).map((segment, index) => (
          <span class="path-breadcrumb-node" key={`${segment}-${index}`}>
            <span class="path-breadcrumb-separator" aria-hidden="true">{'\u203A'}</span>
            <span class="path-breadcrumb-segment">{segment}</span>
          </span>
        ))}
      </div>
    </nav>
  );
}

export function requestInput(opts: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    promptRequest.value = { ...opts, resolve };
  });
}

export function PromptModal() {
  const req = promptRequest.value;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.initialValue || '');
    setError(null);
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
    const validationError = trimmed ? promptRequest.peek()?.validate?.(trimmed) : null;
    if (validationError) {
      setError(validationError);
      return;
    }
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
          {req.basePath !== undefined ? <BasePathBreadcrumb path={req.basePath} /> : null}
          <input
            ref={inputRef}
            type="text"
            class="rail-search-input prompt-input"
            value={value}
            placeholder={req.placeholder || ''}
            aria-invalid={!!error}
            aria-describedby={error ? 'prompt-input-error' : undefined}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => {
              setValue(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={onKey}
          />
          {error ? <div id="prompt-input-error" style="margin-top:6px;color:var(--danger);font-size:12px">{error}</div> : null}
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

interface ChoiceOption {
  value: string;
  label: string;
  tone?: 'primary' | 'danger';
}

interface ChoiceRequest {
  title: string;
  message: string;
  options: ChoiceOption[];
  resolve: (value: string | null) => void;
}

const choiceRequest: Signal<ChoiceRequest | null> = signal<ChoiceRequest | null>(null);

export function requestChoice(opts: Omit<ChoiceRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    choiceRequest.value = { ...opts, resolve };
  });
}

export function ChoiceModal() {
  const req = choiceRequest.value;
  const preferredRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!req) return;
    requestAnimationFrame(() => preferredRef.current?.focus());
  }, [req]);

  if (!req) return null;

  function close(value: string | null): void {
    const current = choiceRequest.value;
    choiceRequest.value = null;
    current?.resolve(value);
  }

  return (
    <MobileDialog
      title={req.title}
      onClose={() => close(null)}
      maxWidth="480px"
      role="alertdialog"
      onKeyDown={(event) => { if (event.key === 'Escape') close(null); }}
    >
      <div class="settings-body" style="white-space:pre-wrap">{req.message}</div>
      <MobileDialogFooter className="choice-dialog-footer">
        {req.options.map((option) => (
          <button
            key={option.value}
            ref={option.tone === 'primary' ? preferredRef : undefined}
            type="button"
            class={option.tone}
            onClick={() => close(option.value)}
          >
            {option.label}
          </button>
        ))}
      </MobileDialogFooter>
    </MobileDialog>
  );
}
