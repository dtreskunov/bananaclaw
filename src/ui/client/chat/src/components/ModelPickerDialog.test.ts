import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPickerDialog } from './ModelPickerDialog';
import { CredentialsContent } from './CredentialsPage';
import { protocolFetch } from '../api';
import { showToast } from './Toast';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as unknown[],
    cursor: 0,
    effects: [] as Array<() => void>,
    dependencies: new Map<number, unknown[]>(),
  };
});
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
      },
    ];
  },
  useRef: (current: unknown) => ({ current }),
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.dependencies.get(index);
    if (!previous || deps.some((value, i) => value !== previous[i])) hooks.effects.push(effect);
    hooks.dependencies.set(index, deps);
  },
}));
vi.mock('../api', () => ({ protocolFetch: vi.fn() }));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

interface Node {
  type: unknown;
  props: { children?: unknown; initialRequest?: unknown; onClick?: () => void; onClose?: () => void };
}
function descendants(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...descendants(node.props.children)];
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return text((value as Node).props.children);
}
const request = {
  resource_url: 'https://operator.test:8443/v1/*',
  authentication: { type: 'bearer' as const },
};
function draw(value: string | null = 'nvidia/minimaxai/minimax-m3.1-flash') {
  hooks.cursor = 0;
  const node = ModelPickerDialog({
    value,
    fallbackValue: 'nvidia/default',
    provider: 'native',
    apiBasePath: '/api/group/admin',
    onChange: vi.fn(),
  });
  for (const effect of hooks.effects.splice(0)) effect();
  return node;
}
async function load(value?: string | null) {
  draw(value);
  await vi.waitFor(() =>
    expect(protocolFetch).toHaveBeenCalledWith(expect.stringContaining('/model-connection?'), expect.anything()),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return draw(value);
}
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.dependencies.clear();
  vi.clearAllMocks();
  vi.mocked(protocolFetch).mockImplementation(async (url) =>
    Response.json(
      String(url).includes('/model-connection?')
        ? { connection: request }
        : { models: [], source: 'models.dev', upstream: null },
    ),
  );
});

describe('minimal model credential UI', () => {
  it('shows only the effective hostname and opens the existing Credentials UI', async () => {
    const node = await load();
    expect(text(node)).toContain('API: operator.test:8443');
    const button = descendants(node).find((child) => child.type === 'button' && text(child) === 'Credentials')!;
    button.props.onClick?.();
    const credentials = descendants(draw()).find((child) => child.type === CredentialsContent)!;
    expect(credentials.props.initialRequest).toEqual(request);
    credentials.props.onClose?.();
    expect(descendants(draw()).some((child) => child.type === CredentialsContent)).toBe(false);
  });

  it('resolves a default model without requiring an explicit override', async () => {
    await load(null);
    expect(vi.mocked(protocolFetch).mock.calls.some(([url]) => String(url).includes('model=nvidia%2Fdefault'))).toBe(
      true,
    );
  });

  it('keeps the open editor bound to its original request while model metadata changes', async () => {
    const node = await load();
    descendants(node)
      .find((child) => child.type === 'button' && text(child) === 'Credentials')!
      .props.onClick?.();
    const next = { ...request, resource_url: 'https://other.test/v1/*' };
    vi.mocked(protocolFetch).mockResolvedValue(Response.json({ connection: next }));
    await load('nvidia/other-model');
    const updated = draw('nvidia/other-model');
    expect(text(updated)).toContain('API: other.test');
    expect(descendants(updated).find((child) => child.type === CredentialsContent)?.props.initialRequest).toEqual(
      request,
    );
  });

  it('surfaces endpoint lookup failures instead of showing an incorrect hostname', async () => {
    vi.mocked(protocolFetch).mockImplementation(async (url) =>
      String(url).includes('/model-connection?')
        ? Response.json({ error: 'Model API destination unavailable.' }, { status: 503 })
        : Response.json({ models: [] }),
    );
    await load();
    expect(showToast).toHaveBeenCalledWith('Model API destination unavailable.', 'err');
    expect(text(draw())).not.toContain('API:');
  });
});
