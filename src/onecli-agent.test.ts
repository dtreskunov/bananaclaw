import { describe, expect, it, vi } from 'vitest';

import { ensureOneCliAgent } from './onecli-agent.js';

function client(created: boolean) {
  return {
    ensureAgent: vi.fn().mockResolvedValue({ name: 'Agent', identifier: 'ag-1', created }),
    listAgents: vi.fn().mockResolvedValue([
      {
        id: 'onecli-agent-1',
        name: 'Agent',
        identifier: 'ag-1',
        isDefault: false,
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    ]),
    attachSecret: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ensureOneCliAgent', () => {
  it('attaches each allow-listed secret to a newly created agent', async () => {
    const onecli = client(true);

    await ensureOneCliAgent(onecli, 'Agent', 'ag-1', ['secret-1', 'secret-2']);

    expect(onecli.attachSecret.mock.calls).toEqual([
      ['onecli-agent-1', 'secret-1'],
      ['onecli-agent-1', 'secret-2'],
    ]);
  });

  it('does not change grants on an existing agent', async () => {
    const onecli = client(false);

    await ensureOneCliAgent(onecli, 'Agent', 'ag-1', ['secret-1']);

    expect(onecli.listAgents).not.toHaveBeenCalled();
    expect(onecli.attachSecret).not.toHaveBeenCalled();
  });

  it('does not list agents when the allow-list is empty', async () => {
    const onecli = client(true);

    await ensureOneCliAgent(onecli, 'Agent', 'ag-1', []);

    expect(onecli.listAgents).not.toHaveBeenCalled();
    expect(onecli.attachSecret).not.toHaveBeenCalled();
  });

  it('fails provisioning when the created agent cannot be resolved', async () => {
    const onecli = client(true);
    onecli.listAgents.mockResolvedValue([]);

    await expect(ensureOneCliAgent(onecli, 'Agent', 'ag-1', ['secret-1'])).rejects.toThrow(
      /did not return it from listAgents/,
    );
    expect(onecli.attachSecret).not.toHaveBeenCalled();
  });

  it('fails provisioning when an allow-listed secret cannot be attached', async () => {
    const onecli = client(true);
    onecli.attachSecret.mockRejectedValue(new Error('grant rejected'));

    await expect(ensureOneCliAgent(onecli, 'Agent', 'ag-1', ['secret-1'])).rejects.toThrow('grant rejected');
  });

  it('shares provisioning across concurrent starts for the same agent', async () => {
    const onecli = client(true);
    onecli.listAgents.mockResolvedValue([
      {
        id: 'onecli-agent-1',
        name: 'Agent',
        identifier: 'ag-concurrent',
        isDefault: false,
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    ]);

    await Promise.all([
      ensureOneCliAgent(onecli, 'Agent', 'ag-concurrent', ['secret-1']),
      ensureOneCliAgent(onecli, 'Agent', 'ag-concurrent', ['secret-1']),
    ]);

    expect(onecli.ensureAgent).toHaveBeenCalledOnce();
    expect(onecli.attachSecret).toHaveBeenCalledOnce();
  });
});