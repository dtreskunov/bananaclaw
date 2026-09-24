import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertVoiceText, replaceSegment, VoiceController, type VoiceCapture, type VoiceTarget } from './voice';

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
let controllers: VoiceController[];

function setup(draft = 'typed draft') {
  let text = draft;
  let current = true;
  let emitChunk: (chunk: ArrayBuffer) => void = () => {};
  const sockets: FakeSocket[] = [];
  const capture = { stop: vi.fn(async () => {}), cancel: vi.fn() };
  const deps = {
    socket: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    }),
    capture: vi.fn(async (onChunk: (chunk: ArrayBuffer) => void): Promise<VoiceCapture> => {
      emitChunk = onChunk;
      return capture;
    }),
    origin: () => 'https://chat.example',
  };
  const controller = new VoiceController(deps);
  controllers.push(controller);
  const target: VoiceTarget = {
    key: 'g:t:composer',
    groupId: 'a/b',
    threadId: 't:1',
    getText: () => text,
    setText: (value) => {
      text = value;
    },
    isCurrent: () => current,
    send: vi.fn(async () => {
      text = '';
      return true;
    }),
  };
  return {
    controller,
    target,
    sockets,
    deps,
    capture,
    text: () => text,
    edit: (value: string) => {
      text = value;
    },
    navigate: () => {
      current = false;
    },
    chunk: (chunk: ArrayBuffer) => emitChunk(chunk),
    ready: async () => {
      sockets.at(-1)!.receive({ type: 'ready' });
      await flush();
    },
    transcript: (text: string, final = false, sequence = 1, id = 'segment') =>
      sockets.at(-1)!.receive({ type: 'transcript', id, sequence, text, final }),
    finished: async () => {
      sockets.at(-1)!.receive({ type: 'finished' });
      await flush();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  controllers = [];
});
afterEach(() => {
  controllers.forEach((controller) => controller.detach());
  vi.useRealTimers();
});

describe('voice segment reducer', () => {
  it('replaces interim revisions instead of appending; ignores stale or nonfinal regressions', () => {
    const first = [{ id: 'a', sequence: 1, text: 'hel', final: false }];
    const revised = replaceSegment(first, { id: 'a', sequence: 2, text: 'hello', final: true });
    expect(revised).toEqual([{ id: 'a', sequence: 2, text: 'hello', final: true }]);
    expect(replaceSegment(revised, first[0])).toBe(revised);
    expect(replaceSegment(revised, { ...first[0], sequence: 3 })).toBe(revised);
    expect(replaceSegment(revised, { id: 'b', sequence: 3, text: 'world', final: false })).toHaveLength(2);
  });

  it('protects user text on both sides of an insertion', () => {
    expect(insertVoiceText('before', 'dictated', 'after')).toBe('before dictated after');
    expect(insertVoiceText('before ', '', 'after')).toBe('before after');
    expect(insertVoiceText('', 'hello', '')).toBe('hello');
  });
});

describe('voice lifecycle', () => {
  it('locks non-web channel and messaging-group context into the authorized websocket URL', () => {
    const h = setup();
    h.controller.start({ ...h.target, channelType: 'telegram', messagingGroupId: 'telegram:-123/topic' });
    expect(h.deps.socket).toHaveBeenCalledWith(
      'wss://chat.example/ui/chat/api/groups/a%2Fb/chat/t%3A1/voice/stream?channel=telegram&mg=telegram%3A-123%2Ftopic',
    );
  });

  it('does not add channel routing overrides for web chats', () => {
    const h = setup();
    h.controller.start({ ...h.target, channelType: 'web', messagingGroupId: 'web:g' });
    expect(h.deps.socket).toHaveBeenCalledWith('wss://chat.example/ui/chat/api/groups/a%2Fb/chat/t%3A1/voice/stream');
  });

  it('waits for ready before acquiring the microphone and caps PCM messages at 32KB', async () => {
    const h = setup();
    h.controller.start(h.target);
    expect(h.controller.state.value.phase).toBe('connecting');
    expect(h.deps.capture).not.toHaveBeenCalled();
    expect(h.deps.socket).toHaveBeenCalledWith('wss://chat.example/ui/chat/api/groups/a%2Fb/chat/t%3A1/voice/stream');
    await h.ready();
    h.chunk(new ArrayBuffer(70000));
    expect(h.sockets[0].send.mock.calls.map(([data]) => data.byteLength)).toEqual([32768, 32768, 4464]);
    vi.advanceTimersByTime(1250);
    expect(h.controller.state.value.elapsedMs).toBe(1250);
  });

  it('inserts at the caret, displays revisions, and sends exactly once only after provider EOF', async () => {
    const h = setup('before after');
    h.controller.start(h.target, 7);
    await h.ready();
    h.transcript('hel');
    expect(h.text()).toBe('before hel after');
    h.transcript('hello world', false, 2);
    expect(h.text()).toBe('before hello world after');
    h.controller.send();
    h.controller.send();
    expect(h.controller.state.value.phase).toBe('finalizing');
    expect(h.target.send).not.toHaveBeenCalled();
    await flush();
    expect(h.capture.stop).toHaveBeenCalledOnce();
    expect(h.sockets[0].send).toHaveBeenCalledWith('{"type":"finish"}');
    h.transcript('Hello world.', true, 3);
    expect(h.target.send).not.toHaveBeenCalled();
    await h.finished();
    await h.finished();
    expect(h.target.send).toHaveBeenCalledOnce();
    expect(h.controller.state.value.phase).toBe('idle');
    expect(h.text()).toBe('');
  });

  it('stops before editing and starts fresh dictation at the edited caret', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('first', true);
    h.controller.stop();
    await flush();
    await h.finished();
    expect(h.target.send).not.toHaveBeenCalled();
    expect(h.controller.state.value.phase).toBe('idle');
    h.edit('edited draft');
    h.controller.start(h.target, 7);
    await h.ready();
    h.transcript('second', true);
    expect(h.text()).toBe('edited second draft');
    h.controller.stop();
    await flush();
    await h.finished();
    expect(h.text()).toBe('edited second draft');
    expect(h.controller.state.value.phase).toBe('idle');
    expect(h.capture.stop).toHaveBeenCalledTimes(2);
  });

  it('the stopwatch finalizes and keeps text without sending', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('dictated', true);
    h.controller.stop();
    await flush();
    await h.finished();
    expect(h.text()).toBe('typed draft dictated');
    expect(h.controller.state.value.phase).toBe('idle');
    expect(h.target.send).not.toHaveBeenCalled();
  });

  it('stopping a silent recording returns to the microphone without changing the draft', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.controller.stop();
    await flush();
    await h.finished();
    expect(h.controller.state.value.phase).toBe('idle');
    expect(h.text()).toBe('typed draft');
    expect(h.target.send).not.toHaveBeenCalled();
  });

  it('cancels connecting without acquiring the microphone or losing text', () => {
    const h = setup();
    h.controller.start(h.target);
    const staleMessage = h.sockets[0].onmessage!;
    h.controller.stop();
    staleMessage({ data: '{"type":"ready"}' });
    expect(h.controller.state.value.phase).toBe('idle');
    expect(h.deps.capture).not.toHaveBeenCalled();
    expect(h.text()).toBe('typed draft');
    expect(h.sockets[0].close).toHaveBeenCalledOnce();
  });

  it.each(['send', 'stop'] as const)('%s waits for residual AudioWorklet PCM before sending finish', async (intent) => {
    const h = setup();
    let flushed!: () => void;
    h.capture.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          flushed = resolve;
        }),
    );
    h.controller.start(h.target);
    await h.ready();
    h.transcript('final', true);
    h.controller[intent]();
    await flush();
    expect(h.sockets[0].send).not.toHaveBeenCalled();
    const residual = new ArrayBuffer(100);
    h.chunk(residual);
    flushed();
    await flush();
    expect(h.sockets[0].send.mock.calls.map(([data]) => (typeof data === 'string' ? data : data.byteLength))).toEqual([
      100,
      '{"type":"finish"}',
    ]);
    expect(h.target.send).not.toHaveBeenCalled();
    await h.finished();
    expect(h.target.send).toHaveBeenCalledTimes(intent === 'send' ? 1 : 0);
  });

  it('accepts EOF with complete text and an empty provisional placeholder', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('final text', true);
    h.transcript('', false, 2, 'empty-placeholder');
    h.controller.stop();
    await flush();
    await h.finished();
    expect(h.controller.state.value.phase).toBe('idle');
    expect(h.text()).toBe('typed draft final text');
  });

  it('rejects EOF when any nonblank segment still lacks its provider final', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('unconfirmed');
    h.controller.send();
    await flush();
    await h.finished();
    expect(h.controller.state.value.phase).toBe('error');
    expect(h.text()).toBe('typed draft unconfirmed');
    expect(h.target.send).not.toHaveBeenCalled();
  });

  it('never sends empty or incomplete transcripts even if the server claims finished', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.controller.send();
    await flush();
    await h.finished();
    expect(h.controller.state.value.phase).toBe('error');
    expect(h.target.send).not.toHaveBeenCalled();
    expect(h.text()).toBe('typed draft');
  });

  it('finalization timeout preserves editable partials and cancels Send until pressed again', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('partial');
    h.controller.send();
    await flush();
    vi.advanceTimersByTime(20001);
    expect(h.controller.state.value.phase).toBe('error');
    expect(h.text()).toBe('typed draft partial');
    expect(h.target.send).not.toHaveBeenCalled();
    h.edit('reviewed text');
    h.controller.send();
    await flush();
    expect(h.target.send).toHaveBeenCalledOnce();
  });

  it('provider errors preserve text without turning queued Send into success', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('current partial');
    h.controller.send();
    await flush();
    h.sockets[0].receive({ type: 'error', code: 'upstream', message: 'Provider unavailable' });
    expect(h.controller.state.value.error).toBe('Provider unavailable');
    expect(h.text()).toBe('typed draft current partial');
    expect(h.target.send).not.toHaveBeenCalled();
  });

  it('visibility interruption cancels input and queued Send; never automatically resumes', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.transcript('partial');
    h.controller.send();
    h.controller.interrupt();
    await flush();
    expect(h.capture.cancel).toHaveBeenCalled();
    expect(h.sockets[0].send).toHaveBeenCalledWith('{"type":"cancel"}');
    expect(h.target.send).not.toHaveBeenCalled();
    expect(h.controller.state.value.phase).toBe('error');
    expect(h.deps.socket).toHaveBeenCalledOnce();
  });

  it('navigation and unmount ignore late callbacks, including permission resolution', async () => {
    const h = setup();
    let resolve!: (capture: VoiceCapture) => void;
    h.deps.capture.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.controller.start(h.target);
    await h.ready();
    const staleMessage = h.sockets[0].onmessage!;
    h.navigate();
    h.controller.detach();
    resolve(h.capture);
    await flush();
    staleMessage({ data: JSON.stringify({ type: 'transcript', id: 'x', sequence: 9, text: 'late', final: true }) });
    expect(h.capture.cancel).toHaveBeenCalledOnce();
    expect(h.text()).toBe('typed draft');
    expect(h.target.send).not.toHaveBeenCalled();
    expect(h.controller.state.value.phase).toBe('idle');
  });

  it('locks the target against a concurrent question and rejects stale events after restarting', async () => {
    const h = setup();
    h.controller.start(h.target);
    h.controller.start({ ...h.target, key: 'question' });
    expect(h.controller.state.value.target).toBe(h.target.key);
    await h.ready();
    const staleMessage = h.sockets[0].onmessage!;
    h.transcript('first', true);
    h.controller.stop();
    await flush();
    await h.finished();
    h.controller.start(h.target);
    await h.ready();
    staleMessage({ data: JSON.stringify({ type: 'error', message: 'old error' }) });
    expect(h.controller.state.value.phase).toBe('listening');
    h.transcript('new');
    expect(h.text()).toBe('typed draft first new');
  });

  it('retains draft after send failure and prevents concurrent HTTP sends', async () => {
    const h = setup();
    let resolve!: (sent: boolean) => void;
    h.target.send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    );
    h.controller.start(h.target);
    await h.ready();
    h.transcript('final', true);
    h.controller.send();
    await flush();
    await h.finished();
    h.controller.send();
    h.controller.stop();
    expect(h.target.send).toHaveBeenCalledOnce();
    resolve(false);
    await flush();
    expect(h.text()).toBe('typed draft final');
    expect(h.controller.state.value.sending).toBe(false);
    expect(h.controller.state.value.error).toContain('not sent');
  });

  it('fails closed on handshake timeout and microphone denial', async () => {
    const h = setup();
    h.controller.start(h.target);
    vi.advanceTimersByTime(15000);
    expect(h.controller.state.value.phase).toBe('error');
    expect(h.deps.capture).not.toHaveBeenCalled();
    h.deps.capture.mockRejectedValueOnce(new Error('Permission denied'));
    h.controller.start(h.target);
    await h.ready();
    await flush();
    expect(h.controller.state.value.error).toBe('Permission denied');
    expect(h.target.send).not.toHaveBeenCalled();
  });

  it('stops on network backpressure rather than silently dropping audio', async () => {
    const h = setup();
    h.controller.start(h.target);
    await h.ready();
    h.sockets[0].bufferedAmount = 1024 * 1024 + 1;
    h.chunk(new ArrayBuffer(320));
    expect(h.controller.state.value.phase).toBe('error');
    expect(h.capture.cancel).toHaveBeenCalledOnce();
  });
});
