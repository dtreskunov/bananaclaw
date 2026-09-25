import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingMessageEditor } from './PendingMessageEditor';
import { activeTurn, turnConnected } from '../state';
import type { ChatMessage, Thread } from '../types';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return { slots: [] as unknown[], index: 0 };
});
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = value;
      },
    ];
  },
}));

const thread: Thread = { threadId: 'thread', title: 'Chat', lastActivityAt: '', channelType: 'web' };
let message: ChatMessage;
function render() {
  hooks.index = 0;
  return PendingMessageEditor({ message, thread, gid: 'group' });
}
// Walk the returned Preact tree without a DOM dependency.
function find(node: any, type: string, label?: string): any {
  if (!node) return undefined;
  if (node.type === type && (!label || node.props.children === label)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    if (child && typeof child === 'object') {
      const result = find(child, type, label);
      if (result) return result;
    }
  }
}
function open() {
  render()!.props.onClick();
}
function type(text: string) {
  find(render(), 'textarea').props.onInput({ currentTarget: { value: text } });
}
async function save() {
  find(render(), 'form').props.onSubmit({ preventDefault() {} });
  await vi.waitFor(() => expect(find(render(), 'button', 'Saving…')).toBeUndefined());
}

beforeEach(() => {
  hooks.slots = [];
  message = {
    id: 'message',
    text: 'Original',
    files: null,
    ts: '1',
    direction: 'in',
    canEditPending: true,
    inputState: { messageId: 'message', status: 'queued' },
  };
  activeTurn.value = { id: 'turn', status: 'running', supportsInputEditing: true };
  turnConnected.value = true;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'text_changed' }) }),
  );
});

describe('inline pending editor', () => {
  it('shows Saving until durable confirmation and then closes the editor', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    open();
    type('Draft');
    find(render(), 'form').props.onSubmit({ preventDefault() {} });
    expect(find(render(), 'button', 'Saving…').props.disabled).toBe(true);
    expect(find(render(), 'button', 'Saving…').props['aria-busy']).toBe(true);
    expect(message.text).toBe('Original');
    finish({ ok: true, status: 200, json: async () => ({ ok: true, id: 'message', text: 'Draft' }) } as Response);
    await vi.waitFor(() => expect(render()!.props['aria-label']).toBe('Edit pending message'));
  });
  it('cancels without submitting or changing the message', () => {
    open();
    type('Draft');
    find(render(), 'button', 'Cancel').props.onClick();
    expect(render()!.props['aria-label']).toBe('Edit pending message');
    expect(message.text).toBe('Original');
    expect(fetch).not.toHaveBeenCalled();
    open();
    expect(find(render(), 'textarea').props.value).toBe('Original');
  });
  it('retains the mounted draft and explicit error after a conflict and status transition', async () => {
    open();
    type('Draft');
    await save();
    message = { ...message, canEditPending: false, inputState: { messageId: 'message', status: 'applied' } };
    activeTurn.value = null;
    expect(find(render(), 'textarea').props.value).toBe('Draft');
    expect(find(render(), 'p').props.role).toBe('alert');
    expect(find(render(), 'p').props.children).toContain('changed elsewhere');
    expect(find(render(), 'button', 'Cancel')).toBeTruthy();
  });
  it('retains a locked pending request across Cancel and reopen, then retries its identity', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'edit_pending' }),
    } as Response);
    open();
    type('Draft');
    await save();
    expect(find(render(), 'textarea').props.disabled).toBe(true);
    find(render(), 'button', 'Cancel').props.onClick();
    activeTurn.value = null;
    turnConnected.value = false;
    message = { ...message, canEditPending: false, inputState: { messageId: 'message', status: 'processing' } };
    open();
    expect(find(render(), 'textarea').props.value).toBe('Draft');
    expect(find(render(), 'textarea').props.disabled).toBe(true);
    await save();
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(vi.mocked(fetch).mock.calls[0][1]?.body);
  });
  it('keeps the editor visible when a queued input becomes processing before Save', () => {
    open();
    type('Draft');
    message = { ...message, canEditPending: false, inputState: { messageId: 'message', status: 'processing' } };
    expect(find(render(), 'textarea').props.value).toBe('Draft');
    expect(find(render(), 'button', 'Save').props.disabled).toBe(true);
    expect(find(render(), 'p').props.children).toContain('no longer editable');
  });
});
