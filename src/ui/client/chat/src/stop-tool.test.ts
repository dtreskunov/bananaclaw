import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyToolStopState, resetToolStops, stopActiveTool, toolStopRequest } from './stop-tool';
import { applyTurnState, resetTurnState, stopActiveTurn } from './stop-turn';
import { testSnapshot, testTurn } from './conversation-test-fixtures';
import { activeTurn, canSend, channelType, groupId, messagingGroupId, refs, stopRequest, threadId } from './state';
import { ToolStopButton } from './components/ToolStopButton';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

function sync(options: { connected?: boolean; status?: 'running' | 'interrupted'; turnId?: string } = {}): void {
  const id = options.turnId ?? 'turn-1';
  const connected = options.connected ?? true;
  applyTurnState({ id, status: 'running', supportsToolCancellation: true }, connected);
  const view = testSnapshot({
    turns: [
      {
        ...testTurn,
        id,
        phase: 'running',
        activity: ['target', 'sibling'].map((toolCallId, ordinal) => ({
          ordinal,
          ts: '1000',
          timelinePosition: ordinal + 1,
          text: JSON.stringify({
            kind: 'tool',
            id: toolCallId,
            tool: 'bash',
            status: toolCallId === 'target' ? (options.status ?? 'running') : 'running',
          }),
        })),
      },
    ],
    connection: { connected, activeTurnId: id },
  }).conversation;
  applyToolStopState(view);
}

beforeEach(() => {
  vi.useFakeTimers();
  groupId.value = 'group';
  threadId.value = 'thread';
  channelType.value = 'web';
  canSend.value = true;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sync();
});

afterEach(() => {
  resetToolStops();
  resetTurnState();
  groupId.value = null;
  threadId.value = null;
  messagingGroupId.value = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tool-scoped Stop', () => {
  it('targets one immutable call, waits for activity settlement and leaves the turn/sibling untouched', async () => {
    await stopActiveTool('turn-1', 'target');
    expect(fetch).toHaveBeenCalledWith(
      'api/groups/group/chat/thread/stop-tool',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: '{"turnId":"turn-1","toolCallId":"target"}',
      }),
    );
    expect(toolStopRequest('turn-1', 'target')).toEqual({ busy: true, error: '' });
    expect(toolStopRequest('turn-1', 'sibling')).toBeUndefined();
    expect(stopRequest.value).toBeNull();
    expect(activeTurn.value?.status).toBe('running');
    sync({ status: 'interrupted' });
    expect(toolStopRequest('turn-1', 'target')).toBeUndefined();
    expect(activeTurn.value?.id).toBe('turn-1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps status-row Stop as a separate whole-turn action, even while a tool stop is pending', async () => {
    await stopActiveTool('turn-1', 'target');
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'api/groups/group/chat/thread/stop',
      expect.objectContaining({ body: '{"turnId":"turn-1"}' }),
    );
    expect(stopRequest.value?.busy).toBe(true);
  });

  it('deduplicates clicks, rejects stale/finished targets, and supports independent concurrent tool requests', async () => {
    await stopActiveTool('turn-1', 'target');
    await stopActiveTool('turn-1', 'target');
    await stopActiveTool('old-turn', 'sibling');
    await stopActiveTool('turn-1', 'unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
    await stopActiveTool('turn-1', 'sibling');
    expect(fetch).toHaveBeenCalledTimes(2);
    sync({ turnId: 'turn-2' });
    expect(toolStopRequest('turn-1', 'target')).toBeUndefined();
    expect(toolStopRequest('turn-1', 'sibling')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('scopes external channel requests using the existing route context', async () => {
    channelType.value = 'telegram';
    messagingGroupId.value = 'messaging/group';
    await stopActiveTool('turn-1', 'target');
    expect(fetch).toHaveBeenCalledWith(
      'api/groups/group/chat/thread/stop-tool?channel=telegram&mg=messaging%2Fgroup',
      expect.anything(),
    );
  });

  it('never uses turn Stop as a fallback for unsupported, disconnected or read-only tools', async () => {
    activeTurn.value = { id: 'turn-1', status: 'running' };
    const unsupported = ToolStopButton({ turnId: 'turn-1', toolCallId: 'target' })!;
    expect(unsupported.props.disabled).toBe(true);
    expect(unsupported.props.title).toContain('cannot stop individual tools');
    await stopActiveTool('turn-1', 'target');
    sync({ connected: false });
    await stopActiveTool('turn-1', 'target');
    sync();
    canSend.value = false;
    await stopActiveTool('turn-1', 'target');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows distinct accessible labels, pending state and retry errors for this tool only', async () => {
    expect(ToolStopButton({ turnId: 'turn-1', toolCallId: 'target' })!.props['aria-label']).toBe('Stop tool');
    await stopActiveTool('turn-1', 'target');
    const busy = ToolStopButton({ turnId: 'turn-1', toolCallId: 'target' })!;
    expect(busy.props).toMatchObject({ 'aria-label': 'Stopping tool', 'aria-busy': true, disabled: true });
    await vi.advanceTimersByTimeAsync(30_000);
    const retry = ToolStopButton({ turnId: 'turn-1', toolCallId: 'target' })!;
    expect(retry.props['aria-label']).toBe('Retry stopping tool');
    expect(retry.props.disabled).toBe(false);
    expect(retry.props.title).toContain('not confirmed');
    expect(stopRequest.value).toBeNull();
    expect(activeTurn.value?.status).toBe('running');
  });

  it('surfaces runner failure and disconnection, and allows retry without abandoning the response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"unsupported"}', { status: 409 }));
    await stopActiveTool('turn-1', 'target');
    expect(toolStopRequest('turn-1', 'target')?.error).toContain('cannot stop individual tools');
    await stopActiveTool('turn-1', 'target');
    sync({ connected: false });
    expect(toolStopRequest('turn-1', 'target')).toMatchObject({
      busy: false,
      error: expect.stringContaining('Connection lost'),
    });
    expect(stopRequest.value).toBeNull();
  });

  it.each(['<html>Proxy error</html>', '{"error":42}', 'null'])(
    'reports a safe HTTP failure for an unusable tool-stop error body: %s',
    async (body) => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 502 }));
      await stopActiveTool('turn-1', 'target');
      expect(toolStopRequest('turn-1', 'target')).toEqual({
        busy: false,
        error: 'Tool stop request failed (HTTP 502).',
      });
      expect(console.error).toHaveBeenCalled();
      expect(stopRequest.value).toBeNull();
      expect(activeTurn.value?.status).toBe('running');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('bounds a stalled tool-stop HTTP request without stopping its sibling or turn', async () => {
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const request = stopActiveTool('turn-1', 'target');
    await vi.advanceTimersByTimeAsync(30_000);
    await request;
    expect(toolStopRequest('turn-1', 'target')?.error).toContain('not confirmed');
    expect(toolStopRequest('turn-1', 'sibling')).toBeUndefined();
    expect(activeTurn.value?.status).toBe('running');
    expect(stopRequest.value).toBeNull();
  });

  it('ignores a late failed request after navigating to a new conversation', async () => {
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const request = stopActiveTool('turn-1', 'target');
    refs.chatGeneration++;
    threadId.value = 'other-thread';
    resetToolStops();
    release(new Response('{"error":"old failure"}', { status: 500 }));
    await request;
    expect(toolStopRequest('turn-1', 'target')).toBeUndefined();
  });
});
