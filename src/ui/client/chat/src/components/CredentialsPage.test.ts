import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, CredentialsOverview } from './CredentialsApi';
import { CredentialsContent } from './CredentialsPage';
import { ConnectionEditor } from './CredentialsDialogs';
import { ModalDialog } from './ModalDialog';
import { credentialsOpen, groupAdminOpen } from '../state';

const harness = vi.hoisted(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  return {
    slots: [] as unknown[],
    cursor: 0,
    effects: [] as Array<() => void>,
    data: { connections: [], apps: [], groups: [], canEditInstall: false } as CredentialsOverview,
  };
});
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      harness.slots[index],
      (next: unknown) => {
        harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next;
      },
    ];
  },
  useEffect: (effect: () => void) => harness.effects.push(effect),
}));
vi.mock('./CredentialsParts', () => ({
  useCredentialResource: () => ({ data: harness.data, loading: false, error: '', refresh: vi.fn() }),
  useConnectionSignIn: () => ({ start: vi.fn(), waiting: null }),
  ErrorNotice: () => null,
}));

interface Node {
  type: unknown;
  props: { children?: unknown; id?: string; accessRequest?: unknown; onClose?: () => void };
}
function descendants(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...descendants(node.props.children)];
}
const request = {
  resource_url: 'https://integrate.api.nvidia.com/v1/*',
  authentication: { type: 'bearer' as const },
};
function connection(id: string, host = 'integrate.api.nvidia.com/v1/*'): Connection {
  return {
    id,
    label: id,
    kind: 'static',
    status: 'ready',
    revision: 'revision',
    owner: { id: 'me' },
    credentials: ['TOKEN'],
    grants: [],
    services: [{ name: 'inference', host, auth: { type: 'bearer', token: 'TOKEN' } }],
  };
}
function draw(onClose = vi.fn()) {
  harness.cursor = 0;
  const node = CredentialsContent({ initialRequest: request, onClose });
  for (const effect of harness.effects.splice(0)) effect();
  return node;
}

beforeEach(() => {
  harness.slots = [];
  harness.cursor = 0;
  harness.effects = [];
  harness.data.connections = [];
  groupAdminOpen.value = true;
  credentialsOpen.value = false;
});

describe('model Credentials shortcut', () => {
  it('prefills the existing editor without navigating away or granting access', () => {
    const close = vi.fn();
    draw(close);
    const node = draw(close);
    const editor = descendants(node).find((child) => child.type === ConnectionEditor);
    expect(editor?.props.accessRequest).toEqual(request);
    expect(editor?.props.id).toBeUndefined();
    expect(groupAdminOpen.value).toBe(true);
    expect(credentialsOpen.value).toBe(false);
    expect(node.type).toBe(ModalDialog);
    node.props.onClose?.();
    expect(close).toHaveBeenCalledOnce();
    expect(groupAdminOpen.value).toBe(true);
  });

  it('opens the matching personal credential, including a disabled route', () => {
    const existing = connection('nvidia');
    existing.services[0].enabled = false;
    harness.data.connections = [connection('other', 'api.minimax.io/*'), existing];
    draw();
    const editor = descendants(draw()).find((child) => child.type === ConnectionEditor);
    expect(editor?.props.id).toBe('nvidia');
    expect(editor?.props.accessRequest).toBeUndefined();
  });

  it('finds an existing credential with a narrower inference path', () => {
    harness.data.connections = [connection('nvidia', 'integrate.api.nvidia.com/v1/chat/completions')];
    draw();
    expect(descendants(draw()).find((child) => child.type === ConnectionEditor)?.props.id).toBe('nvidia');
  });

  it('leaves multiple matching credentials for the user to choose in the existing table', () => {
    harness.data.connections = [connection('personal'), connection('work')];
    draw();
    expect(descendants(draw()).some((child) => child.type === ConnectionEditor)).toBe(false);
  });

  it('does not reopen the editor after closing it or refreshing metadata', () => {
    draw();
    const editor = descendants(draw()).find((child) => child.type === ConnectionEditor)!;
    editor.props.onClose?.();
    harness.data = { ...harness.data };
    expect(descendants(draw()).some((child) => child.type === ConnectionEditor)).toBe(false);
  });
});
