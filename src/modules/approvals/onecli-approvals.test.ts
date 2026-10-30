import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@onecli-sh/sdk';
import type { ChannelDeliveryAdapter } from '../../delivery.js';

const state = vi.hoisted(() => ({
  configured: true,
  getClient: vi.fn(),
  configure: vi.fn(),
  stop: vi.fn(),
  pendingRows: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../onecli-agent.js', () => ({
  isOneCliConfigured: () => state.configured,
  getOneCliClient: state.getClient,
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: () => ({ id: 'group', name: 'Group' }) }));
vi.mock('../../db/sessions.js', () => ({
  createPendingApproval: state.create,
  deletePendingApproval: state.remove,
  getPendingApprovalsByAction: state.pendingRows,
  updatePendingApprovalStatus: vi.fn(),
}));
vi.mock('./primitive.js', () => ({
  pickApprover: () => ['owner'],
  pickApprovalDelivery: async () => ({
    userId: 'owner',
    messagingGroup: { channel_type: 'web', platform_id: 'owner' },
  }),
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

let callback: ((request: ApprovalRequest) => Promise<'approve' | 'deny'>) | undefined;
const client = { configureManualApproval: state.configure };
const adapter = (): ChannelDeliveryAdapter => ({ deliver: vi.fn().mockResolvedValue('message') });
const request = (): ApprovalRequest => ({
  id: 'request',
  method: 'GET',
  url: 'https://api.example.test/',
  host: 'api.example.test',
  path: '/',
  headers: {},
  bodyPreview: null,
  agent: { id: 'agent', name: 'Group', externalId: 'group' },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  timeoutSeconds: 60,
});
beforeEach(() => {
  stopOneCLIApprovalHandler();
  vi.clearAllMocks();
  callback = undefined;
  state.configured = true;
  state.pendingRows.mockReturnValue([]);
  state.getClient.mockResolvedValue(client);
  state.configure.mockImplementation((fn) => {
    callback = fn;
    return { stop: state.stop };
  });
});
afterEach(() => stopOneCLIApprovalHandler());

describe('optional OneCLI approval lifecycle', () => {
  it('sweeps stale cards but does not load the SDK when unconfigured', async () => {
    state.configured = false;
    state.pendingRows.mockReturnValue([{ approval_id: 'stale' }]);
    await startOneCLIApprovalHandler(adapter());
    expect(state.remove).toHaveBeenCalledWith('stale');
    expect(state.getClient).not.toHaveBeenCalled();
    expect(state.configure).not.toHaveBeenCalled();
  });
  it('shares asynchronous initialization across delivery readiness notifications', async () => {
    await Promise.all([startOneCLIApprovalHandler(adapter()), startOneCLIApprovalHandler(adapter())]);
    expect(state.getClient).toHaveBeenCalledOnce();
    expect(state.configure).toHaveBeenCalledOnce();
  });
  it('starts the listener while stale-card delivery is still pending', async () => {
    const delivery = adapter();
    let edited!: (value: string | undefined) => void;
    state.pendingRows.mockReturnValue([
      {
        approval_id: 'stale',
        channel_type: 'web',
        platform_id: 'owner',
        platform_message_id: 'old-message',
      },
    ]);
    vi.mocked(delivery.deliver).mockReturnValueOnce(
      new Promise((resolve) => {
        edited = resolve;
      }),
    );
    const start = startOneCLIApprovalHandler(delivery);
    await vi.waitFor(() => expect(state.configure).toHaveBeenCalledOnce());
    edited('old-message');
    await start;
    expect(state.remove).toHaveBeenCalledWith('stale');
  });
  it('does not activate a late SDK load after shutdown', async () => {
    let resolve!: (value: typeof client) => void;
    state.getClient.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const start = startOneCLIApprovalHandler(adapter());
    await vi.waitFor(() => expect(state.getClient).toHaveBeenCalledOnce());
    stopOneCLIApprovalHandler();
    resolve(client);
    await start;
    expect(state.configure).not.toHaveBeenCalled();
  });
  it('denies held requests and releases their promises during shutdown', async () => {
    await startOneCLIApprovalHandler(adapter());
    const decision = callback!(request());
    await vi.waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    stopOneCLIApprovalHandler();
    await expect(decision).resolves.toBe('deny');
    expect(state.stop).toHaveBeenCalledOnce();
  });
  it('uses the replacement delivery adapter without starting another listener', async () => {
    const first = adapter(),
      second = adapter();
    await startOneCLIApprovalHandler(first);
    await startOneCLIApprovalHandler(second);
    const decision = callback!(request());
    await vi.waitFor(() => expect(second.deliver).toHaveBeenCalledOnce());
    expect(first.deliver).not.toHaveBeenCalled();
    expect(state.configure).toHaveBeenCalledOnce();
    stopOneCLIApprovalHandler();
    await expect(decision).resolves.toBe('deny');
  });
  it('does not strand a request whose card delivery completes after shutdown', async () => {
    const delivery = adapter();
    let delivered!: (value: string | undefined) => void;
    vi.mocked(delivery.deliver).mockReturnValueOnce(
      new Promise((resolve) => {
        delivered = resolve;
      }),
    );
    await startOneCLIApprovalHandler(delivery);
    const decision = callback!(request());
    await vi.waitFor(() => expect(delivery.deliver).toHaveBeenCalledOnce());
    stopOneCLIApprovalHandler();
    delivered('late-message');
    await expect(decision).resolves.toBe('deny');
    expect(state.create).not.toHaveBeenCalled();
    expect(delivery.deliver).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(delivery.deliver).mock.calls[1][4]))).toMatchObject({
      operation: 'edit',
      messageId: 'late-message',
      text: 'Expired (host stopped)',
    });
  });
  it('surfaces initialization failures and permits a later retry', async () => {
    state.getClient.mockRejectedValueOnce(new Error('Legacy client unavailable'));
    await expect(startOneCLIApprovalHandler(adapter())).rejects.toThrow('Legacy client unavailable');
    await startOneCLIApprovalHandler(adapter());
    expect(state.configure).toHaveBeenCalledOnce();
  });
});
