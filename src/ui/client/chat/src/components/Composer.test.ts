import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, ChatMain, InputDock } from './ChatMain';
import { QuestionPrompt } from './QuestionPrompt';
import { ComposerInput } from './ComposerInput';
import { QuestionAnswerBubble } from './QuestionAnswerBubble';
import { PendingMessageActions } from './PendingMessageActions';
import {
  activeTurn,
  turnConnected,
  groupId,
  threadId,
  threads,
  channelType,
  messagingGroupId,
  chatMessages,
  pending,
  canSend,
  chatReady,
  chatReloadRequired,
  isMobile,
  pendingQuestions,
  pinnedContext,
  voiceInput,
} from '../state';
import { composerSendInFlight, currentPendingEditor, pendingEditorSessions, openPendingEditor } from '../pending-edit';
import { pendingComposerBackups } from '../pending-composer';
import { cancelledInputs, confirmCancelledInput, PendingCancellation, pendingCancellations } from '../pending-cancel';
import { respondQuestion, sendChat, skipQuestion } from '../actions';
import type { ChatMessage, PendingQuestionDto, Thread } from '../types';
import { applyConversationFrame, completedResponse, resetConversation } from '../conversation-state';
import { testSnapshot, testTurn } from '../conversation-test-fixtures';
import { appearance } from '../appearance-state';
import { DEFAULT_APPEARANCE } from '../appearance';
import { voice } from '../voice-audio';

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
    hooks.slots[index] ??= { value: initial };
    return [
      hooks.slots[index].value,
      (value: unknown) => {
        hooks.slots[index].value = value;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (hooks.capturePassive) hooks.passiveEffects.push(effect);
  },
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    if (!hooks.slots[index] || deps.some((value, i) => value !== hooks.slots[index][i])) {
      hooks.slots[index] = deps;
      hooks.effects.push(effect);
    }
  },
}));
vi.mock('../actions', () => ({
  sendChat: vi.fn(),
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
  render();
});

describe('main composer pending edits', () => {
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
    expect(find(chat, 'div').props.id).toBe('chat-status');
    expect(find(chat, 'div').props.hidden).toBe(true);
    chatReloadRequired.value = false;
    channelType.value = 'slack';
    expect(banner().props.children).toEqual(['Read-only view — reply on ', 'Slack', ' to continue this thread.']);
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
    title: 'Choice',
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
      expect(bubble.props.children[2].props.children).toBe('Question skipped');
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
    expect(find(actions, 'button', 'Cancel').props.disabled).toBe(true);
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
    const logContents = [logNode.props.children[0].props.children].flat(Infinity);
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
    const messages = [logNode.props.children[0].props.children]
      .flat(Infinity)
      .filter((node: any) => node?.type?.name === 'Message');

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
    'places Stop between the bouncing dots and label with technical information %s',
    (technical) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      applyConversationFrame(
        testSnapshot({
          turns: [testTurn],
          connection: { connected: true, activeTurnId: testTurn.id },
        }),
        'thread',
      );
      hooks.slots = [];
      hooks.cursor = 0;
      const log = findComponent(ChatMain(), 'MessageLog');
      hooks.slots = [];
      hooks.cursor = 0;
      const turnRow = findComponent(log.type(log.props), 'ConversationTurnRow');
      hooks.slots = [];
      hooks.cursor = 0;
      const row = turnRow.type(turnRow.props);
      expect(row.props.class).toContain('turn-live');
      const summary = row.props.children[0];
      const controls = summary.props.children.filter(Boolean);
      expect(controls.map((node: any) => node.props.class)).toEqual([
        'typing-dots',
        'msg-inline-actions turn-stop-inline',
        technical ? 'hint trace-preview' : 'hint',
      ]);
      expect(controls[0].props.children).toHaveLength(3);
      expect(controls[0].props['aria-hidden']).toBe('true');
      expect(findComponent(controls[1], 'ActiveTurnStopButton')).toBeTruthy();
      expect(controls[2].type).toBe(technical ? 'button' : 'span');
      hooks.slots = [];
      hooks.cursor = 0;
      const settled = turnRow.type({ ...turnRow.props, turn: { ...testTurn, phase: 'settled', outcome: 'silent' } });
      expect(settled?.props.class ?? '').not.toContain('turn-live');
    },
  );

  it.each(['reaching the top', 'new user scrolling', 'the Down button'])(
    'protects Up jumps from bottom-follow and resumes normal following after %s',
    (resume) => {
      const savedGlobals = {
        window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        WheelEvent: globalThis.WheelEvent,
      };
      const fakeWindow = Object.assign(new EventTarget(), {
        nanoclawAppearance: { beforeDensityChange: () => () => {} },
      });
      class Viewport extends EventTarget {
        scrollHeight = 2000;
        clientHeight = 500;
        ownerDocument = new EventTarget();
        top = 1470;
        get scrollTop() {
          return this.top;
        }
        set scrollTop(value: number) {
          this.top = Math.max(0, Math.min(1500, value));
        }
        scrollTo = vi.fn<(options: ScrollToOptions) => void>();
        querySelectorAll() {
          return [];
        }
      }
      class Wheel extends Event {
        deltaY = 100;
        ctrlKey = false;
        constructor() {
          super('wheel');
        }
      }
      const el = new Viewport();
      const disposers: (() => void)[] = [];
      try {
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('requestAnimationFrame', () => 0);
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('WheelEvent', Wheel);
        hooks.cursor = 0;
        const chat = ChatMain();
        const log = findComponent(chat, 'MessageLog');
        hooks.slots = [];
        hooks.effects = [];
        hooks.cursor = 0;
        hooks.capturePassive = true;
        const view = log.type(log.props);
        const logNode = view.props.children[0];
        logNode.ref.current = el;
        for (const effect of [...hooks.effects.splice(0), ...hooks.passiveEffects.splice(0)]) {
          const dispose = effect();
          if (dispose) disposers.push(dispose);
        }
        el.scrollTop = 1470;
        logNode.props.onScroll();
        const controls = findComponent(view, 'ScrollNavigationButtons');
        controls.props.onTop();
        expect(el.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
        el.scrollTop = 1465;
        logNode.props.onScroll();
        fakeWindow.dispatchEvent(new Event('resize'));
        expect(el.scrollTop).toBe(1465);
        if (resume === 'reaching the top') {
          el.scrollTop = 0;
          logNode.props.onScroll();
        } else if (resume === 'new user scrolling') {
          el.dispatchEvent(new Wheel());
        } else {
          controls.props.onBottom();
        }
        el.scrollTop = 1490;
        logNode.props.onScroll();
        fakeWindow.dispatchEvent(new Event('resize'));
        expect(el.scrollTop).toBe(1500);
      } finally {
        disposers.forEach((dispose) => dispose());
        hooks.capturePassive = false;
        for (const [key, value] of Object.entries(savedGlobals)) vi.stubGlobal(key, value);
      }
    },
  );

  it('cancels pending bottom-follow when revealing the top of a completed response', () => {
    const savedGlobals = {
      window,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      CSS: globalThis.CSS,
    };
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const cancel = vi.fn((id: number) => frames.delete(id));
    class Viewport extends EventTarget {
      scrollTop = 1470;
      scrollHeight = 2000;
      clientHeight = 500;
      clientTop = 0;
      ownerDocument = new EventTarget();
      getBoundingClientRect() {
        return { top: 50 };
      }
      querySelectorAll() {
        return [];
      }
      querySelector() {
        return { getBoundingClientRect: () => ({ top: 50 + 1400 - this.scrollTop }) };
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
      view.props.children[0].ref.current = viewport;
      for (const effect of [...hooks.effects.splice(0), ...hooks.passiveEffects.splice(0)]) {
        const dispose = effect();
        if (dispose) disposers.push(dispose);
      }
      const pendingTail = nextFrame;
      viewport.scrollHeight = 4500;
      completedResponse.value = 'response';
      chatMessages.value = [{ id: 'response', direction: 'out', text: 'Long reply', ts: '2', files: null }];
      hooks.cursor = 0;
      log.type(log.props);
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.passiveEffects.splice(0).at(-1)?.();
      expect(cancel).toHaveBeenCalledWith(pendingTail);
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(0);
      }
      expect(viewport.scrollTop).toBe(1400);
      expect(viewport.querySelector().getBoundingClientRect().top).toBe(50);
    } finally {
      disposers.forEach((dispose) => dispose());
      hooks.capturePassive = false;
      for (const [key, value] of Object.entries(savedGlobals)) vi.stubGlobal(key, value);
    }
  });
});
