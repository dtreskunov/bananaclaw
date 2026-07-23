// "Create new agent group" modal — owner / global admin only.
// Posts to POST /api/groups, then prepends the new group to the picker
// and selects it so the user lands in an immediately-usable state.
import './Settings.css';
import type { JSX } from 'preact';
import { signal, type Signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';

import { postJson } from '../api';
import { selectGroup } from '../actions';
import { groups } from '../state';
import type { Group } from '../types';
import { showToast } from './Toast';
import { MobileDialog, MobileDialogFooter } from './MobileDialog';

export const createGroupOpen: Signal<boolean> = signal(false);

interface NewGroupResponse {
  id: string;
  name: string;
  folder: string;
  createdAt: string;
}

function errMsg(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const obj = data as { message?: unknown; error?: unknown };
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.error === 'string' && obj.error) return obj.error;
  }
  return fallback;
}

export function CreateGroupModal() {
  const open = createGroupOpen.value;
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [instructions, setInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setFolder('');
    setInstructions('');
    setSubmitting(false);
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);

  if (!open) return null;

  function close(): void {
    createGroupOpen.value = false;
  }

  async function onSubmit(e: JSX.TargetedEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    const r = await postJson<NewGroupResponse>('api/groups', {
      name: trimmed,
      folder: folder.trim() || undefined,
      instructions: instructions || undefined,
    });
    if (!r.ok) {
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      setSubmitting(false);
      return;
    }
    // Prepend the new group so it shows up in the picker right away.
    const created: Group = {
      id: r.data.id,
      name: r.data.name,
      isAdmin: true,
      hasContent: true,
      lastActivityAt: r.data.createdAt,
    };
    groups.value = [created, ...groups.value.filter((g) => g.id !== created.id)];
    close();
    showToast(`Created "${created.name}"`);
    selectGroup(created.id).catch((err) => console.error('selectGroup after create', err));
  }

  function onKey(e: JSX.TargetedKeyboardEvent<HTMLElement>): void {
    if (e.key === 'Escape') close();
  }

  return (
    <MobileDialog title="New agent group" ariaLabel="Create agent group" onClose={close} maxWidth="480px">
      <form
        class="mobile-dialog-form"
        onSubmit={onSubmit}
        onKeyDown={onKey}
      >
        <div class="settings-body create-group-body">
          <label class="cg-field">
            <span class="cg-label">Name</span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              required
              placeholder="e.g. Research Helper"
              onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setName(e.currentTarget.value)}
            />
          </label>
          <label class="cg-field">
            <span class="cg-label">
              Folder <span class="cg-optional">(optional — derived from name)</span>
            </span>
            <input
              type="text"
              value={folder}
              placeholder="research-helper"
              onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setFolder(e.currentTarget.value)}
            />
          </label>
          <label class="cg-field">
            <span class="cg-label">
              Initial instructions <span class="cg-optional">(optional)</span>
            </span>
            <textarea
              value={instructions}
              rows={5}
              placeholder="What should this agent know or do?"
              onInput={(e: JSX.TargetedEvent<HTMLTextAreaElement>) => setInstructions(e.currentTarget.value)}
            />
          </label>
        </div>
        <MobileDialogFooter>
          <button type="button" onClick={close} disabled={submitting}>Cancel</button>
          <button type="submit" class="primary" disabled={submitting || !name.trim()}>
            {submitting ? 'Creating\u2026' : 'Create'}
          </button>
        </MobileDialogFooter>
      </form>
    </MobileDialog>
  );
}
