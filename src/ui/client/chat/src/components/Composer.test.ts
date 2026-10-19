import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { isValidElement } from 'preact';
import { ActivityTraceList, Composer, ChatMain, InputDock } from './ChatMain';
import { QuestionPrompt } from './QuestionPrompt';
import { formatStopwatch } from '../duration-format';
import { ComposerInput } from './ComposerInput';
import { ActiveTurnStopButton } from './ActiveTurnStopButton';
import { TurnStopButton } from './TurnStopButton';
import { ToolStopButton } from './ToolStopButton';
import { QuestionAnswerBubble } from './QuestionAnswerBubble';
import { PendingMessageActions } from './PendingMessageActions';
import {
  activeTurn,
  stopRequest,
  turnConnected,
  groupId,
  threadId,
  threads,
  channelType,
  messagingGroupId,
  chatMessages,
  pending,
  pendingWebSends,
  canSend,
  chatReady,
  chatReloadRequired,
  isMobile,
  pendingQuestions,
  pinnedContext,
  voiceInput,
  scrollToBottomTick,
} from '../state';
import { composerSendInFlight, currentPendingEditor, pendingEditorSessions, openPendingEditor } from '../pending-edit';
import { pendingComposerBackups } from '../pending-composer';
import { cancelledInputs, confirmCancelledInput, PendingCancellation, pendingCancellations } from '../pending-cancel';
import {
  clearPinnedContext,
  removePending,
  respondQuestion,
  retryChatSend,
  sendChat,
  skipQuestion,
  warmChat,
} from '../actions';
import type { ActivityLine, ChatMessage, PendingQuestionDto, Thread } from '../types';
import type { ConversationMessage, ConversationTurn } from '../../../../shared/conversation';
import { applyConversationFrame, completedResponse, conversationState, resetConversation } from '../conversation-state';
import { testSnapshot, testTurn, testWebSubmission } from '../conversation-test-fixtures';
import { appearance } from '../appearance-state';
import { DEFAULT_APPEARANCE } from '../appearance';
import { isSystemNotice } from '../chat-protocol';
import { voice } from '../voice-audio';
import * as recorder from '../recorder';
import * as turnRow from '../turn-row';
import {
  activityMetricsExpanded,
  activityTraceExpanded,
  resetActivityTraceView,
  toggleActivityTrace,
} from '../activity-trace-state';
import { stepBody } from '../../../../shared/activity-presentation';

const closeTrace = (ownerId: string) => {
  if (activityTraceExpanded(ownerId)) toggleActivityTrace(ownerId);
};

// Exercise the real Composer's refs, layout transitions, handlers and rendered
// controls without adding a browser-DOM dependency to the repository.
const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as any[],
    cursor: 0,
    effects: [] as (() => void | (() => void))[],
    capturePassive: false,
    passiveEffects: [] as (() => void | (() => void))[],
  };
});
vi.mock('preact/hooks', () => ({
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= { current: initial });
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    hooks.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [
      hooks.slots[index].value,
      (value: unknown) => {
        hooks.slots[index].value = typeof value === 'function' ? value(hooks.slots[index].value) : value;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (hooks.capturePassive) hooks.passiveEffects.push(effect);
  },
  useLayoutEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = hooks.cursor++;
    if (!deps || !hooks.slots[index] || deps.some((value, i) => value !== hooks.slots[index][i])) {
      hooks.slots[index] = deps;
      hooks.effects.push(effect);
    }
  },
}));
vi.mock('../actions', () => ({
  sendChat: vi.fn(),
  retryChatSend: vi.fn(),
  warmChat: vi.fn().mockResolvedValue(undefined),
  clearPinnedContext: vi.fn(),
  addPendingFiles: vi.fn(),
  removePending: vi.fn(),
  respondQuestion: vi.fn(),
  skipQuestion: vi.fn(),
}));

const thread: Thread = { threadId: 'thread', title: 'Chat', lastActivityAt: '', channelType: 'web' };
let message: ChatMessage;
let input: any;
let tree: any;
function find(node: any, type: string, label?: string): any {
  if (!node) return undefined;
  if (node.type === ComposerInput) return find(ComposerInput(node.props), type, label);
  if (node.type === type && (!label || node.props['aria-label'] === label || node.props.children === label))
    return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    if (child && typeof child === 'object') {
      const result = find(child, type, label);
      if (result) return result;
    }
  }
}
function findComponent(node: any, name: string): any {
  if (!node) return undefined;
  if (typeof node.type === 'function' && node.type.name === name) return node;
  if (node.type === ComposerInput) return findComponent(ComposerInput(node.props), name);
  for (const child of [node.props?.children].flat(Infinity)) {
    if (child && typeof child === 'object') {
      const result = findComponent(child, name);
      if (result) return result;
    }
  }
}
/** The step list inside a rendered `ActivityTraceList` table. */
function traceList(table: any): any {
  return [table.props.children].flat().find((child: any) => child?.type === 'ul');
}
/** The value of a rendered `UsageRow`, expanding nested usage components. */
function usageRow(node: any, label: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (typeof node.type === 'function') {
    if (node.type.name === 'UsageRow') return node.props.label === label ? node.props.value : undefined;
    if (node.type.name.startsWith('Usage')) return usageRow(node.type(node.props), label);
  }
  for (const child of [node.props?.children].flat(Infinity)) {
    const value = usageRow(child, label);
    if (value !== undefined) return value;
  }
}
function renderTechnicalDetails(node: unknown) {
  const details = findComponent(node, 'TurnTechnicalDetails');
  return details?.type(details.props);
}
function renderUsageDetails(node: unknown) {
  const panel = findComponent(renderTechnicalDetails(node), 'ActivityTracePanel');
  const details = findComponent(panel.type(panel.props), 'UsageDetails');
  return details.type(details.props);
}
function renderResponseStatusRow() {
  resetMount();
  const log = findComponent(ChatMain(), 'MessageLog');
  resetMount();
  const status = findComponent(log.type(log.props), 'ResponseStatusRow');
  resetMount();
  return status.type(status.props);
}
function render() {
  hooks.cursor = 0;
  tree = Composer();
  find(tree, 'textarea').ref.current = input;
  const effects = hooks.effects.splice(0);
  effects.forEach((effect) => effect());
  return tree;
}
function type(text: string) {
  input.value = text;
  find(tree, 'textarea').props.onInput({ currentTarget: input });
  render();
}
function open() {
  openPendingEditor('group', thread, message);
  render();
}
function exit() {
  find(tree, 'button', 'Exit edit').props.onClick();
  render();
}
async function save() {
  find(tree, 'form').props.onSubmit({ preventDefault() {} });
  await vi.waitFor(() => {
    expect(currentPendingEditor()?.[1].draft.state.value.busy ?? false).toBe(false);
  });
  render();
}
function resetMount(text = '') {
  hooks.slots = [];
  hooks.effects = [];
  hooks.capturePassive = false;
  hooks.passiveEffects = [];
  input = { value: text, style: {}, scrollHeight: 32, focus: vi.fn() };
}

beforeEach(() => {
  resetConversation();
  appearance.value = { preferences: { ...DEFAULT_APPEARANCE }, resolvedMode: 'light', error: null };
  resetMount('Unsent composer draft');
  pendingEditorSessions.value = new Map();
  composerSendInFlight.value = false;
  pendingCancellations.value = new Map();
  pendingComposerBackups.clear();
  cancelledInputs.clear();
  message = {
    id: 'message',
    text: 'Original',
    files: [{ filename: 'instructions.txt' }],
    ts: '1',
    direction: 'in',
    canEditPending: true,
    inputState: { messageId: 'message', status: 'queued', queuedForNextTurn: true },
  };
  groupId.value = 'group';
  threadId.value = thread.threadId;
  channelType.value = 'web';
  messagingGroupId.value = null;
  chatMessages.value = [message];
  canSend.value = true;
  chatReady.value = true;
  isMobile.value = false;
  pendingQuestions.value = [];
  pendingWebSends.value = [];
  pinnedContext.value = ['keep/context.txt'];
  pending.value = [{ name: 'unsent.txt', size: 1 }];
  activeTurn.value = { id: 'turn', status: 'running', supportsInputEditing: true, supportsInputCancellation: true };
  turnConnected.value = true;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, id: 'message', text: 'Revision' }) }),
  );
  vi.mocked(sendChat).mockReset();
  vi.mocked(warmChat).mockClear();
  vi.mocked(clearPinnedContext).mockImplementation(() => {
    pinnedContext.value = [];
  });
  vi.mocked(removePending).mockImplementation((index) => {
    pending.value = pending.value.filter((_, i) => i !== index);
  });
  render();
});

describe('main composer pending edits', () => {
  it('warms on non-empty composition, but not mount, focus, whitespace, or pending edits', () => {
    const compose = (text: string) => {
      input.value = text;
      findComponent(tree, 'ComposerInput').props.textarea.onInput({ currentTarget: input });
      render();
    };
    expect(warmChat).not.toHaveBeenCalled();
    const textarea = find(tree, 'textarea');
    textarea.props.onFocus?.();
    expect(warmChat).not.toHaveBeenCalled();
    compose('   ');
    expect(warmChat).not.toHaveBeenCalled();
    compose('Draft');
    expect(warmChat).toHaveBeenCalledOnce();
    vi.mocked(warmChat).mockClear();
    open();
    compose('Edited pending message');
    expect(warmChat).not.toHaveBeenCalled();
  });

  it('warms when starting live dictation', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('AudioContext', vi.fn());
    vi.stubGlobal('AudioWorkletNode', vi.fn());
    const config = voiceInput.value;
    voiceInput.value = { ...config, ready: true };
    const start = vi.spyOn(voice, 'start').mockImplementation(() => {});
    onTestFinished(() => {
      start.mockRestore();
      voiceInput.value = config;
      vi.unstubAllGlobals();
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    });
    render();
    findComponent(tree, 'VoiceButton').props.onStart();
    expect(start).toHaveBeenCalledOnce();
    expect(warmChat).toHaveBeenCalledOnce();
  });

  it('warms when audio attachment recording starts', async () => {
    const start = vi.spyOn(recorder, 'startRecording').mockResolvedValue(true);
    onTestFinished(() => start.mockRestore());
    findComponent(tree, 'ComposerPlusMenu').props.onRecordAudio();
    await vi.waitFor(() => expect(warmChat).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledOnce();
  });

  it('explains explicit Retry versus a new Send and retries the failed bubble identity', () => {
    applyConversationFrame(testSnapshot(), 'thread');
    pendingWebSends.value = [{ ...testWebSubmission, status: 'failed', error: 'Network error' }];
    vi.mocked(retryChatSend).mockReset().mockResolvedValue(true);
    hooks.slots = [];
    hooks.cursor = 0;
    const log = findComponent(ChatMain(), 'MessageLog');
    hooks.slots = [];
    hooks.cursor = 0;
    const messageNode = findComponent(log.type(log.props), 'Message');
    hooks.slots = [];
    hooks.cursor = 0;
    const row = messageNode.type(messageNode.props);
    const alert = [row.props.children]
      .flat(Infinity)
      .find((child: unknown) => isValidElement(child) && 'role' in child.props && child.props.role === 'alert');
    expect(alert).toBeDefined();
    expect(find(alert, 'span').props.children).toContain('Network error');
    expect(find(alert, 'span').props.children).toContain('Use Retry to resend this message; Send creates a new one.');
    const retry = find(alert, 'button', 'Retry');
    expect(retry.props.disabled).toBe(false);
    retry.props.onClick();
    expect(retryChatSend).toHaveBeenCalledWith(testWebSubmission.messageId);
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('processes submitted Markdown before the first paint', () => {
    applyConversationFrame(testSnapshot(), 'thread');
    pendingWebSends.value = [testWebSubmission];
    hooks.slots = [];
    hooks.cursor = 0;
    const log = findComponent(ChatMain(), 'MessageLog');
    hooks.slots = [];
    hooks.cursor = 0;
    const message = findComponent(log.type(log.props), 'Message');
    hooks.slots = [];
    hooks.cursor = 0;
    hooks.effects = [];
    hooks.passiveEffects = [];
    hooks.capturePassive = true;
    onTestFinished(() => {
      hooks.capturePassive = false;
    });
    const row = message.type(message.props);
    const text = findComponent(row, 'MessageText');
    const content = text.type(text.props);
    const order: string[] = [];
    content.ref.current = {
      set innerHTML(html: string) {
        expect(html).toBe(content.props.dangerouslySetInnerHTML.__html);
        order.push('markdown');
      },
      querySelectorAll: () => [],
    };
    hooks.effects.splice(0).forEach((effect) => effect());
    order.push('paint');
    hooks.passiveEffects.splice(0).forEach((effect) => effect());
    expect(order).toEqual(['markdown', 'paint']);
  });

  it('preserves response controls across startup, durable turn creation, and live registration', () => {
    const previousWindow = window;
    const timeout = vi.fn(() => 1);
    vi.stubGlobal('window', { ...window, setTimeout: timeout, clearTimeout: vi.fn() });
    onTestFinished(() => {
      vi.stubGlobal('window', previousWindow);
    });
    applyConversationFrame(testSnapshot(), 'thread');
    pendingWebSends.value = [testWebSubmission];
    const response = () => {
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      return findComponent(log.type(log.props), 'ResponseStatusRow');
    };
    const starting = response();
    hooks.slots = [];
    hooks.cursor = 0;
    hooks.capturePassive = true;
    const row = starting.type(starting.props);
    hooks.passiveEffects.splice(0).forEach((effect) => effect());
    hooks.capturePassive = false;
    // Total runs from submission, before any turn exists.
    expect(timeout).toHaveBeenCalledOnce();
    expect(row.props['data-response-start']).toBe(`submission:${testWebSubmission.messageId}`);
    const elapsed = findComponent(row, 'TurnElapsed');
    expect(elapsed.props.live).toBe(true);
    expect(elapsed.props.ms).toBeGreaterThanOrEqual(0);
    expect(elapsed.type(elapsed.props).props.role).toBe('timer');
    const stop = findComponent(row, 'ActiveTurnStopButton');
    const control = stop.type(stop.props);
    const button = control.type(control.props);
    expect(control.props.turn).toBeNull();
    expect(button.props.disabled).toBe(true);
    expect(button.props.onClick).toBeUndefined();
    applyConversationFrame(
      testSnapshot(
        {
          messages: [
            { id: testWebSubmission.messageId, direction: 'in', text: 'Hello', timestamp: testWebSubmission.timestamp },
          ],
          turns: [{ ...testTurn, inputIds: [testWebSubmission.messageId] }],
          connection: { connected: true, activeTurnId: null },
        },
        'durable-stream',
      ),
      'thread',
    );
    const waiting = response();
    expect(waiting.type).toBe(starting.type);
    expect(waiting.key).toBe(starting.key);
    expect(waiting.props.source.kind).toBe('turn');
    hooks.slots = [];
    hooks.cursor = 0;
    const waitingRow = waiting.type(waiting.props);
    const waitingStop = findComponent(waitingRow, 'ActiveTurnStopButton');
    expect(waitingStop).toBeDefined();
    const waitingControl = waitingStop.type(waitingStop.props);
    expect(waitingControl.props.turn).toBeNull();
    expect(waitingControl.type(waitingControl.props).props.disabled).toBe(true);
    applyConversationFrame(
      testSnapshot(
        {
          messages: [
            { id: testWebSubmission.messageId, direction: 'in', text: 'Hello', timestamp: testWebSubmission.timestamp },
          ],
          turns: [{ ...testTurn, inputIds: [testWebSubmission.messageId] }],
          connection: { connected: true, activeTurnId: testTurn.id },
        },
        'started-stream',
      ),
      'thread',
    );
    const running = response();
    expect(running.type).toBe(starting.type);
    expect(running.key).toBe(starting.key);
    expect(running.props.source.kind).toBe('turn');
    hooks.slots = [];
    hooks.cursor = 0;
    hooks.capturePassive = true;
    const runningRow = running.type(running.props);
    hooks.passiveEffects.splice(0).forEach((effect) => effect());
    hooks.capturePassive = false;
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(findComponent(runningRow, 'TurnElapsed').props.live).toBe(true);
    const liveStop = findComponent(runningRow, 'ActiveTurnStopButton');
    const liveControl = liveStop.type(liveStop.props);
    expect(liveControl.props.turn.id).toBe(testTurn.id);
    expect(liveControl.type(liveControl.props).props.disabled).toBe(false);
  });

  it.each([null, 'another-turn'])('does not bind Stop for owner %s to an unrelated live turn', (turnId) => {
    applyConversationFrame(
      testSnapshot({
        turns: [testTurn],
        connection: { connected: true, activeTurnId: testTurn.id },
      }),
      'thread',
    );
    const control = ActiveTurnStopButton({ turnId });
    expect(control).not.toBeNull();
    expect(control!.props.turn).toBeNull();
    const button = TurnStopButton(control!.props);
    expect(button.props.disabled).toBe(true);
    expect(button.props.onClick).toBeUndefined();
  });

  it('keeps the response slot below its message before and after the active turn input association arrives', () => {
    const history: ConversationMessage = {
      id: 'previous-reply',
      direction: 'out',
      text: 'Earlier reply',
      timestamp: '2026-09-28T00:00:00Z',
    };
    applyConversationFrame(testSnapshot({ messages: [history] }), 'thread');
    pendingWebSends.value = [testWebSubmission];
    const rows = () => {
      hooks.slots = [];
      hooks.cursor = 0;
      const component = findComponent(ChatMain(), 'MessageLog');
      const log = component.type(component.props);
      const content = find(log, 'div');
      return [content.props.children]
        .flat(Infinity)
        .filter(
          (node) =>
            isValidElement(node) &&
            typeof node.type === 'function' &&
            ['Message', 'ResponseStatusRow'].includes(node.type.name),
        );
    };
    const starting = rows().at(-1)!;
    expect(starting.type.name).toBe('ResponseStatusRow');
    expect(starting.props.source.kind).toBe('starting');
    for (const associated of [false, true]) {
      applyConversationFrame(
        testSnapshot(
          {
            messages: [
              history,
              {
                id: testWebSubmission.messageId,
                direction: 'in',
                text: testWebSubmission.text,
                timestamp: testWebSubmission.timestamp,
                inputState: { messageId: testWebSubmission.messageId, status: 'processing' },
              },
            ],
            turns: [{ ...testTurn, inputIds: associated ? [testWebSubmission.messageId] : [] }],
            connection: { connected: true, activeTurnId: testTurn.id },
          },
          `association-${associated}`,
        ),
        'thread',
      );
      const list = rows();
      const status = list.at(-1)!;
      expect(list.at(-2)?.props.m.id).toBe(testWebSubmission.messageId);
      expect(status.type).toBe(starting.type);
      expect(status.key).toBe(starting.key);
      expect(status.props.source.turn.id).toBe(testTurn.id);
    }
  });

  it('reserves the stable response key for only one current or preparing bubble', () => {
    function responseKeys() {
      hooks.cursor = 0;
      const component = findComponent(ChatMain(), 'MessageLog');
      const log = component.type(component.props);
      const keys: string[] = [];
      const visit = (node: unknown) => {
        if (!isValidElement(node)) return;
        if (typeof node.type === 'function' && node.type.name === 'ResponseStatusRow' && typeof node.key === 'string')
          keys.push(node.key);
        for (const child of [node.props?.children].flat(Infinity)) visit(child);
      };
      visit(log);
      return keys;
    }
    const stale = { ...testTurn, id: 'stale' };
    applyConversationFrame(
      testSnapshot({ turns: [stale, testTurn], connection: { connected: true, activeTurnId: testTurn.id } }),
      'thread',
    );
    let keys = responseKeys();
    expect(new Set(keys).size).toBe(2);
    expect(keys.filter((key) => key.endsWith('response:active'))).toHaveLength(1);
    resetConversation();
    applyConversationFrame(testSnapshot({ turns: [stale] }), 'thread');
    pendingWebSends.value = [testWebSubmission];
    keys = responseKeys();
    expect(new Set(keys).size).toBe(2);
    expect(keys.filter((key) => key.endsWith('response:active'))).toHaveLength(1);
  });

  it('releases the submitted draft immediately and does not clear a new identical draft at acknowledgement', async () => {
    let acknowledge: (sent: boolean) => void = () => {
      throw new Error('Missing submission');
    };
    vi.mocked(sendChat).mockImplementation((_text, _files, options) => {
      options?.onSubmitted?.();
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    });
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    expect(input.value).toBe('');
    expect(pinnedContext.value).toEqual([]);
    type('Unsent composer draft');
    acknowledge(true);
    await vi.waitFor(() => expect(composerSendInFlight.value).toBe(false));
    expect(input.value).toBe('Unsent composer draft');
  });

  it('keeps an unsubmitted draft on a cancelled choice and preserves new text after send failure', async () => {
    vi.mocked(sendChat).mockResolvedValueOnce(false);
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    await vi.waitFor(() => expect(composerSendInFlight.value).toBe(false));
    expect(input.value).toBe('Unsent composer draft');
    expect(pinnedContext.value).toEqual(['keep/context.txt']);
    vi.mocked(sendChat).mockImplementation(async (_text, _files, options) => {
      options?.onSubmitted?.();
      input.value = 'New draft';
      return false;
    });
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    await vi.waitFor(() => expect(composerSendInFlight.value).toBe(false));
    expect(input.value).toBe('New draft');
  });

  it('does not infer read-only permissions before a snapshot or while a client reload is required', () => {
    canSend.value = false;
    const banner = () => findComponent(ChatMain(), 'ReadonlyBanner').type();
    expect(banner().props.hidden).toBe(true);
    applyConversationFrame(
      testSnapshot({
        capabilities: { canSend: false, stop: false, steer: false, editInput: false, cancelInput: false },
      }),
      'thread',
    );
    expect(banner().props.children).toBe('Read-only view — sending is unavailable for this thread.');
    chatReloadRequired.value = true;
    const chat = ChatMain();
    expect(findComponent(chat, 'ReadonlyBanner').type().props.hidden).toBe(true);
    expect(findComponent(chat, 'InputDock')).toBeDefined();
    const overlay = find(chat, 'div');
    expect(overlay.props.class).toBe('chat-bottom-dock');
    expect(overlay.props.children[0].props.id).toBe('chat-status');
    expect(overlay.props.children[0].props.hidden).toBe(true);
    chatReloadRequired.value = false;
    channelType.value = 'slack';
    expect(banner().props.children).toEqual(['Read-only view — reply on ', 'Slack', ' to continue this thread.']);
  });

  it('shares the floating dock with the native scroller without a background scroll handler', () => {
    const chat = ChatMain();
    const log = findComponent(chat, 'MessageLog');
    const dock = find(chat, 'div');
    expect(dock.props.class).toBe('chat-bottom-dock');
    expect(log.props.dockRef).toBe(dock.ref);
    expect(chat.props.onScrollCapture).toBeUndefined();
  });

  it('measures dock clearance and scrollbar access before paint, following only a pinned transcript on resize', () => {
    const saved = {
      window,
      ResizeObserver: globalThis.ResizeObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    let dockHeight = 56;
    let resize = () => {};
    const observed: unknown[] = [];
    const disconnect = vi.fn();
    const properties = new Map<string, string>();
    const dock = { getBoundingClientRect: () => ({ height: dockHeight }) };
    class Observer {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(element: unknown) {
        observed.push(element);
      }
      disconnect = disconnect;
    }
    class Viewport extends EventTarget {
      clientHeight = 500;
      clientWidth = 785;
      offsetWidth = 800;
      clientTop = 0;
      ownerDocument = new EventTarget();
      parentElement = { style: { setProperty: (key: string, value: string) => properties.set(key, value) } };
      top = 0;
      get scrollHeight() {
        return 2000 + dockHeight;
      }
      get scrollTop() {
        return this.top;
      }
      set scrollTop(value: number) {
        this.top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value));
      }
      getBoundingClientRect() {
        return { top: 0 };
      }
      querySelectorAll() {
        return [];
      }
      querySelector() {
        return null;
      }
    }
    const viewport = new Viewport();
    const disposers: (() => void)[] = [];
    try {
      vi.stubGlobal(
        'window',
        Object.assign(new EventTarget(), {
          nanoclawAppearance: { beforeDensityChange: () => () => {} },
        }),
      );
      vi.stubGlobal('ResizeObserver', Observer);
      vi.stubGlobal('requestAnimationFrame', () => 0);
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
      resetMount();
      const component = findComponent(ChatMain(), 'MessageLog');
      component.props.dockRef.current = dock;
      resetMount();
      const view = component.type(component.props);
      const log = find(view, 'div');
      log.ref.current = viewport;
      for (const effect of hooks.effects.splice(0)) {
        const dispose = effect();
        if (dispose) disposers.push(dispose);
      }
      expect(observed).toEqual([viewport, dock]);
      expect(properties.get('--chat-dock-height')).toBe('56px');
      expect(properties.get('--chat-scrollbar-width')).toBe('15px');
      expect(viewport.scrollTop).toBe(1556);
      dockHeight = 144;
      resize();
      expect(properties.get('--chat-dock-height')).toBe('144px');
      expect(viewport.scrollTop).toBe(1644);
      viewport.scrollTop = 250;
      log.props.onScroll();
      dockHeight = 220;
      viewport.clientWidth = 780;
      resize();
      expect(properties.get('--chat-dock-height')).toBe('220px');
      expect(properties.get('--chat-scrollbar-width')).toBe('20px');
      expect(viewport.scrollTop).toBe(250);
    } finally {
      disposers.forEach((dispose) => dispose());
      for (const [key, value] of Object.entries(saved)) vi.stubGlobal(key, value);
    }
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('offers reload rather than reconnecting in a retained composer draft', () => {
    chatReady.value = false;
    chatReloadRequired.value = true;
    render();
    expect(find(tree, 'textarea').props.placeholder).toBe('Reload to continue\u2026');
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value[0].name).toBe('unsent.txt');
  });
  it('suspends composition for a dock prompt without replacing its draft, attachments or context', () => {
    const draft = input.value;
    const files = pending.value;
    const pins = pinnedContext.value;
    pendingQuestions.value = [dockQuestion];
    render();
    expect(find(tree, 'form').props.style).toBe('display:none');
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    expect(sendChat).not.toHaveBeenCalled();
    expect(input.value).toBe(draft);
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toBe(pins);
    const dock = InputDock();
    expect(find(dock, 'div').props.children[0].props.hidden).toBe(true);
    expect(findComponent(dock, 'QuestionPrompt').props.question).toBe(dockQuestion);
    pendingQuestions.value = [];
    render();
    expect(find(tree, 'form').props.style).toBe('');
    expect(input.value).toBe(draft);
    expect(pending.value).toBe(files);
  });
  it('autosizes an existing draft on a density change without replacing it', () => {
    const draft = input.value;
    const files = pending.value;
    expect(input.style.height).toBe('32px');
    input.scrollHeight = 76;
    appearance.value = {
      ...appearance.value,
      preferences: { ...DEFAULT_APPEARANCE, density: 'comfortable' },
    };
    render();
    expect(input.style.height).toBe('76px');
    expect(input.value).toBe(draft);
    expect(pending.value).toBe(files);
  });
  it('retains the normal composer height cap and inner scrolling for long message drafts', () => {
    input.scrollHeight = 500;
    type('Long ordinary message');
    expect(input.style.height).toBe('200px');
    expect(input.style.overflowY).toBe('auto');
  });

  const dockQuestion: PendingQuestionDto = {
    questionId: 'q',
    question: 'Choose?',
    responseMode: 'choice_or_text',
    options: [{ label: 'First', selectedLabel: 'Chosen first', value: 'first' }],
    status: 'pending',
    answerValue: null,
    answerType: null,
    answeredAt: null,
    threadId: 'thread',
    agentGroupId: 'group',
    createdAt: '2026-10-05T17:00:00Z',
  };

  describe('question dock controls', () => {
    const mount = (question = dockQuestion) => {
      hooks.cursor = 0;
      tree = QuestionPrompt({ question });
      const textarea = find(tree, 'textarea');
      if (textarea) {
        textarea.ref.current = input;
        input.value = textarea.props.value;
      }
      hooks.effects.splice(0).forEach((effect) => effect());
      return tree;
    };
    beforeEach(() => {
      resetMount('');
      vi.mocked(respondQuestion).mockReset().mockResolvedValue(true);
      vi.mocked(skipQuestion).mockReset().mockResolvedValue(true);
    });
    it('shows the question beside Skip without a separate title', () => {
      mount();
      const prompt = find(tree, 'section');
      expect(prompt.props['aria-label']).toBe(dockQuestion.question);
      const header = prompt.props.children[0];
      expect(header.props.children[0].props.children).toBe(dockQuestion.question);
      expect(header.props.children[1].props['aria-label']).toBe('Skip question and notify agent');
    });
    it('shares the ordinary composer input while omitting its attachment controls', () => {
      const ordinary = findComponent(tree, 'ComposerInput');
      mount();
      const answer = findComponent(tree, 'ComposerInput');
      expect(answer.type).toBe(ordinary.type);
      expect(answer.type).toBe(ComposerInput);
      expect(findComponent(tree, 'ComposerPlusMenu')).toBeUndefined();
      expect(find(tree, 'input')).toBeUndefined();
      expect(pending.value[0].name).toBe('unsent.txt');
      expect(pinnedContext.value).toEqual(['keep/context.txt']);
    });
    it.each([
      { name: 'desktop Enter', mobile: false, shiftKey: false, isComposing: false, submits: true },
      { name: 'Shift+Enter', mobile: false, shiftKey: true, isComposing: false, submits: false },
      { name: 'mobile Enter', mobile: true, shiftKey: false, isComposing: false, submits: false },
      { name: 'IME Enter', mobile: false, shiftKey: false, isComposing: true, submits: false },
    ])('shares $name handling with ordinary composition', ({ mobile, shiftKey, isComposing, submits }) => {
      const ordinary = find(tree, 'textarea').props.onKeyDown;
      mount();
      const answer = find(tree, 'textarea').props.onKeyDown;
      expect(answer).toBe(ordinary);
      isMobile.value = mobile;
      const requestSubmit = vi.fn();
      const preventDefault = vi.fn();
      for (const onKeyDown of [ordinary, answer]) {
        onKeyDown({
          key: 'Enter',
          shiftKey,
          isComposing,
          preventDefault,
          currentTarget: { form: { requestSubmit } },
        });
      }
      expect(requestSubmit).toHaveBeenCalledTimes(submits ? 2 : 0);
      expect(preventDefault).toHaveBeenCalledTimes(submits ? 2 : 0);
    });
    it('grows an answer beyond the ordinary cap so only the outer dock scrolls', () => {
      mount();
      input.value = 'An answer with several lines';
      find(tree, 'textarea').props.onInput({ currentTarget: input });
      mount();
      const files = pending.value;
      input.scrollHeight = 96;
      appearance.value = {
        ...appearance.value,
        preferences: { ...DEFAULT_APPEARANCE, density: 'comfortable' },
      };
      mount();
      expect(input.style.height).toBe('96px');
      expect(input.style.overflowY).toBe('hidden');
      expect(input.value).toBe('An answer with several lines');
      expect(pending.value).toBe(files);
      input.scrollHeight = 300;
      find(tree, 'textarea').props.onInput({ currentTarget: input });
      mount();
      expect(input.style.height).toBe('300px');
      expect(input.style.overflowY).toBe('hidden');
      const shared = findComponent(tree, 'ComposerInput');
      expect(ComposerInput(shared.props).props.class).toContain('multi-line');
      input.value = '';
      find(tree, 'textarea').props.onInput({ currentTarget: input });
      mount();
      expect(input.style.height).toBe('');
      expect(input.style.overflowY).toBe('hidden');
    });
    it('observes answer width changes using the shared composer sizing logic', () => {
      let resize!: () => void;
      const observe = vi.fn();
      const disconnect = vi.fn();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe = observe;
          disconnect = disconnect;
        },
      );
      try {
        hooks.capturePassive = true;
        mount();
        const dispose = hooks.passiveEffects.shift()?.();
        expect(observe).toHaveBeenCalledWith(input);
        input.value = 'Wrapped answer';
        find(tree, 'textarea').props.onInput({ currentTarget: input });
        input.scrollHeight = 116;
        resize();
        expect(input.style.height).toBe('116px');
        expect(input.style.overflowY).toBe('hidden');
        dispose?.();
        expect(disconnect).toHaveBeenCalledOnce();
      } finally {
        hooks.capturePassive = false;
        hooks.passiveEffects = [];
        vi.unstubAllGlobals();
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      }
    });
    it('skips once, blocks an answer race and waits for the actual response event', async () => {
      mount();
      const click = find(tree, 'button', 'Skip question and notify agent').props.onClick;
      click();
      click();
      find(tree, 'button', 'First').props.onClick();
      await vi.waitFor(() => expect(skipQuestion).toHaveBeenCalledOnce());
      mount();
      expect(skipQuestion).toHaveBeenCalledWith('q');
      expect(respondQuestion).not.toHaveBeenCalled();
      expect(sendChat).not.toHaveBeenCalled();
      expect(find(tree, 'button', 'First').props.disabled).toBe(true);
      expect(find(tree, 'button', 'Skip question and notify agent').props.disabled).toBe(true);
      expect(find(tree, 'div', 'Waiting for skip confirmation…')).toBeDefined();
    });
    it('retains typed text and offers a retry when skipping fails after the outcome is saved', async () => {
      vi.mocked(skipQuestion).mockResolvedValueOnce(false);
      mount();
      find(tree, 'textarea').props.onInput({ currentTarget: { value: 'Unsaved answer' } });
      mount();
      find(tree, 'button', 'Skip question and notify agent').props.onClick();
      await vi.waitFor(() => expect(skipQuestion).toHaveBeenCalledOnce());
      mount({ ...dockQuestion, status: 'answered', answerType: 'skipped' });
      expect(find(tree, 'textarea').props.value).toBe('Unsaved answer');
      expect(find(tree, 'p').props.role).toBe('alert');
      const retry = find(tree, 'button', 'Skip question and notify agent');
      expect(retry.props.children).toBe('Retry skip');
      expect(retry.props.disabled).toBe(false);
      retry.props.onClick();
      await vi.waitFor(() => expect(skipQuestion).toHaveBeenCalledTimes(2));
    });
    it('renders the skip event without interpreting it as a selected option', () => {
      const bubble = QuestionAnswerBubble({
        question: {
          ...dockQuestion,
          options: [{ label: 'Fake', selectedLabel: 'Not a skip', value: 'Question skipped' }],
        },
        answer: {
          id: 'question-response:q',
          direction: 'in',
          questionResponseType: 'skipped',
          text: 'Question skipped',
          ts: 'later',
          files: null,
        },
      });
      expect(bubble.props.children[0].props.dangerouslySetInnerHTML.__html).toBe(
        '<blockquote>\n<p>Choose?</p>\n</blockquote>\n<p>Question skipped</p>\n',
      );
      expect(bubble.props['data-msg-id']).toBe('question-response:q');
    });
    it('sends a choice once and waits for the authoritative answer event before restoring composition', async () => {
      mount();
      const click = find(tree, 'button', 'First').props.onClick;
      click();
      click();
      await vi.waitFor(() => expect(respondQuestion).toHaveBeenCalledOnce());
      mount();
      expect(respondQuestion).toHaveBeenCalledWith('q', 'first');
      expect(find(tree, 'button', 'First').props.disabled).toBe(true);
      expect(find(tree, 'button', 'Skip question and notify agent').props.disabled).toBe(true);
      expect(find(tree, 'section').props['aria-busy']).toBe(true);
      expect(find(tree, 'div', 'Waiting for answer confirmation…')).toBeDefined();
    });
    it('keeps a failed text answer for retry, without using the ordinary send path', async () => {
      vi.mocked(respondQuestion).mockResolvedValueOnce(false);
      mount();
      find(tree, 'textarea').props.onInput({ currentTarget: { value: '  My answer  ' } });
      mount();
      find(tree, 'form').props.onSubmit({ preventDefault() {} });
      await vi.waitFor(() => expect(respondQuestion).toHaveBeenCalledWith('q', 'My answer'));
      mount();
      expect(find(tree, 'textarea').props.value).toBe('  My answer  ');
      expect(find(tree, 'p').props.role).toBe('alert');
      expect(find(tree, 'button', 'Send answer').props.disabled).toBe(false);
      expect(sendChat).not.toHaveBeenCalled();
      find(tree, 'form').props.onSubmit({ preventDefault() {} });
      await vi.waitFor(() => expect(respondQuestion).toHaveBeenCalledTimes(2));
    });
    it('locks a metadata-only answered prompt and disables sends while disconnected', () => {
      mount({ ...dockQuestion, status: 'answered' });
      expect(find(tree, 'button', 'First').props.disabled).toBe(true);
      expect(find(tree, 'div', 'Waiting for answer confirmation…')).toBeDefined();
      resetMount('');
      chatReady.value = false;
      mount();
      expect(find(tree, 'button', 'Send answer').props.disabled).toBe(true);
      expect(find(tree, 'button', 'Skip question and notify agent').props.disabled).toBe(true);
      expect(find(tree, 'div', 'Reconnecting…')).toBeDefined();
    });
    it.each(['choice', 'text', 'choice_or_text'] as const)(
      'renders %s input using the existing voice control',
      (responseMode) => {
        mount({ ...dockQuestion, responseMode, options: responseMode === 'text' ? [] : dockQuestion.options });
        expect(!!find(tree, 'textarea')).toBe(responseMode !== 'choice');
        expect(!!findComponent(tree, 'VoiceButton')).toBe(responseMode !== 'choice');
        expect(!!find(tree, 'button', 'First')).toBe(responseMode !== 'text');
      },
    );
    it('routes dictation into the question answer, not the preserved composer draft', async () => {
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
      vi.stubGlobal('AudioContext', vi.fn());
      vi.stubGlobal('AudioWorkletNode', vi.fn());
      const config = voiceInput.value;
      voiceInput.value = { ...config, ready: true };
      const start = vi.spyOn(voice, 'start').mockImplementation(() => {});
      try {
        mount();
        findComponent(tree, 'VoiceButton').props.onStart();
        const target = start.mock.calls[0][0];
        expect(target.key).toBe('group:thread:question:q');
        target.setText('Dictated answer');
        mount();
        expect(find(tree, 'textarea').props.value).toBe('Dictated answer');
        expect(await target.send()).toBe(true);
        expect(respondQuestion).toHaveBeenCalledWith('q', 'Dictated answer');
        expect(sendChat).not.toHaveBeenCalled();
      } finally {
        start.mockRestore();
        voiceInput.value = config;
        vi.unstubAllGlobals();
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      }
    });
  });

  it('uses the existing textarea and a checkmark, preserving the ordinary draft and attachments on save', async () => {
    const files = pending.value;
    const attachments = message.files;
    const turn = activeTurn.value;
    open();
    expect(input.value).toBe('Original');
    expect(pending.value).toEqual([]);
    expect(find(tree, 'button', 'Save edit').props.children).toBe('✓');
    expect(find(tree, 'input').props.disabled).toBe(true);
    type('Revision');
    await save();
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toEqual(['keep/context.txt']);
    expect(chatMessages.value[0].text).toBe('Original');
    expect(chatMessages.value[0].files).toBe(attachments);
    expect(activeTurn.value).toBe(turn);
    expect(sendChat).not.toHaveBeenCalled();
    expect(find(tree, 'button', 'Send')).toBeTruthy();
    applyConversationFrame(
      testSnapshot({
        messages: [
          {
            id: 'message',
            direction: 'in',
            text: 'Revision',
            timestamp: '1',
            files: [{ filename: 'instructions.txt', size: 1 }],
            inputState: message.inputState,
          },
        ],
      }),
      'thread',
    );
    expect(chatMessages.value[0].text).toBe('Revision');
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value).toBe(files);
  });

  it('exits without a request and restores the draft; reopening keeps the unsaved revision', () => {
    const files = pending.value;
    open();
    type('Unsaved revision');
    exit();
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value).toBe(files);
    expect(fetch).not.toHaveBeenCalled();
    open();
    expect(input.value).toBe('Unsaved revision');
  });

  it('keeps unsaved edits visible and disables save when the input becomes consumed', () => {
    open();
    type('Unsaved revision');
    chatMessages.value = [
      {
        ...message,
        timelinePosition: 123,
        canEditPending: false,
        inputState: { messageId: 'message', status: 'processing' },
      },
    ];
    render();
    expect(input.value).toBe('Unsaved revision');
    expect(find(tree, 'button', 'Save edit').props.disabled).toBe(true);
    expect(find(tree, 'p').props.children).toContain('draft has been kept');
    exit();
    expect(input.value).toBe('Unsent composer draft');
  });

  it('preserves a conflict during an in-flight consumption and reuses its original retry body', async () => {
    let finish!: (response: any) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    open();
    type('Racing revision');
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    render();
    expect(find(tree, 'button', 'Saving…').props.disabled).toBe(true);
    expect(find(tree, 'textarea').props.readOnly).toBe(true);
    chatMessages.value = [
      { ...message, inputState: { messageId: 'message', status: 'applied' }, canEditPending: false },
    ];
    const conflict = { ok: false, status: 409, json: async () => ({ error: 'steering_consumed' }) };
    finish(conflict);
    await vi.waitFor(() => expect(currentPendingEditor()?.[1].draft.state.value.busy).toBe(false));
    render();
    expect(input.value).toBe('Racing revision');
    expect(find(tree, 'p').props.children).toContain('already been consumed');
    vi.mocked(fetch).mockResolvedValue(conflict as Response);
    await save();
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(vi.mocked(fetch).mock.calls[0][1]?.body);
  });

  it('locks ambiguous saves across exit/reopen and blocks cancellation until confirmed', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'edit_pending' }),
    } as Response);
    open();
    type('Revision');
    await save();
    const body = vi.mocked(fetch).mock.calls[0][1]?.body;
    expect(find(tree, 'textarea').props.readOnly).toBe(true);
    const actions = PendingMessageActions({ gid: 'group', thread, message });
    expect(find(actions, 'button', 'Cancel pending message').props.disabled).toBe(true);
    exit();
    expect(input.value).toBe('Unsent composer draft');
    open();
    expect(input.value).toBe('Revision');
    expect(find(tree, 'textarea').props.readOnly).toBe(true);
    await save();
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(body);
  });

  it('does not restore or clear another conversation when a late save finishes', async () => {
    const files = pending.value;
    let finish!: (response: any) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    open();
    type('Revision');
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    threadId.value = 'other';
    chatMessages.value = [{ ...message, text: 'Other conversation' }];
    render();
    type('Other draft');
    const otherFiles = [{ name: 'other.txt', size: 2 }];
    pending.value = otherFiles;
    render();
    finish({ ok: true, status: 200, json: async () => ({ ok: true, id: 'message', text: 'Revision' }) });
    await vi.waitFor(() => expect(pendingEditorSessions.value.size).toBe(0));
    render();
    expect(input.value).toBe('Other draft');
    expect(pending.value).toBe(otherFiles);
    expect(chatMessages.value[0].text).toBe('Other conversation');
    threadId.value = 'thread';
    render();
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value).toBe(files);
    threadId.value = 'other';
    render();
    expect(input.value).toBe('Other draft');
    expect(pending.value).toBe(otherFiles);
  });

  it('blocks attachment paste and prevents Enter from sending new input while editing', () => {
    open();
    const preventDefault = vi.fn();
    find(tree, 'textarea').props.onPaste({ clipboardData: { files: [new File(['x'], 'x.txt')] }, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(pending.value).toEqual([]);
    type('Revision');
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sendChat).not.toHaveBeenCalled();
  });

  it('does not capture a draft still being submitted as a normal message', async () => {
    let finish!: (sent: boolean) => void;
    vi.mocked(sendChat).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
    expect(composerSendInFlight.value).toBe(true);
    open();
    expect(currentPendingEditor()).toBeUndefined();
    expect(input.value).toBe('Unsent composer draft');
    finish(false);
    await vi.waitFor(() => expect(composerSendInFlight.value).toBe(false));
    open();
    expect(input.value).toBe('Original');
  });

  it('parks both conversations safely when returning to an unresolved editor', async () => {
    const originalFiles = pending.value;
    vi.mocked(fetch).mockRejectedValue(new Error('lost'));
    open();
    type('Unknown-outcome revision');
    await save();
    threadId.value = 'other';
    render();
    type('Other unsent draft');
    const otherFiles = [{ name: 'other.txt', size: 2 }];
    pending.value = otherFiles;
    threadId.value = 'thread';
    render();
    expect(input.value).toBe('Unknown-outcome revision');
    expect(find(tree, 'textarea').props.readOnly).toBe(true);
    expect(pending.value).toEqual([]);
    exit();
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value).toBe(originalFiles);
    threadId.value = 'other';
    render();
    expect(input.value).toBe('Other unsent draft');
    expect(pending.value).toBe(otherFiles);
  });

  it('restores the ordinary draft when the edited input is authoritatively cancelled', () => {
    const files = pending.value;
    open();
    type('Unsaved revision');
    confirmCancelledInput(message.id!);
    chatMessages.value = [];
    render();
    expect(input.value).toBe('Unsent composer draft');
    expect(pending.value).toBe(files);
    expect(find(tree, 'button', 'Send')).toBeTruthy();
  });

  it('blocks a composer save while cancellation is unresolved, without dropping the edit draft', async () => {
    open();
    type('Unsaved revision');
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'cancel_pending' }),
    } as Response);
    const request = new PendingCancellation('group', thread, message.id!);
    pendingCancellations.value = new Map([[currentPendingEditor()![0], request]]);
    await request.cancel();
    render();
    expect(find(tree, 'button', 'Save edit').props.disabled).toBe(true);
    await save();
    expect(fetch).toHaveBeenCalledOnce();
    expect(input.value).toBe('Unsaved revision');
    exit();
    expect(input.value).toBe('Unsent composer draft');
  });

  it('does not render a separate queue area in the ordinary message log', () => {
    hooks.cursor = 0;
    const chat = ChatMain();
    const components = [chat.props.children].flat(Infinity);
    const log = components.find((child: any) => typeof child?.type === 'function' && child.type.name === 'MessageLog');
    hooks.slots = [];
    hooks.cursor = 0;
    const view = log.type(log.props);
    expect(find(view, 'section', 'Queued follow-ups')).toBeUndefined();
    const logNode = find(view, 'div');
    expect(logNode).toBeTruthy();
    const logContents = [logNode.props.children].flat(Infinity);
    const pendingBubble = logContents.find((node: any) => node?.props?.m?.id === message.id);
    expect(pendingBubble?.type.name).toBe('Message');
    expect(find(view, 'h3')).toBeUndefined();
  });

  it('does not offer branching from the latest response', () => {
    threads.value = [thread];
    activeTurn.value = null;
    applyConversationFrame(
      testSnapshot({
        messages: [
          { id: 'older-response', text: 'Older', timestamp: '1', timelinePosition: 100, direction: 'out' },
          { id: 'latest-response', text: 'Latest', timestamp: '2', timelinePosition: 200, direction: 'out' },
        ],
      }),
      'thread',
    );

    hooks.cursor = 0;
    const chat = ChatMain();
    const components = [chat.props.children].flat(Infinity);
    const log = components.find((child: any) => typeof child?.type === 'function' && child.type.name === 'MessageLog');
    hooks.slots = [];
    hooks.cursor = 0;
    const view = log.type(log.props);
    const logNode = find(view, 'div');
    const messages = [logNode.props.children].flat(Infinity).filter((node: any) => node?.type?.name === 'Message');

    const forkButtons = messages.map((messageNode: any) => {
      hooks.slots = [];
      hooks.cursor = 0;
      return findComponent(messageNode.type(messageNode.props), 'ForkButton');
    });

    hooks.slots = [];
    hooks.cursor = 0;
    expect(forkButtons[0].type(forkButtons[0].props)).not.toBeNull();
    hooks.slots = [];
    hooks.cursor = 0;
    expect(forkButtons[1].type(forkButtons[1].props)).toBeNull();
  });

  it.each([false, true])(
    'shows the counted start row with a bottom stopwatch but no empty usage disclosure (%s)',
    (technical) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      applyConversationFrame(
        testSnapshot({
          turns: [{ ...testTurn, activity: [], startedAt: new Date(Date.now() - 7000).toISOString() }],
          connection: { connected: true, activeTurnId: testTurn.id },
        }),
        'thread',
      );
      // The first live turn opens its trace; close it to see the status-line preview.
      if (technical) closeTrace(`turn:${testTurn.id}`);
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const turnRow = findComponent(log.type(log.props), 'ResponseStatusRow');
      hooks.slots = [];
      hooks.cursor = 0;
      const row = turnRow.type(turnRow.props);
      const [header, footer] = row.props.children;
      expect(!!header).toBe(technical);
      if (technical) {
        expect(header.type.name).toBe('TurnTechnicalDetails');
        const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
        expect(info.props.count).toBe(1);
        expect(findComponent(info.type(info.props), 'UsageMeta')).toBeUndefined();
      }
      expect(findComponent(footer, 'TurnElapsed').props.ms).toEqual(expect.any(Number));
      const headline = footer.props.children.filter(Boolean).at(-1).props.children;
      expect(headline.type(headline.props).props.children).toContain('Preparing…');
    },
  );

  it.each(
    (['running', 'stopping', 'settling'] as const).flatMap((phase) =>
      [false, true].map((recordedActivity) => ({ phase, recordedActivity })),
    ),
  )('only offers $phase usage when accounting arrives (activity=$recordedActivity)', ({ phase, recordedActivity }) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    for (const accounting of [
      { usage: [] },
      {
        usage: [
          {
            id: 'zero',
            value: {
              cost_usd: 0,
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              model: 'fixture-model',
            },
          },
        ],
      },
      { usage: [{ id: 'timing-only', value: { duration_api_ms: 0 } }] },
    ]) {
      resetConversation();
      applyConversationFrame(
        testSnapshot({
          turns: [
            {
              ...testTurn,
              phase,
              activity: recordedActivity ? testTurn.activity : [],
              metadata: { status: 'provisional', model: 'fixture-model', durationMs: null },
              ...accounting,
            },
          ],
          connection: { connected: true, activeTurnId: testTurn.id },
        }),
        'thread',
      );
      resetMount();
      const log = findComponent(ChatMain(), 'MessageLog');
      resetMount();
      const status = findComponent(log.type(log.props), 'ResponseStatusRow');
      resetMount();
      const row = status.type(status.props);
      expect(findComponent(row.props.children.at(-1), 'TurnElapsed').props.ms).toEqual(expect.any(Number));
      const details = renderTechnicalDetails(row);
      const info = findComponent(details, 'TurnTechnicalInfo');
      const header = info?.type(info.props);
      if (recordedActivity) {
        const trace = findComponent(header, 'ActivityTraceToggle');
        expect(trace.type(trace.props)).not.toBeNull();
      }
      const usage = findComponent(header, 'UsageMeta');
      expect(!!usage).toBe(accounting.usage.length > 0);
      if (usage) {
        resetMount();
        expect(find(usage.type(usage.props), 'span').props.children).toBe('\u203A');
        expect(find(usage.type(usage.props), 'span', 'Usage details')).toBeDefined();
      }
    }
  });

  it.each([false, true])(
    'mirrors the finished activity in the status line with technical information %s',
    (technical) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      for (const phase of ['running', 'stopping', 'settling'] as const) {
        resetConversation();
        const activity = [
          {
            ordinal: 0,
            timelinePosition: 100,
            ts: '1000',
            text: JSON.stringify({
              kind: 'tool',
              id: 'completed-call',
              tool: 'bash',
              status: 'completed',
              detail: 'pnpm test',
            }),
          },
        ];
        // The runner's marker for when the first model call could start.
        const ready = {
          ordinal: 1,
          timelinePosition: 50,
          ts: String(Date.parse(testTurn.startedAt!)),
          text: JSON.stringify({ kind: 'model', id: 'model:ready', durationMs: 0 }),
        };
        applyConversationFrame(
          testSnapshot({
            turns: [{ ...testTurn, phase, activity: [ready, ...activity] }],
            connection: { connected: true, activeTurnId: testTurn.id },
          }),
          'thread',
        );
        if (technical) closeTrace(`turn:${testTurn.id}`);
        hooks.slots = [];
        hooks.cursor = 0;
        const log = findComponent(ChatMain(), 'MessageLog');
        hooks.slots = [];
        hooks.cursor = 0;
        const turnRow = findComponent(log.type(log.props), 'ResponseStatusRow');
        hooks.slots = [];
        hooks.cursor = 0;
        const row = turnRow.type(turnRow.props);
        const headline = row.props.children.at(-1).props.children.filter(Boolean).at(-1).props.children;
        const expected = phase === 'stopping' ? 'Stopping…' : 'Ran';
        expect(headline.type(headline.props).props.children).toContain(expected);
        if (technical) {
          const details = renderTechnicalDetails(row);
          expect(findComponent(details, 'TurnTechnicalInfo').props.count).toBe(2);
          const panel = findComponent(details, 'ActivityTracePanel');
          expect(JSON.parse(panel.props.lines[0].text).text).toBe('Started response');
          if (phase === 'stopping') {
            expect(JSON.parse(panel.props.lines.at(-1).text).text).toBe(expected);
            expect(panel.props.lines).toHaveLength(3);
          } else {
            expect(panel.props.lines.slice(1)).toMatchObject(activity);
            expect(panel.props.lines[1].modelTime).toEqual({ ms: 0, since: Date.parse(testTurn.startedAt!) });
          }
        }
        expect(turnRow.props.source.turn.activity).toEqual([ready, ...activity]);
        expect(turnRow.props.source.activity).toHaveLength(2);
      }
    },
  );

  it.each([false, true])('keeps stopping, disconnect and Stop errors inside the regular footer (%s)', (technical) => {
    appearance.value = {
      ...appearance.peek(),
      preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
    };
    for (const notice of [
      { phase: 'stopping' as const, connected: true, error: '', text: 'Stopping…' },
      { phase: 'running' as const, connected: false, error: '', text: 'Runner disconnected' },
      { phase: 'running' as const, connected: true, error: 'Stop failed.', text: 'Stop failed.' },
    ]) {
      resetConversation();
      applyConversationFrame(
        testSnapshot({
          turns: [{ ...testTurn, phase: notice.phase, activity: [] }],
          connection: { connected: notice.connected, activeTurnId: testTurn.id },
        }),
        'thread',
      );
      stopRequest.value = notice.error ? { turnId: testTurn.id, busy: false, error: notice.error } : null;
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const turnRow = findComponent(log.type(log.props), 'ResponseStatusRow');
      hooks.slots = [];
      hooks.cursor = 0;
      const row = turnRow.type(turnRow.props);
      const caption = row.props.children.at(-1).props.children.filter(Boolean).at(-1);
      expect(caption.type).toBe('span');
      expect(caption.props.role).toBe(notice.error ? 'alert' : 'status');
      expect(caption.props.children.type(caption.props.children.props).props.children).toContain(notice.text);
      if (technical) {
        const details = renderTechnicalDetails(row);
        const info = findComponent(details, 'TurnTechnicalInfo');
        expect(info.props.count).toBe(1);
        const panel = findComponent(details, 'ActivityTracePanel');
        expect(JSON.parse(panel.props.lines[0].text).text).toBe('Preparing…');
        expect(JSON.parse(panel.props.lines.at(-1).text).text).toBe(notice.text);
      }
    }
  });

  it.each([false, true].flatMap((technical) => [false, true].map((recorded) => ({ technical, recorded }))))(
    'omits settled timing from the shared technical line ($technical, recorded steps $recorded)',
    ({ technical, recorded }) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      applyConversationFrame(
        testSnapshot({
          messages: [
            {
              id: 'settled-reply',
              direction: 'out',
              text: 'Reply',
              timestamp: '2026-09-29T00:00:02Z',
              timelinePosition: 200,
              turnId: testTurn.id,
            },
          ],
          turns: [
            {
              ...testTurn,
              phase: 'settled',
              outcome: 'replied',
              outputIds: ['settled-reply'],
              activity: recorded ? testTurn.activity : [],
              metadata: { status: 'final', model: 'fixture-model', durationMs: 6500 },
            },
          ],
          connection: { connected: true, activeTurnId: null },
        }),
        'thread',
      );

      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const messageNode = findComponent(log.type(log.props), 'Message');
      hooks.slots = [];
      hooks.cursor = 0;
      const row = messageNode.type(messageNode.props);
      const [header] = row.props.children;
      expect(!!header).toBe(technical);
      if (technical) {
        expect(header.type.name).toBe('TurnTechnicalDetails');
        const details = renderTechnicalDetails(row);
        expect(details.props.class).toBe('turn-technical-details');
        const [info, panel] = details.props.children;
        expect(info.type.name).toBe('TurnTechnicalInfo');
        expect(panel.type.name).toBe('ActivityTracePanel');
        expect(info.props.count).toBe(recorded ? 2 : 0);
        const toggle = findComponent(info.type(info.props), 'ActivityTraceToggle');
        expect(!!toggle.type(toggle.props)).toBe(recorded);
        expect(findComponent(info.type(info.props), 'TurnElapsed')).toBeUndefined();
        expect(find(info.type(info.props), 'span', 'Model-call time')).toBeUndefined();
      }
      const footer = row.props.children.at(-1);
      expect(footer.props.class).toBe('meta turn-info');
      expect(findComponent(footer, 'ReplyTurnInfo')).toBeUndefined();
    },
  );

  it.each([
    { model: null, usage: [] },
    { model: 'fixture-model', usage: [] },
    { model: null, usage: [{ id: 'timing-only', value: { duration_api_ms: 1200 } }] },
    { model: 'fixture-model', usage: [{ id: 'cost-only', value: { cost_usd: 0.01 } }] },
  ])('omits unavailable-token labels without losing partial usage details (%s)', ({ model, usage }) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    applyConversationFrame(
      testSnapshot({
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome: 'failed',
            activity: [],
            usage,
            metadata: { status: 'partial', model, durationMs: 6500 },
          },
        ],
        connection: { connected: true, activeTurnId: null },
      }),
      'thread',
    );
    resetMount();
    const log = findComponent(ChatMain(), 'MessageLog');
    resetMount();
    const status = findComponent(log.type(log.props), 'ResponseStatusRow');
    resetMount();
    const row = status.type(status.props);
    expect(find(row, 'span', 'Failed')).toBeUndefined();
    expect(find(row, 'span', 'Done')).toBeUndefined();
    const details = renderTechnicalDetails(row);
    const info = findComponent(details, 'TurnTechnicalInfo');
    const header = info.type(info.props);
    expect(find(header, 'span', 'Tokens unavailable')).toBeUndefined();
    const record = findComponent(header, 'UsageMeta');
    if (usage.length) {
      resetMount();
      hooks.cursor = 0;
      const summary = record.type(record.props);
      const button = find(summary, 'button');
      expect(find(summary, 'span', 'Tokens unavailable')).toBeUndefined();
      expect(find(summary, 'span', model ? '6.5s · $0.010' : '6.5s')).toBeDefined();
      button.props.onClick({ stopPropagation() {} });
      const inline = renderUsageDetails(row);
      expect(inline.props.role).toBe('group');
      expect(usageRow(inline, 'Total')).toBe('6.5s');
    }
  });

  it.each(
    [false, true].flatMap((technical) => [false, true].map((systemGenerated) => ({ technical, systemGenerated }))),
  )(
    'keeps failure technical information inside its bubble without a Failed label ($technical, system notice=$systemGenerated)',
    ({ technical, systemGenerated }) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      const activity = [
        {
          kind: 'notification',
          id: 'failure',
          text: 'Provider request failed',
          detail: 'Provider rejected the request.',
        },
        { kind: 'notification', id: 'explanation', text: 'Asking model to explain failure' },
        {
          kind: 'notification',
          id: 'explanation-result',
          text: systemGenerated ? 'System notice recorded after failure' : 'Model output recorded after failure',
        },
      ].map((step, ordinal) => ({
        ordinal,
        ts: String(1000 + ordinal),
        timelinePosition: 150 + ordinal,
        text: JSON.stringify(step),
      }));
      applyConversationFrame(
        testSnapshot({
          messages: [
            {
              id: 'failure-ack',
              direction: 'out',
              text: 'The provider could not complete your request.',
              timestamp: '2026-09-29T00:00:02Z',
              timelinePosition: 200,
              turnId: testTurn.id,
              deliveryOrigin: 'response',
              systemGenerated,
            },
          ],
          turns: [
            {
              ...testTurn,
              phase: 'settled',
              outcome: 'failed',
              outputIds: ['failure-ack'],
              activity,
              metadata: { status: 'partial', model: 'fixture-model', durationMs: 6500 },
            },
          ],
          connection: { connected: true, activeTurnId: null },
        }),
        'thread',
      );
      resetMount();
      const log = findComponent(ChatMain(), 'MessageLog');
      resetMount();
      const logTree = log.type(log.props);
      const message = findComponent(logTree, 'Message');
      resetMount();
      const bubble = message.type(message.props);
      expect(
        isSystemNotice(message.props.m.direction, message.props.m.systemGenerated, message.props.m.suggestedAction),
      ).toBe(systemGenerated);
      expect(findComponent(bubble, 'ReplyTurnInfo')).toBeUndefined();
      expect(find(bubble, 'span', 'Failed')).toBeUndefined();
      expect(find(bubble, 'span', 'Done')).toBeUndefined();
      expect(bubble.props.class.includes('system-notice')).toBe(systemGenerated);
      expect(findComponent(logTree, 'ResponseStatusRow')).toBeUndefined();
      const details = renderTechnicalDetails(bubble);
      if (!technical) {
        expect(details).toBeUndefined();
        return;
      }
      const panel = findComponent(details, 'ActivityTracePanel');
      expect(JSON.parse(panel.props.lines[0].text).id).toBe(`ui:start:${testTurn.id}`);
      expect(panel.props.lines.slice(1)).toEqual(activity);
      const header = findComponent(details, 'TurnTechnicalInfo');
      expect(header.props.count).toBe(4);
    },
  );

  it.each(
    [false, true].flatMap((technical) =>
      (
        [
          { name: 'text reply', content: {} },
          { name: 'system warning', content: { systemGenerated: true } },
          { name: 'suggested-action notice', content: { suggestedAction: 'retry' } },
          { name: 'file-only reply', content: { text: '', files: [{ filename: 'report.txt', size: 128 }] } },
          {
            name: 'audio-only reply',
            content: {
              text: '',
              files: [{ filename: 'reply.wav', size: 128, contentType: 'audio/wav', url: 'blob:fixture-audio' }],
            },
          },
          {
            name: 'video-only reply',
            content: {
              text: '',
              files: [{ filename: 'reply.mp4', size: 128, contentType: 'video/mp4', url: 'blob:fixture-video' }],
            },
          },
          {
            name: 'display card',
            content: { card: { title: 'Card', description: 'Reply', children: [], actions: [] } },
          },
        ] satisfies { name: string; content: Partial<ConversationMessage> }[]
      ).map(({ name, content }) => ({
        technical,
        name,
        content,
      })),
    ),
  )('places $name technical information inside its bubble ($technical)', ({ technical, content }) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical } };
    applyConversationFrame(
      testSnapshot({
        messages: [
          {
            id: 'reply',
            direction: 'out',
            text: 'Reply',
            timestamp: '2026-09-29T00:00:07Z',
            timelinePosition: 200,
            turnId: testTurn.id,
            deliveryOrigin: 'response',
            ...content,
          },
        ],
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome: 'warning',
            outputIds: ['reply'],
            endedAt: '2026-09-29T00:00:07Z',
            metadata: { status: 'final', model: 'fixture-model', durationMs: 7000 },
            usage: [{ id: 'usage', value: { cost_usd: 0.01, context_tokens: 35, context_window: 100 } }],
          },
        ],
      }),
      'thread',
    );
    resetMount();
    hooks.cursor = 0;
    const log = findComponent(ChatMain(), 'MessageLog');
    resetMount();
    hooks.cursor = 0;
    const logTree = log.type(log.props);
    const message = findComponent(logTree, 'Message');
    resetMount();
    hooks.cursor = 0;
    let bubble = message.type(message.props);
    const card = findComponent(bubble, 'DisplayCardMessage');
    if (card) bubble = card.type(card.props);
    expect(findComponent(logTree, 'ResponseStatusRow')).toBeUndefined();
    const details = findComponent(bubble, 'TurnTechnicalDetails');
    expect(!!details).toBe(technical);
    if (details) {
      expect(bubble.props.children[0]).toBe(details);
      expect(details.props.turn.id).toBe(testTurn.id);
      expect(details.props.ownerId).toBe(`turn:${testTurn.id}`);
      expect(details.props.lines).toHaveLength(3);
    }
  });

  it.each((['running', 'stopping', 'settling'] as const).map((phase) => ({ phase })))(
    'omits elapsed time from $phase trace status without losing inline or stopwatch timing',
    ({ phase }) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T00:00:07Z'));
      onTestFinished(() => clock.mockRestore());
      appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
      const value = {
        cost_usd: 0.0123,
        context_tokens: 7000,
        context_window: 20_000,
        input_tokens: 100,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        model: 'fixture-model',
        duration_api_ms: 2000,
        duration_ms: 999999,
      };
      applyConversationFrame(
        testSnapshot({
          turns: [
            {
              ...testTurn,
              phase,
              metadata: { status: 'final', model: 'fixture-model', durationMs: 999999 },
              usage: [{ id: 'usage', value }],
            },
          ],
          connection: { connected: true, activeTurnId: testTurn.id },
        }),
        'thread',
      );
      resetMount();
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      resetMount();
      hooks.cursor = 0;
      const status = findComponent(log.type(log.props), 'ResponseStatusRow');
      resetMount();
      hooks.cursor = 0;
      const row = status.type(status.props);
      const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
      const usage = findComponent(info.type(info.props), 'UsageMeta');
      expect(usage.props.summary).toBe('$0.012 · 35% ctx');
      expect(info.props.usage.wallElapsedMs).toBe(7000);
      const stopwatch = findComponent(row.props.children.at(-1), 'TurnElapsed');
      expect(stopwatch.props.ms).toBe(info.props.usage.wallElapsedMs);
      resetMount();
      hooks.cursor = 0;
      find(usage.type(usage.props), 'button').props.onClick({ stopPropagation() {} });
      const inline = renderUsageDetails(row);
      expect(usageRow(inline, 'Total')).toBe('7.0s');
      expect(usageRow(inline, 'Model')).toBe('2.0s');
      const timing = find(inline, 'section', 'Timing');
      const modelRow = [timing.props.children].flat().find((child: any) => child?.props?.label === 'Model');
      // Shares the trace AI column's color.
      expect(modelRow.props.kind).toBe('model-time');
      expect(modelRow.type(modelRow.props).props.class).toBe('usage-row usage-row-model-time');
      expect(find(inline, 'span', 'Usage reported so far; awaiting final totals.')).toBeUndefined();
    },
  );

  it.each([
    { phase: 'running', window: 20_000, expected: '80%' },
    { phase: 'settled', window: 20_000, expected: '80%' },
    { phase: 'running', window: undefined, expected: '' },
  ] as const)('reads context from the same usage record as tokens ($phase, $window)', ({ phase, window, expected }) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    const recorded = {
      cost_usd: 0.0123,
      context_tokens: 16_000,
      context_window: window,
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'fixture-model',
      num_turns: 10,
    };
    applyConversationFrame(
      testSnapshot({
        turns: [
          {
            ...testTurn,
            phase,
            outcome: phase === 'settled' ? 'silent' : 'pending',
            usage: [{ id: 'recorded', value: recorded }],
          },
        ],
        connection: { connected: true, activeTurnId: phase === 'settled' ? null : testTurn.id },
      }),
      'thread',
    );
    resetMount();
    const log = findComponent(ChatMain(), 'MessageLog');
    resetMount();
    const status = findComponent(log.type(log.props), 'ResponseStatusRow');
    resetMount();
    const row = status.type(status.props);
    const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
    const usage = findComponent(info.type(info.props), 'UsageMeta');
    expect(usage.props.summary).toBe(expected ? `$0.012 · ${expected} ctx` : '$0.012');
    expect(info.props.usage.live).toBe(phase !== 'settled');
    resetMount();
    hooks.cursor = 0;
    find(usage.type(usage.props), 'button').props.onClick({ stopPropagation() {} });
    const inline = renderUsageDetails(row);
    expect(usageRow(inline, 'Context utilization')).toBe(expected ? `16.0k tok \u00b7 ${expected}` : '16.0k tok');
    expect(usageRow(inline, 'Context size')).toBe(window ? '20.0k tok' : undefined);
    expect(usageRow(inline, 'Estimated cost')).toBe('$0.012');
  });

  it.each([
    { modelMs: 3500, extraMs: 1000, modelText: '4.5s', otherText: '2.0s' },
    { modelMs: 0, extraMs: 0, modelText: undefined, otherText: '6.5s' },
    { modelMs: undefined, extraMs: 1000, modelText: 'Unavailable', otherText: 'Unavailable' },
    { modelMs: 8500, extraMs: 0, modelText: '8.5s', otherText: undefined },
  ])(
    'keeps total, model and other timing inline but not in the technical line (%s)',
    ({ modelMs, extraMs, modelText, otherText }) => {
      appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
      applyConversationFrame(
        testSnapshot({
          turns: [
            {
              ...testTurn,
              phase: 'settled',
              outcome: 'silent',
              metadata: { status: 'final', model: 'm', durationMs: 6500 },
              usage: [
                { id: 'timing', value: { cost_usd: 0.1, duration_ms: 999999, duration_api_ms: modelMs } },
                { id: 'extra-timing', value: { duration_api_ms: extraMs } },
              ],
            },
          ],
          connection: { connected: true, activeTurnId: null },
        }),
        'thread',
      );
      resetMount();
      const log = findComponent(ChatMain(), 'MessageLog');
      resetMount();
      const status = findComponent(log.type(log.props), 'ResponseStatusRow');
      resetMount();
      const row = status.type(status.props);
      const details = renderTechnicalDetails(row);
      const info = findComponent(details, 'TurnTechnicalInfo');
      const header = info.type(info.props);
      expect(find(header, 'span', 'Model-call time')).toBeUndefined();
      expect(findComponent(header, 'TurnElapsed')).toBeUndefined();
      const usage = findComponent(header, 'UsageMeta');
      resetMount();
      hooks.cursor = 0;
      const summary = usage.type(usage.props);
      find(summary, 'button').props.onClick({ stopPropagation() {} });
      const inline = renderUsageDetails(row);
      expect(usageRow(inline, 'Total')).toBe('6.5s');
      expect(usageRow(inline, 'Model')).toBe(modelText);
      expect(usageRow(inline, 'Tools')).toBeUndefined();
      expect(usageRow(inline, 'Other')).toBe(otherText);
    },
  );

  it.each([false, true].flatMap((technical) => [false, true].map((recorded) => ({ technical, recorded }))))(
    'groups settled card technical information and trace before content ($technical, recorded steps $recorded)',
    ({ technical, recorded }) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      applyConversationFrame(
        testSnapshot({
          messages: [
            {
              id: 'settled-card',
              direction: 'out',
              text: '',
              timestamp: '2026-09-29T00:00:02Z',
              timelinePosition: 200,
              turnId: testTurn.id,
              deliveryOrigin: 'response',
              card: { title: 'Card title', description: 'Card content', children: [], actions: [] },
            },
          ],
          turns: [
            {
              ...testTurn,
              phase: 'settled',
              outcome: 'replied',
              outputIds: ['settled-card'],
              activity: recorded ? testTurn.activity : [],
              metadata: { status: 'final', model: 'fixture-model', durationMs: 6500 },
            },
          ],
          connection: { connected: true, activeTurnId: null },
        }),
        'thread',
      );
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const messageNode = findComponent(log.type(log.props), 'Message');
      hooks.slots = [];
      hooks.cursor = 0;
      const cardNode = messageNode.type(messageNode.props);
      const row = cardNode.type(cardNode.props);
      const [technicalBlock, title] = row.props.children;
      expect(!!technicalBlock).toBe(technical);
      if (technical) {
        expect(technicalBlock.type.name).toBe('TurnTechnicalDetails');
        const details = renderTechnicalDetails(row);
        expect(details.props.class).toBe('turn-technical-details');
        const [header, trace] = details.props.children;
        expect(header.type.name).toBe('TurnTechnicalInfo');
        expect(trace.type.name).toBe('ActivityTracePanel');
        expect(header.props.count).toBe(recorded ? 2 : 0);
        const toggle = findComponent(header.type(header.props), 'ActivityTraceToggle');
        expect(!!toggle.type(toggle.props)).toBe(recorded);
        expect(trace.props.lines.slice(recorded ? 1 : 0)).toEqual(recorded ? testTurn.activity : []);
        expect(findComponent(header.type(header.props), 'TurnElapsed')).toBeUndefined();
        expect(find(header.type(header.props), 'span', 'Model-call time')).toBeUndefined();
      }
      expect(title.props.class).toBe('display-card-title');
      const footer = row.props.children.at(-1);
      expect(findComponent(footer, 'ReplyTurnInfo')).toBeUndefined();
    },
  );

  it.each(
    [false, true].flatMap((technical) =>
      (
        [
          { outcome: 'silent', note: 'No reply' },
          { outcome: 'failed', note: null },
          { outcome: 'stopped', note: 'Stopped by user' },
          { outcome: 'warning', note: 'Ended with a warning' },
          { outcome: 'interrupted', note: 'Interrupted; outcome unknown' },
          { outcome: 'replied', note: null },
        ] as const
      ).map(({ outcome, note }) => ({ technical, outcome, note })),
    ),
  )(
    'keeps $outcome outcome only in the trace without completed footer labels ($technical)',
    ({ technical, outcome, note }) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      applyConversationFrame(
        testSnapshot({
          turns: [
            {
              ...testTurn,
              phase: 'settled',
              outcome,
              metadata: { status: 'final', model: 'fixture-model', durationMs: 6500 },
            },
          ],
          connection: { connected: true, activeTurnId: null },
        }),
        'thread',
      );
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const turnRow = findComponent(log.type(log.props), 'ResponseStatusRow');
      hooks.slots = [];
      hooks.cursor = 0;
      const row = turnRow.type(turnRow.props);
      if (!technical) {
        expect(row).toBeNull();
        return;
      }
      const footer = row.props.children.at(-1);
      expect(findComponent(footer, 'TurnElapsed')).toBeUndefined();
      expect(find(footer, 'span')).toBeUndefined();
      expect(find(row, 'span', 'Done')).toBeUndefined();
      if (technical) {
        const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
        const panel = findComponent(renderTechnicalDetails(row), 'ActivityTracePanel');
        expect(info.props.count).toBe(2);
        const toggle = findComponent(info.type(info.props), 'ActivityTraceToggle');
        expect(find(toggle.type(toggle.props), 'span', '2 traces')).toBeTruthy();
        expect(findComponent(info.type(info.props), 'UsageMeta').props.summary).not.toContain('call');
        expect(panel.props.lines).toHaveLength(note ? 3 : 2);
        if (note) expect(JSON.parse(panel.props.lines.at(-1).text).text).toBe(note);
        expect(findComponent(info.type(info.props), 'TurnElapsed')).toBeUndefined();
        expect(find(info.type(info.props), 'span', 'Model-call time')).toBeUndefined();
      } else {
        expect(renderTechnicalDetails(row)).toBeUndefined();
      }
    },
  );

  it.each(
    [false, true].flatMap((technical) =>
      (['silent', 'stopped', 'warning', 'interrupted'] as const).map((outcome) => ({ technical, outcome })),
    ),
  )('offers an outcome-only $outcome disclosure with technical information $technical', ({ technical, outcome }) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical } };
    applyConversationFrame(
      testSnapshot({
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome,
            activity: [],
            usage: [],
            startedAt: null,
            endedAt: null,
            metadata: { status: 'unavailable', model: null, durationMs: null },
          },
        ],
        connection: { connected: true, activeTurnId: null },
      }),
      'thread',
    );
    resetMount();
    hooks.cursor = 0;
    const log = findComponent(ChatMain(), 'MessageLog');
    resetMount();
    hooks.cursor = 0;
    const turnRow = findComponent(log.type(log.props), 'ResponseStatusRow');
    resetMount();
    hooks.cursor = 0;
    const row = turnRow.type(turnRow.props);
    if (!technical) {
      expect(row).toBeNull();
      return;
    }
    const details = renderTechnicalDetails(row);
    const info = findComponent(details, 'TurnTechnicalInfo');
    expect(info.props.count).toBe(0);
    expect(info.props.hasOutcome).toBe(true);
    const toggle = findComponent(info.type(info.props), 'ActivityTraceToggle');
    const button = toggle.type(toggle.props);
    expect(find(button, 'span', 'trace')).toBeTruthy();
    expect(button.props['aria-expanded']).toBe(false);
    const panel = findComponent(details, 'ActivityTracePanel');
    expect(panel.props.lines).toHaveLength(1);
    expect(panel.props.lines[0].ts).toBe('');
    expect(find(row.props.children.at(-1), 'span')).toBeUndefined();
    button.props.onClick();
    hooks.cursor = 0;
    const expanded = renderTechnicalDetails(turnRow.type(turnRow.props));
    expect(findComponent(expanded, 'ActivityTracePanel').props.expanded).toBe(true);
    expect(findComponent(expanded, 'TurnTechnicalInfo').props.count).toBe(0);
  });

  it.each([false, true])(
    'keeps dots, Stop, stopwatch and current activity in the footer with technical information %s',
    (technical) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      onTestFinished(() => clock.mockRestore());
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      applyConversationFrame(
        testSnapshot({
          turns: [{ ...testTurn, startedAt: new Date(Date.now() - 7000).toISOString() }],
          connection: { connected: true, activeTurnId: testTurn.id },
        }),
        'thread',
      );
      if (technical) closeTrace(`turn:${testTurn.id}`);
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const turnRow = findComponent(log.type(log.props), 'ResponseStatusRow');
      hooks.slots = [];
      hooks.cursor = 0;
      const row = turnRow.type(turnRow.props);
      expect(row.props.class).toContain('turn-live');
      const summary = row.props.children.at(-1);
      const controls = summary.props.children.filter(Boolean);
      expect(controls.map((node: { props: { class?: string } }) => node.props.class)).toEqual([
        'typing-dots',
        'msg-inline-actions turn-stop-inline',
        undefined,
        technical ? 'hint trace-preview' : 'hint',
      ]);
      expect(controls[0].props.children).toHaveLength(3);
      expect(controls[0].props['aria-hidden']).toBe('true');
      expect(findComponent(controls[1], 'ActiveTurnStopButton')).toBeTruthy();
      expect(controls[2].type.name).toBe('TurnElapsed');
      expect(controls[2].props.ms).toBeGreaterThanOrEqual(7000);
      const stopwatch = controls[2].type(controls[2].props);
      expect(stopwatch.props.class).toBe('turn-elapsed live');
      expect(stopwatch.props.children).toBe(formatStopwatch(controls[2].props.ms));
      expect(stopwatch.props['aria-live']).toBe('off');
      expect(controls[3].type).toBe(technical ? 'button' : 'span');
      expect(findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo') !== undefined).toBe(technical);
      if (technical) {
        const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
        expect(findComponent(info.type(info.props), 'TurnElapsed')).toBeUndefined();
        expect(find(info.type(info.props), 'span', 'Model-call time')).toBeUndefined();
      }
      hooks.slots = [];
      hooks.cursor = 0;
      const settled = turnRow.type({
        source: {
          ...turnRow.props.source,
          turn: { ...testTurn, phase: 'settled', outcome: 'silent' },
        },
      });
      expect(settled?.props.class ?? '').not.toContain('turn-live');
      if (!technical) expect(settled).toBeNull();
      else {
        const footer = settled.props.children.at(-1);
        expect(footer.props.children.filter(Boolean)).toEqual([]);
      }
    },
  );

  it.each(['submission', 'following', 'completion'] as const)(
    'positions %s rows before paint without stale bottom-follow',
    (phase) => {
      const savedGlobals = {
        window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        CSS: globalThis.CSS,
        getComputedStyle: globalThis.getComputedStyle,
      };
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      const cancel = vi.fn((id: number) => frames.delete(id));
      const responseContent = { scrollTop: 240 };
      class Viewport extends EventTarget {
        top = 1470;
        scrollHeight = 2000;
        clientHeight = 500;
        clientTop = 0;
        ownerDocument = new EventTarget();
        get scrollTop() {
          return this.top;
        }
        set scrollTop(value: number) {
          this.top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value));
        }
        getBoundingClientRect() {
          return { top: 50 };
        }
        querySelectorAll() {
          return [];
        }
        querySelector() {
          return {
            querySelector: () => responseContent,
            getBoundingClientRect: () => ({ top: 50 + 1400 - this.scrollTop }),
          };
        }
      }
      const viewport = new Viewport();
      const disposers: (() => void)[] = [];
      try {
        vi.stubGlobal('getComputedStyle', () => ({ scrollPaddingTop: '16px' }));
        vi.stubGlobal(
          'window',
          Object.assign(new EventTarget(), {
            nanoclawAppearance: { beforeDensityChange: () => () => {} },
          }),
        );
        vi.stubGlobal('CSS', { escape: (id: string) => id });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
          frames.set(++nextFrame, callback);
          return nextFrame;
        });
        vi.stubGlobal('cancelAnimationFrame', cancel);
        hooks.cursor = 0;
        const log = findComponent(ChatMain(), 'MessageLog');
        hooks.slots = [];
        hooks.effects = [];
        hooks.cursor = 0;
        hooks.capturePassive = true;
        const view = log.type(log.props);
        find(view, 'div').ref.current = viewport;
        for (const effect of hooks.effects.splice(0)) {
          const dispose = effect();
          if (dispose) disposers.push(dispose);
        }
        expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
        for (const effect of hooks.passiveEffects.splice(0)) {
          const dispose = effect();
          if (dispose) disposers.push(dispose);
        }
        const pendingTail = nextFrame;
        viewport.scrollHeight = 4500;
        if (phase === 'completion') {
          completedResponse.value = 'response';
          chatMessages.value = [{ id: 'response', direction: 'out', text: 'Long reply', ts: '2', files: null }];
        } else {
          pendingWebSends.value = [testWebSubmission];
          if (phase === 'submission') scrollToBottomTick.value++;
        }
        hooks.cursor = 0;
        log.type(log.props);
        for (const effect of hooks.effects.splice(0)) effect();
        if (phase !== 'completion') {
          expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
          return;
        }
        expect(cancel).toHaveBeenCalledWith(pendingTail);
        for (const [id, callback] of [...frames]) {
          frames.delete(id);
          callback(0);
        }
        expect(viewport.scrollTop).toBe(1384);
        expect(responseContent.scrollTop).toBe(0);
        expect(viewport.querySelector().getBoundingClientRect().top).toBe(66);
        viewport.scrollHeight = viewport.clientHeight + viewport.scrollTop + 30;
        find(view, 'div').props.onScroll();
        window.dispatchEvent(new Event('resize'));
        expect(viewport.scrollTop).toBe(1384);
        viewport.scrollTop += 1;
        find(view, 'div').props.onScroll();
        window.dispatchEvent(new Event('resize'));
        expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
      } finally {
        disposers.forEach((dispose) => dispose());
        hooks.capturePassive = false;
        for (const [key, value] of Object.entries(savedGlobals)) vi.stubGlobal(key, value);
      }
    },
  );
});

describe('inline activity metrics', () => {
  it('keeps previous panels open through submission, new data and new selections', () => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    const previous: ConversationTurn = {
      ...testTurn,
      phase: 'settled',
      outcome: 'replied',
      outputIds: ['previous-reply'],
      startedAt: '2026-09-28T00:00:00Z',
      endedAt: '2026-09-28T00:00:10Z',
      usage: [{ id: 'previous-usage', value: { cost_usd: 0.01 } }],
    };
    const reply: ConversationMessage = {
      id: 'previous-reply',
      direction: 'out',
      turnId: previous.id,
      text: 'Done',
      timestamp: '2026-09-28T00:00:10Z',
    };
    let generation = 0;
    const publish = (turns: ConversationTurn[], echoed = false) => {
      applyConversationFrame(
        testSnapshot(
          {
            messages: [
              reply,
              ...(echoed
                ? [
                    {
                      id: testWebSubmission.messageId,
                      direction: 'in' as const,
                      text: testWebSubmission.text,
                      timestamp: testWebSubmission.timestamp,
                      inputState: { messageId: testWebSubmission.messageId, status: 'queued' as const },
                    },
                  ]
                : []),
            ],
            turns,
            connection: { connected: true, activeTurnId: turns.length > 1 ? turns[1].id : null },
          },
          `render-stage-${++generation}`,
        ),
        'thread',
      );
    };
    const previousDetails = () => {
      resetMount();
      const log = findComponent(ChatMain(), 'MessageLog');
      resetMount();
      const message = findComponent(log.type(log.props), 'Message');
      resetMount();
      return renderTechnicalDetails(message.type(message.props));
    };
    const previousPanel = () => findComponent(previousDetails(), 'ActivityTracePanel');
    publish([previous]);
    const info = findComponent(previousDetails(), 'TurnTechnicalInfo');
    const controls = info.type(info.props);
    findComponent(controls, 'ActivityTraceToggle').props.onToggle();
    const usage = findComponent(controls, 'UsageMeta');
    find(usage.type(usage.props), 'button').props.onClick({ stopPropagation() {} });
    const expectPreviousContent = () => {
      const panel = previousPanel();
      expect(panel.props.expanded).toBe(true);
      expect(panel.props.metrics.props.ownerId).toBe(`turn:${previous.id}`);
      expect(panel.props.metrics.props.records[0].id).toBe('previous-usage');
      expect(findComponent(panel.type(panel.props), 'ActivityTraceList')).toBeDefined();
    };
    pendingWebSends.value = [testWebSubmission];
    expectPreviousContent();
    publish([previous], true);
    expectPreviousContent();
    const next = { ...testTurn, id: 'new-turn', activity: [], inputIds: [testWebSubmission.messageId] };
    publish([previous, next], true);
    expectPreviousContent();
    const withSteps = { ...next, activity: testTurn.activity };
    publish([previous, withSteps], true);
    expectPreviousContent();
    let current = findComponent(renderTechnicalDetails(renderResponseStatusRow()), 'ActivityTracePanel');
    expect(current.props.expanded).toBe(false);
    expect(current.props.metrics).toBeNull();
    publish([previous, { ...withSteps, usage: [{ id: 'new-usage', value: { cost_usd: 0.002 } }] }], true);
    expectPreviousContent();
    const currentDetails = renderTechnicalDetails(renderResponseStatusRow());
    const currentInfo = findComponent(currentDetails, 'TurnTechnicalInfo');
    const currentControls = currentInfo.type(currentInfo.props);
    const currentUsage = findComponent(currentControls, 'UsageMeta');
    expect(currentUsage.type(currentUsage.props).props['aria-expanded']).toBe(false);
    findComponent(currentControls, 'ActivityTraceToggle').props.onToggle();
    current = findComponent(renderTechnicalDetails(renderResponseStatusRow()), 'ActivityTracePanel');
    expect(current.props.expanded).toBe(true);
    expect(current.props.metrics).toBeNull();
    expectPreviousContent();
    find(currentUsage.type(currentUsage.props), 'button').props.onClick({ stopPropagation() {} });
    expectPreviousContent();
    current = findComponent(renderTechnicalDetails(renderResponseStatusRow()), 'ActivityTracePanel');
    expect(current.props.expanded).toBe(true);
    expect(current.props.metrics.props.ownerId).toBe(`turn:${next.id}`);
    expect(current.props.metrics.props.records[0].id).toBe('new-usage');
  });

  it.each(
    (['live', 'settled', 'reply', 'history', 'history-reply'] as const).flatMap((scene) =>
      (['closed', 'steps', 'stats', 'both'] as const).map((panels) => ({ scene, panels })),
    ),
  )(
    'pins settled disclosures and moves live ones to the next turn (scene=$scene, panels=$panels)',
    ({ scene, panels }) => {
      appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
      const live = scene === 'live';
      const historical = scene.startsWith('history');
      const reply = scene.endsWith('reply');
      const turn: ConversationTurn = {
        ...testTurn,
        phase: live ? ('running' as const) : ('settled' as const),
        outcome: 'silent',
        outputIds: reply ? ['reply'] : [],
        usage: [{ id: 'usage', value: { cost_usd: 0.01 } }],
      };
      if (live) turn.outcome = 'pending';
      else if (reply) turn.outcome = 'replied';
      const newer = { ...turn, id: 'newer-history', outputIds: [] };
      const messages: ConversationMessage[] = reply
        ? [{ id: 'reply', direction: 'out', turnId: turn.id, text: 'Done', timestamp: '2026-09-29T00:00:01Z' }]
        : [];
      const turns = historical ? [turn, newer] : [turn];
      applyConversationFrame(
        testSnapshot({
          messages,
          turns,
          connection: { connected: true, activeTurnId: live ? turn.id : null },
        }),
        'thread',
      );
      resetActivityTraceView();
      let row;
      if (reply) {
        resetMount();
        const log = findComponent(ChatMain(), 'MessageLog');
        resetMount();
        const message = findComponent(log.type(log.props), 'Message');
        resetMount();
        row = message.type(message.props);
      } else row = renderResponseStatusRow();
      const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
      const controls = info.type(info.props);
      const steps = panels === 'steps' || panels === 'both';
      const stats = panels === 'stats' || panels === 'both';
      if (steps) findComponent(controls, 'ActivityTraceToggle').props.onToggle();
      if (stats) {
        const usage = findComponent(controls, 'UsageMeta');
        find(usage.type(usage.props), 'button').props.onClick({ stopPropagation() {} });
      }
      expect(activityTraceExpanded(`turn:${turn.id}`)).toBe(steps);
      expect(activityMetricsExpanded(`turn:${turn.id}`)).toBe(stats);
      const next = { ...testTurn, id: 'turn:next', usage: [{ id: 'new-usage', value: { cost_usd: 0.002 } }] };
      applyConversationFrame(
        testSnapshot(
          {
            messages,
            turns: [...turns.map((value) => ({ ...value, phase: 'settled' as const })), next],
            connection: { connected: true, activeTurnId: next.id },
          },
          'next-turn',
        ),
        'thread',
      );
      // Panels opened on a live turn follow; untouched Steps open for the first live turn.
      const expectPanels = () => {
        expect(activityTraceExpanded(`turn:${turn.id}`)).toBe(steps && !live);
        expect(activityTraceExpanded(`turn:${next.id}`)).toBe(!steps || live);
        expect(activityMetricsExpanded(`turn:${turn.id}`)).toBe(stats && !live);
        expect(activityMetricsExpanded(`turn:${next.id}`)).toBe(stats && live);
      };
      expectPanels();
      applyConversationFrame(testSnapshot(conversationState.peek()!.conversation, 'reconnect'), 'thread');
      expectPanels();
    },
  );

  it('groups usage into outlined timing, token and model columns', () => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    const t0 = Date.parse(testTurn.startedAt!);
    const tool = (id: string, at: number, durationMs: number, ordinal: number) => ({
      ordinal,
      ts: String(t0 + at),
      timelinePosition: 100 + ordinal,
      text: JSON.stringify({ kind: 'tool', id, tool: 'bash', status: 'completed', durationMs }),
    });
    applyConversationFrame(
      testSnapshot({
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome: 'silent',
            // Parallel tools 1–3s and 2–4s cover 3s once.
            activity: [tool('a', 1000, 2000, 0), tool('b', 2000, 2000, 1)],
            metadata: { status: 'final', durationMs: 14_000, model: 'provider/MiniMax-M3' },
            usage: [
              {
                id: 'usage',
                value: {
                  cost_usd: 0,
                  input_tokens: 55_000,
                  output_tokens: 485,
                  reasoning_tokens: 50,
                  cache_read_tokens: 109_400,
                  cache_write_tokens: 0,
                  context_tokens: 55_400,
                  context_window: 1_000_000,
                  num_turns: 3,
                  duration_api_ms: 9000,
                  model: 'provider/MiniMax-M3',
                },
              },
            ],
          },
        ],
      }),
      'thread',
    );
    const row = renderResponseStatusRow();
    const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
    const usage = findComponent(info.type(info.props), 'UsageMeta');
    expect(usage.props.summary).toBe('14s · 6% ctx');
    find(usage.type(usage.props), 'button').props.onClick({ stopPropagation() {} });
    const inline = renderUsageDetails(row);
    const columns = inline.props.children[1].props.children;
    expect(columns.map((column: any) => column.props['aria-label'])).toEqual(['Timing', 'Tokens', 'Model']);
    expect(columns.every((column: any) => column.props.class === 'usage-column')).toBe(true);
    expect(['Total', 'Model', 'Tools', 'Other'].map((label) => usageRow(columns[0], label))).toEqual([
      '14s',
      '9.0s',
      '3.0s',
      '2.0s',
    ]);
    expect(usageRow(columns[1], 'Turn processing')).toBe('55.0k tok in \u00b7 485 tok out');
    expect(usageRow(columns[1], 'Reasoning')).toBe('50 tok');
    expect(usageRow(columns[1], 'Cache read')).toBe('109.4k tok');
    expect(usageRow(columns[1], 'Cache write')).toBeUndefined();
    expect(usageRow(columns[1], 'Context utilization')).toBe('55.4k tok \u00b7 6%');
    expect(usageRow(columns[2], 'Context size')).toBe('1M tok');
    expect(usageRow(columns[2], 'Model calls')).toBe('3');
    expect(usageRow(columns[2], 'Estimated cost')).toBeUndefined();
  });

  it.each(['provisional', 'partial'] as const)('only retains the partial warning for %s accounting', (accounting) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    applyConversationFrame(
      testSnapshot({
        turns: [
          {
            ...testTurn,
            metadata: { ...testTurn.metadata, status: accounting },
            usage: [
              {
                id: 'usage',
                value: {
                  cost_usd: 0.01,
                  input_tokens: 100,
                  output_tokens: 10,
                  cache_read_tokens: 0,
                  cache_write_tokens: 0,
                  model: 'model',
                },
              },
            ],
          },
        ],
        connection: { connected: true, activeTurnId: testTurn.id },
      }),
      'thread',
    );
    const row = renderResponseStatusRow();
    const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
    const usage = findComponent(info.type(info.props), 'UsageMeta');
    find(usage.type(usage.props), 'button').props.onClick({ stopPropagation() {} });
    const inline = renderUsageDetails(row);
    expect(find(inline, 'span', 'Usage reported so far; awaiting final totals.')).toBeUndefined();
    expect(!!find(inline, 'span', 'Partial usage report; final totals may be higher.')).toBe(accounting === 'partial');
  });

  it.each([false, true])('keeps metrics and trace independent (recorded activity=%s)', (recorded) => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    applyConversationFrame(
      testSnapshot({
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome: 'silent',
            activity: recorded ? testTurn.activity : [],
            metadata: { status: 'final', durationMs: 9000, model: 'model' },
            usage: [{ id: 'usage', value: { context_tokens: 3, context_window: 100 } }],
          },
        ],
      }),
      'thread',
    );
    const row = renderResponseStatusRow();
    const projection = vi.spyOn(turnRow, 'turnRowView');
    onTestFinished(() => projection.mockRestore());
    const controls = () => {
      projection.mockClear();
      const details = renderTechnicalDetails(row);
      const info = findComponent(details, 'TurnTechnicalInfo');
      const header = info.type(info.props);
      const trace = findComponent(header, 'ActivityTraceToggle');
      const usage = findComponent(header, 'UsageMeta');
      const panel = findComponent(details, 'ActivityTracePanel');
      const metrics = findComponent(panel.type(panel.props), 'UsageDetails');
      if (metrics) {
        metrics.type(metrics.props);
        expect(metrics.props.records).toBe(info.props.usage.records);
      }
      expect(projection).toHaveBeenCalledTimes(1);
      return { trace: trace.type(trace.props), usage: usage.type(usage.props), panel };
    };

    let current = controls();
    expect(current.trace.props['aria-expanded']).toBe(false);
    expect(current.usage.props['aria-expanded']).toBe(false);
    expect(current.usage.props.class).toBe('trace-toggle usage');
    expect(find(current.usage, 'span', '9.0s · 3% ctx')).toBeDefined();
    expect(current.panel.type(current.panel.props)).toBeNull();

    current.usage.props.onClick({ stopPropagation() {} });
    current = controls();
    expect(current.trace.props['aria-expanded']).toBe(false);
    expect(current.usage.props['aria-expanded']).toBe(true);
    expect(find(current.usage, 'span').props.class).toBe('chevron open');
    const inline = renderUsageDetails(row);
    expect(inline.props.id).toBe(current.usage.props['aria-controls']);
    expect(inline.props.role).toBe('group');
    expect(findComponent(current.panel.type(current.panel.props), 'ActivityTraceList')).toBeUndefined();
    expect(current.panel.type({ ...current.panel.props, lines: [] })).not.toBeNull();

    current.trace.props.onClick();
    current = controls();
    expect(current.usage.props['aria-expanded']).toBe(true);
    expect(findComponent(current.panel.type(current.panel.props), 'ActivityTraceList')).toBeDefined();
    current.usage.props.onKeyDown({ key: 'Escape' });
    current = controls();
    expect(current.trace.props['aria-expanded']).toBe(true);
    expect(current.usage.props['aria-expanded']).toBe(false);
    expect(current.panel.props.metrics).toBeNull();
    expect(findComponent(current.panel.type(current.panel.props), 'ActivityTraceList')).toBeDefined();
  });
});

describe('activity trace completion', () => {
  it.each(['count', 'summary'] as const)('opens the newest chapter through the %s toggle', (control) => {
    const turn = {
      ...testTurn,
      activity: [0, 1].map((ordinal) => ({
        ordinal,
        ts: '1000',
        timelinePosition: 100 + ordinal,
        text: JSON.stringify({
          kind: 'tool',
          tool: 'bash',
          id: `step-${ordinal}`,
          status: 'running',
          detail: 'echo test',
        }),
      })),
    };
    applyConversationFrame(
      testSnapshot({
        turns: [turn],
        connection: { connected: true, activeTurnId: turn.id },
      }),
      'thread',
    );
    resetActivityTraceView();
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    const row = renderResponseStatusRow();
    if (control === 'count') {
      const info = findComponent(renderTechnicalDetails(row), 'TurnTechnicalInfo');
      findComponent(info.type(info.props), 'ActivityTraceToggle').props.onToggle();
    } else find(row, 'button', 'Show latest activity').props.onClick();
    const panel = findComponent(renderTechnicalDetails(renderResponseStatusRow()), 'ActivityTracePanel');
    const list = findComponent(panel.type(panel.props), 'ActivityTraceList');
    resetMount();
    const [start, chapter] = traceList(ActivityTraceList(list.props)).props.children;
    expect(start.props.entry.line.text).toContain('ui:start:');
    expect(chapter.props.children[0].props.children.props['aria-expanded']).toBe(true);
    expect(
      chapter.props.children[1].props.children.every((entry: { props: { open: boolean } }) => !entry.props.open),
    ).toBe(true);
  });

  it('times only preparation on the start row: Queued has no stopwatch, Preparing ticks CPU', () => {
    const chips = (text: string, status: string, extra: object = {}) => {
      resetMount();
      const line = {
        ts: '1000',
        text: JSON.stringify({ kind: 'notification', id: 'ui:start:m', text, status, ...extra }),
      };
      const [row] = [traceList(ActivityTraceList({ lines: [line], live: true, now: 5000 })).props.children].flat();
      const collect = (node: any): any[] =>
        !node || typeof node !== 'object'
          ? []
          : typeof node.type === 'function' && node.type.name === 'TimeCell'
            ? [node]
            : [node.props?.children].flat(Infinity).flatMap(collect);
      return Object.fromEntries(collect(row.type(row.props)).map((chip) => [chip.props.kind, chip.props.time]));
    };
    expect(chips('Queued…', 'pending')).toEqual({ cpu: null, ai: null });
    expect(chips('Preparing…', 'running')).toEqual({ cpu: { since: 1000 }, ai: null });
    expect(chips('Thinking…', 'running', { durationMs: 400 })).toEqual({ cpu: { ms: 400 }, ai: null });
  });

  it('keeps the same trace and followed chapter open through outputless settlement', () => {
    appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
    const turn = {
      ...testTurn,
      activity: [0, 1].map((ordinal) => ({
        ordinal,
        ts: '1000',
        timelinePosition: 100 + ordinal,
        text: JSON.stringify({
          kind: 'tool',
          tool: 'bash',
          id: `step-${ordinal}`,
          status: 'completed',
          detail: 'echo test',
        }),
      })),
    };
    const renderDetails = () => {
      resetMount();
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      resetMount();
      hooks.cursor = 0;
      const row = findComponent(log.type(log.props), 'ResponseStatusRow');
      resetMount();
      hooks.cursor = 0;
      return renderTechnicalDetails(row.type(row.props));
    };
    applyConversationFrame(
      testSnapshot({ turns: [turn], connection: { connected: true, activeTurnId: turn.id } }),
      'thread',
    );
    // The first live turn opens its own trace.
    const live = findComponent(renderDetails(), 'ActivityTracePanel');
    expect(live.props).toMatchObject({ expanded: true, live: true, turnId: turn.id });
    const liveList = findComponent(live.type(live.props), 'ActivityTraceList');
    applyConversationFrame(
      testSnapshot(
        {
          turns: [{ ...turn, phase: 'settled', outcome: 'silent' }],
          connection: { connected: true, activeTurnId: null },
        },
        'completed-outputless',
      ),
      'thread',
    );
    const completed = findComponent(renderDetails(), 'ActivityTracePanel');
    expect(completed.props).toMatchObject({ expanded: true, live: false, turnId: null });
    const list = findComponent(completed.type(completed.props), 'ActivityTraceList');
    expect(list.key).toBe(liveList.key);
    resetMount();
    hooks.cursor = 0;
    const [start, chapter] = traceList(ActivityTraceList(list.props)).props.children;
    expect(start.props.entry.line.text).toContain('ui:start:');
    expect(chapter.props.children[0].props.children.props['aria-expanded']).toBe(true);
    expect(
      chapter.props.children[1].props.children.every((entry: { props: { open: boolean } }) => !entry.props.open),
    ).toBe(true);
  });
});

describe('activity trace chapter following', () => {
  const line = (id: string, status: 'running' | 'completed', tool = 'bash'): ActivityLine => ({
    ts: '1000',
    text: JSON.stringify({ kind: 'tool', id, status, tool, detail: `${tool}-${id}` }),
  });
  function renderTrace(lines: ActivityLine[]) {
    hooks.cursor = 0;
    const list = traceList(ActivityTraceList({ lines, live: true }));
    hooks.effects.splice(0).forEach((effect) => effect());
    return list;
  }
  beforeEach(() => {
    resetMount();
  });

  /** Header parts of a rendered row: the disclosure button, its time cells, and the Stop slot. */
  function rowParts(view: any) {
    const [header] = view.props.children;
    const [toggle, stop] = header.props.children;
    const [cpu, ai, marker, label] = toggle.props.children;
    return { toggle, stop, cpu, ai, marker, label };
  }

  it('puts both stopwatches before distinct chapter markers and keeps singleton dots', () => {
    const lines = [line('one', 'completed'), line('two', 'running')];
    let list = renderTrace(lines);
    let chapter = list.props.children[0];
    let toggle = chapter.props.children[0].props.children;
    const [cpu, ai, marker, label] = toggle.props.children;
    expect(cpu.props.kind).toBe('cpu');
    expect(ai.props.kind).toBe('ai');
    expect(marker.props.class).toBe('trace-marker');
    expect(marker.props['aria-hidden']).toBe('true');
    expect(marker.props.children.type).toBe('svg');
    expect(marker.props.children.props.class).toBe('trace-chapter-marker');
    expect(label.props.class).toBe('trace-chapter-label');
    expect(toggle.props['aria-expanded']).toBe(true);
    expect(chapter.props.class).toContain(' open');
    toggle.props.onClick();
    list = renderTrace(lines);
    chapter = list.props.children[0];
    toggle = chapter.props.children[0].props.children;
    expect(toggle.props['aria-expanded']).toBe(false);
    expect(chapter.props.class).not.toContain(' open');
    expect(toggle.props.children[2].props.children.props.class).toBe('trace-chapter-marker');

    list = renderTrace([line('single', 'completed')]);
    const entry = findComponent(list, 'ActivityTraceRow');
    const row = rowParts(entry.type(entry.props));
    expect(row.cpu.props.kind).toBe('cpu');
    expect(row.ai.props.kind).toBe('ai');
    expect(row.marker.props.children.type).toBe('span');
    expect(row.marker.props.children.props.class).toBe('trace-dot');
    expect(row.label.props.class).toBe('trace-text');
  });

  it('renders Stop as the timeline node, outside the disclosure button', () => {
    const list = ActivityTraceList({ lines: [line('one', 'running')], live: true, now: 65_000, turnId: 'owning-turn' });
    const row = findComponent(list, 'ActivityTraceRow');
    expect(row.props.turnId).toBe('owning-turn');
    for (const open of [false, true]) {
      const { toggle, stop, cpu, ai } = rowParts(row.type({ ...row.props, open }));
      expect(toggle.props.class).toBe('trace-row-toggle');
      expect(toggle.props['aria-expanded']).toBe(open);
      expect(findComponent(toggle, 'ToolStopButton')).toBeUndefined();
      expect(stop.props.class).toBe('trace-stop');
      expect(stop.props.children.type).toBe(ToolStopButton);
      expect(stop.props.children.props).toMatchObject({ turnId: 'owning-turn', toolCallId: 'one' });
      expect(cpu.props).toEqual({ kind: 'cpu', time: { since: 1000 } });
      const cell = cpu.type(cpu.props);
      expect(cell.props).toMatchObject({ class: 'trace-time trace-time-cpu', title: 'Execution time' });
      expect(cell.props.children.props).toEqual({ since: 1000 });
      expect(ai.props.time).toBeNull();
      expect(ai.type(ai.props).props.children).toBeNull();
    }
  });

  it('scrolls the whole table without column headers', () => {
    const table = ActivityTraceList({
      lines: [{ ...line('one', 'running'), modelTime: { ms: 1200 } }],
      live: true,
      now: 65_000,
    });
    expect(table.props.class).toBe('trace-table scroll-edge-fade');
    expect([table.props.children].flat().filter(Boolean)).toHaveLength(1);
    expect(traceList(table).props).toMatchObject({
      class: 'activity-trace',
      tabIndex: 0,
      'aria-label': 'Activity steps',
    });
  });

  it('shows the live stopwatch at once but hides Stop until a running step passes one second', () => {
    const list = ActivityTraceList({ lines: [line('one', 'running')], live: true, now: 1900, turnId: 'owning-turn' });
    const row = findComponent(list, 'ActivityTraceRow');
    const { stop, cpu } = rowParts(row.type(row.props));
    expect(stop).toBeNull();
    expect(cpu.props.time).toEqual({ since: 1000 });
  });

  it('shows sub-second model times but hides zero on finished steps', () => {
    const cell = (modelTime: ActivityLine['modelTime']) => {
      resetMount();
      const list = ActivityTraceList({ lines: [{ ...line('one', 'completed'), modelTime }], live: true });
      const found = findComponent(list, 'ActivityTraceRow');
      return rowParts(found.type(found.props)).ai;
    };
    const live = cell({ ms: 2000, since: 5000 });
    expect(live.props).toEqual({ kind: 'ai', time: { since: 3000 } });
    expect(live.type(live.props).props.title).toBe('Model time');
    expect(cell({ ms: 900 }).props.time).toEqual({ ms: 900 });
    expect(cell(undefined).props.time).toBeNull();
    expect(cell({ ms: 50 }).props.time).toBeNull();
    const done = cell({ ms: 12_500 });
    expect(done.type(done.props).props.children).toBe('12s');
  });

  it('passes the authoritative response ID to every chapter child', () => {
    const list = ActivityTraceList({
      lines: [line('one', 'completed'), line('two', 'running')],
      live: true,
      now: 65_000,
      turnId: 'owning-turn',
    });
    const children = traceList(list).props.children[0].props.children[1].props.children;
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.props.turnId).toBe('owning-turn');
  });

  it('renders prepared singletons, compact chapter children and legacy details without reparsing', () => {
    for (const lines of [
      [line('one', 'completed')],
      [line('one', 'completed'), line('two', 'running')],
      [{ ts: '1000', text: 'Legacy activity <literal>' }],
    ]) {
      resetMount();
      const row = findComponent(ActivityTraceList({ lines, live: true }), 'ActivityTraceRow');
      const parse = vi.spyOn(JSON, 'parse');
      try {
        const view = row.type({ ...row.props, open: true });
        expect(parse).not.toHaveBeenCalled();
        expect(findComponent(view, 'StepHeadlineContent').props.headline).toBe(row.props.entry.headline);
        expect(find(view, 'pre').props.children.props.children).toBe(
          row.props.entry.raw ? row.props.entry.line.text : stepBody(row.props.entry.step),
        );
      } finally {
        parse.mockRestore();
      }
    }
  });

  it('formats expanded bodies only when their own row is opened', () => {
    const list = ActivityTraceList({ lines: [line('one', 'completed'), line('two', 'completed')], live: true });
    const children = traceList(list).props.children[0].props.children[1].props.children;
    const descriptions = children.map((row: { props: { entry: { step: object } } }) => {
      const read = vi.fn(() => 'Expanded description');
      Object.defineProperty(row.props.entry.step, 'description', { get: read });
      return read;
    });
    for (const row of children) row.type({ ...row.props, open: false });
    for (const read of descriptions) expect(read).not.toHaveBeenCalled();
    const first = children[0];
    expect(find(first.type({ ...first.props, open: true }), 'pre').props.children.props.children).toContain(
      'Expanded description',
    );
    expect(descriptions[0]).toHaveBeenCalledOnce();
    expect(descriptions[1]).not.toHaveBeenCalled();
  });

  const timed = (id: string, ts: string, status: 'running' | 'completed', durationMs?: number): ActivityLine => ({
    ts,
    text: JSON.stringify({ kind: 'tool', id, tool: 'bash', status, durationMs }),
  });
  function chapterTimeCells(lines: ActivityLine[], live = true) {
    resetMount();
    const group = traceList(ActivityTraceList({ lines, live })).props.children[0];
    const [cpu, ai] = group.props.children[0].props.children.props.children;
    return { cpu: cpu.props.time, ai: ai.props.time };
  }

  it('counts overlapping completed commands once, including nested and out-of-order intervals', () => {
    expect(
      chapterTimeCells([timed('a', '1000', 'completed', 3000), timed('b', '2000', 'completed', 3000)]).cpu,
    ).toEqual({ ms: 4000 });
    expect(
      chapterTimeCells([timed('a', '1000', 'completed', 4000), timed('b', '2000', 'completed', 1000)]).cpu,
    ).toEqual({ ms: 4000 });
    expect(
      chapterTimeCells([timed('b', '2000', 'completed', 3000), timed('a', '1000', 'completed', 3000)]).cpu,
    ).toEqual({ ms: 4000 });
  });

  it('keeps live chapter time continuous when a parallel command finishes', () => {
    expect(chapterTimeCells([timed('a', '1000', 'running'), timed('b', '2000', 'running')]).cpu).toEqual({
      since: 1000,
    });
    expect(chapterTimeCells([timed('a', '1000', 'completed', 3000), timed('b', '2000', 'running')]).cpu).toEqual({
      since: 1000,
    });
    expect(chapterTimeCells([timed('a', '1000', 'running'), timed('b', '2000', 'completed', 3000)]).cpu).toEqual({
      since: 1000,
    });
  });

  it('excludes idle gaps and preserves reported durations without usable timestamps', () => {
    expect(
      chapterTimeCells([timed('a', '1000', 'completed', 1000), timed('b', '4000', 'completed', 2000)]).cpu,
    ).toEqual({ ms: 3000 });
    expect(chapterTimeCells([timed('a', '1000', 'completed', 1000), timed('b', '4000', 'running')]).cpu).toEqual({
      since: 3000,
    });
    for (const ts of ['', ' \n', 'unknown']) {
      expect(chapterTimeCells([timed('a', ts, 'completed', 1000), timed('b', '1000', 'completed', 2000)]).cpu).toEqual({
        ms: 3000,
      });
    }
    expect(chapterTimeCells([timed('a', '1000', 'running'), timed('b', '2000', 'running')], false).cpu).toBeNull();
  });

  it('leaves chapter model-time sums and live tails unchanged', () => {
    const first = { ...timed('a', '1000', 'completed', 3000), modelTime: { ms: 900 } };
    const second = { ...timed('b', '2000', 'completed', 3000), modelTime: { ms: 1200 } };
    expect(chapterTimeCells([first, second])).toEqual({ cpu: { ms: 4000 }, ai: { ms: 2100 } });
    expect(chapterTimeCells([first, { ...second, modelTime: { ms: 1200, since: 5000 } }]).ai).toEqual({ since: 2900 });
  });

  it('keeps recorded durations on expanded completed rows without Stop or a live timer', () => {
    const completed = {
      ts: '1000',
      text: JSON.stringify({
        kind: 'tool',
        id: 'one',
        tool: 'bash',
        status: 'completed',
        durationMs: 2200,
        detail: 'echo done',
      }),
    };
    const list = ActivityTraceList({ lines: [completed], live: false, now: 65_000, turnId: 'old-turn' });
    const row = findComponent(list, 'ActivityTraceRow');
    const view = row.type({ ...row.props, open: true });
    expect(findComponent(view, 'ToolStopButton')).toBeUndefined();
    const { cpu } = rowParts(view);
    expect(cpu.type(cpu.props).props.children).toBe('2.2s');
  });

  it('does not invent a live duration or a stoppable turn for legacy unfinished activity', () => {
    const unfinished = { ...line('one', 'running'), ts: '' };
    const list = ActivityTraceList({ lines: [unfinished], live: true, now: 65_000 });
    const row = findComponent(list, 'ActivityTraceRow');
    const view = row.type(row.props);
    expect(findComponent(view, 'ToolStopButton')).toBeUndefined();
    const { stop, cpu } = rowParts(view);
    expect(stop).toBeNull();
    expect(cpu.props.time).toBeNull();
  });

  it.each([' ', 'unknown'])('shows no timer or Stop for a running call with timestamp %j', (ts) => {
    const unfinished = { ...line('one', 'running'), ts };
    const list = ActivityTraceList({ lines: [unfinished], live: true, now: 65_000, turnId: 'turn' });
    const row = findComponent(list, 'ActivityTraceRow');
    const { stop, cpu } = rowParts(row.type({ ...row.props, open: true }));
    expect(stop).toBeNull();
    expect(cpu.props.time).toBeNull();
  });

  it('follows singleton and chapter headers without automatically expanding step details', () => {
    const singleton = renderTrace([line('one', 'running')]);
    expect(findComponent(singleton, 'ActivityTraceRow').props.open).toBe(false);
    const chapter = renderTrace([line('one', 'completed'), line('two', 'running')]).props.children[0];
    expect(chapter.props.children[0].props.children.props['aria-expanded']).toBe(true);
    expect(
      chapter.props.children[1].props.children.every((entry: { props: { open: boolean } }) => !entry.props.open),
    ).toBe(true);
  });

  it('keeps a completed chapter open, continues it for related steps and closes it only for a new chapter', () => {
    const initial = renderTrace([line('one', 'completed'), line('two', 'running')]).props.children[0];
    const completed = renderTrace([line('one', 'completed'), line('two', 'completed')]).props.children[0];
    expect(completed.key).toBe(initial.key);
    expect(completed.props.children[0].props.children.props['aria-expanded']).toBe(true);
    const commands = [line('one', 'completed'), line('two', 'completed'), line('three', 'running')];
    const continued = renderTrace(commands).props.children[0];
    expect(continued.key).toBe(initial.key);
    expect(continued.props.children[0].props.children.props['aria-expanded']).toBe(true);
    expect(continued.props.children[1].props.children).toHaveLength(3);
    const switched = renderTrace([...commands, line('read-one', 'running', 'read')]);
    expect(switched.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(false);
    expect(findComponent(switched.props.children[1], 'ActivityTraceRow').props.open).toBe(false);
    const next = renderTrace([...commands, line('read-one', 'completed', 'read'), line('read-two', 'running', 'read')]);
    expect(next.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(false);
    expect(next.props.children[1].props.children[0].props.children.props['aria-expanded']).toBe(true);
  });

  it('allows explicitly opening latest details but does not expand the next step automatically', () => {
    const commands = [line('one', 'completed'), line('two', 'running')];
    let list = renderTrace(commands);
    list.props.children[0].props.children[1].props.children[1].props.onToggle();
    list = renderTrace(commands);
    expect(list.props.children[0].props.children[1].props.children[1].props.open).toBe(true);
    list = renderTrace([commands[0], line('two', 'completed')]);
    expect(list.props.children[0].props.children[1].props.children[1].props.open).toBe(true);
    list = renderTrace([...commands, line('three', 'running')]);
    expect(
      list.props.children[0].props.children[1].props.children.every(
        (entry: { props: { open: boolean } }) => !entry.props.open,
      ),
    ).toBe(true);
  });

  it('respects manual chapter collapse until the next step arrives', () => {
    const commands = [line('one', 'completed'), line('two', 'running')];
    let list = renderTrace(commands);
    expect(list.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(true);
    list.props.children[0].props.children[0].props.children.props.onClick();
    list = renderTrace(commands);
    expect(list.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(false);
    list = renderTrace([...commands, line('three', 'running')]);
    expect(list.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(true);
  });

  it('respects older chapter and detail selection until a new step advances the latest chapter', () => {
    const commands = [line('one', 'completed'), line('two', 'completed')];
    const lines = [...commands, line('read-one', 'completed', 'read'), line('read-two', 'running', 'read')];
    let list = renderTrace(lines);
    expect(list.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(false);
    expect(list.props.children[1].props.children[0].props.children.props['aria-expanded']).toBe(true);
    list.props.children[0].props.children[0].props.children.props.onClick();
    list = renderTrace(lines);
    expect(list.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(true);
    expect(list.props.children[1].props.children[0].props.children.props['aria-expanded']).toBe(false);
    list.props.children[0].props.children[1].props.children[0].props.onToggle();
    list = renderTrace(lines);
    expect(list.props.children[0].props.children[1].props.children[0].props.open).toBe(true);
    list = renderTrace([...lines, line('read-three', 'running', 'read')]);
    expect(list.props.children[0].props.children[0].props.children.props['aria-expanded']).toBe(false);
    expect(list.props.children[1].props.children[0].props.children.props['aria-expanded']).toBe(true);
    expect(
      list.props.children[1].props.children[1].props.children.every(
        (entry: { props: { open: boolean } }) => !entry.props.open,
      ),
    ).toBe(true);
  });
});
