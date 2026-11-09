import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, toChildArray, type ComponentChildren, type VNode } from 'preact';
import { TranscriptReader } from './TranscriptReader';
import { FilePreviewDialog } from './FilePreviewDialog';
import { groupId, threadId, threads } from '../state';
import { openTranscriptReader, readerSelection, type ReaderNavigate } from '../transcript-reader';
import type { ChatMessage, TranscriptRow } from '../types';
import { testAccountInteraction, testThread } from '../conversation-test-fixtures';
import { ThreadAttention } from './ThreadsRail';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
const hooks = vi.hoisted(() => ({
  slots: [] as { current: unknown }[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  deps: [] as unknown[][],
  effectIndex: 0,
}));
vi.mock('preact/hooks', () => ({
  useRef: (value: unknown) => (hooks.slots[hooks.cursor++] ??= { current: value }),
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.effectIndex++;
    if (!hooks.deps[index] || deps.some((dep, i) => dep !== hooks.deps[index][i])) {
      hooks.deps[index] = deps;
      hooks.effects.push(effect);
    }
  },
}));
const message: ChatMessage = { id: 'one', direction: 'out', text: 'First', timestamp: 1791219600000 };
let rows: TranscriptRow[];
const onNavigate = vi.fn();
const renderMessage = vi.fn((message: ChatMessage, _navigate: ReaderNavigate) => message.text);
const viewport = { scrollTop: 0 };
const disposers: (() => void)[] = [];

function render() {
  hooks.cursor = 0;
  hooks.effectIndex = 0;
  const node = TranscriptReader({ rows, onNavigate, renderMessage });
  hooks.slots[0].current = viewport;
  hooks.effects.splice(0).forEach((effect) => {
    const dispose = effect();
    if (dispose) disposers.push(dispose);
  });
  return node;
}
function findNode<P>(
  children: ComponentChildren,
  type: VNode<P>['type'],
  match: (props: P) => boolean = () => true,
): VNode<P> | undefined {
  for (const child of toChildArray(children)) {
    if (!isValidElement(child)) continue;
    const node = child as VNode<P>;
    if (node.type === type && match(node.props)) return node;
    const nested = findNode<P>(node.props.children, type, match);
    if (nested) return nested;
  }
}
function button(node: ReturnType<typeof TranscriptReader>, label: string) {
  return findNode<{ 'aria-label'?: string; onClick(): void; disabled: boolean }>(
    node.props.header,
    'button',
    (props) => props['aria-label'] === label,
  )!;
}
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
beforeEach(() => {
  hooks.slots = [];
  hooks.deps = [];
  hooks.effects = [];
  groupId.value = 'group';
  threadId.value = 'thread';
  threads.value = [testThread({ title: 'Thread title' })];
  readerSelection.value = null;
  viewport.scrollTop = 0;
  rows = [
    { kind: 'message', message },
    { kind: 'message', message: { ...message, id: 'two', text: 'Second' } },
  ];
  vi.clearAllMocks();
});

describe('full-frame transcript reader', () => {
  it('uses the shared native preview dialog and updates live header position without changing the selected page', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    let node = render();
    expect(node.type).toBe(FilePreviewDialog);
    expect(node.props.expanded).toBe(true);
    expect(node.props.title).toBe('Thread title');
    expect(button(node, 'Previous message').props.disabled).toBe(true);
    rows.push({ kind: 'message', message: { ...message, id: 'three' } });
    node = render();
    expect(node.props.header.props.children[2].props.children).toEqual([1, ' / ', 3]);
    expect(readerSelection.value?.key).toBe('message:one');
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('one');
  });

  it('pages with buttons, remembers reading positions, and aligns the final viewed message on close', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    let node = render();
    viewport.scrollTop = 125;
    button(node, 'Next message').props.onClick();
    node = render();
    expect(viewport.scrollTop).toBe(0);
    viewport.scrollTop = 60;
    button(node, 'Previous message').props.onClick();
    node = render();
    expect(viewport.scrollTop).toBe(125);
    button(node, 'Next message').props.onClick();
    node = render();
    expect(viewport.scrollTop).toBe(60);
    node.props.onClose();
    expect(onNavigate).toHaveBeenLastCalledWith('two');
    expect(readerSelection.value).toBeNull();
  });

  it('ignores modified arrow keys and routes normal arrows through the same paging logic', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    const node = render();
    const preventDefault = vi.fn();
    node.props.onKeyDown({ key: 'ArrowRight', ctrlKey: true, preventDefault });
    expect(readerSelection.value?.key).toBe('message:one');
    vi.stubGlobal('Element', class {});
    node.props.onKeyDown({ key: 'ArrowRight', preventDefault });
    expect(readerSelection.value?.key).toBe('message:two');
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('keeps approval and account-request rows out of the reader and its page count', () => {
    rows.splice(1, 0, { kind: 'interaction', interaction: testAccountInteraction() });
    openTranscriptReader({ kind: 'message', id: message.id });
    const node = render();
    expect(node.props.header.props.children[2].props.children).toEqual([1, ' / ', 2]);
    button(node, 'Next message').props.onClick();
    render();
    expect(readerSelection.value?.key).toBe('message:two');
    expect(renderMessage.mock.calls.map(([item]) => item.id)).toEqual(['one', 'two']);
  });
  it('retains waiting-indicator navigation through the existing attention workflow', () => {
    openTranscriptReader({ kind: 'message', id: message.id });
    const node = render();
    const indicator = findNode<Parameters<typeof ThreadAttention>[0]>(node.props.header, ThreadAttention)!;
    const navigate = vi.fn();
    indicator.props.onNavigate!(navigate);
    expect(readerSelection.value).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    node.props.onAfterClose();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('hands file/image navigation off only after the modal has closed', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    const node = render();
    const action = vi.fn();
    const navigate = renderMessage.mock.calls[0][1];
    navigate(action);
    expect(action).not.toHaveBeenCalled();
    expect(readerSelection.value).toBeNull();
    node.props.onAfterClose();
    expect(action).toHaveBeenCalledOnce();
  });
  it('keeps the current reader page and position when a follow-up arrives', () => {
    rows = [{ kind: 'message', message }];
    openTranscriptReader({ kind: 'message', id: message.id });
    render();
    viewport.scrollTop = 350;
    rows = [
      { kind: 'message', message },
      {
        kind: 'message',
        message: { ...message, id: 'answer', direction: 'in', text: 'Answer' },
      },
    ];
    const node = render();
    expect(viewport.scrollTop).toBe(350);
    expect(readerSelection.value?.key).toBe('message:one');
    expect(node.props.header.props.children[2].props.children).toEqual([1, ' / ', 2]);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(message.id);
    button(node, 'Next message').props.onClick();
    render();
    expect(readerSelection.value?.key).toBe('message:answer');
    expect(viewport.scrollTop).toBe(0);
    expect(onNavigate).toHaveBeenLastCalledWith('answer');
    expect(renderMessage.mock.lastCall?.[0].text).toContain('Answer');
  });
  it('closes the reader on a conversation change without aligning an unrelated transcript', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    render();
    onNavigate.mockClear();
    groupId.value = 'another-group';
    expect(render().props.expanded).toBe(false);
    expect(readerSelection.value).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it('cancels queued navigation if the conversation changes before the modal has closed', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    const node = render();
    const action = vi.fn();
    renderMessage.mock.calls[0][1](action);
    groupId.value = 'another-group';
    render();
    node.props.onAfterClose();
    expect(action).not.toHaveBeenCalled();
  });
  it('clears the reading selection and queued navigation on unmount', () => {
    openTranscriptReader({ kind: 'message', id: 'one' });
    const node = render();
    const action = vi.fn();
    renderMessage.mock.calls[0][1](action);
    disposers.splice(0).forEach((dispose) => dispose());
    node.props.onAfterClose();
    expect(readerSelection.value).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
});
