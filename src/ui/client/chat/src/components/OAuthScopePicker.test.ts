import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthScopePicker } from './OAuthScopePicker';
import { ErrorNotice } from './CredentialsParts';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return { slots: [] as unknown[], cursor: 0, effects: [] as (() => (() => void) | void)[] };
});
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect: (effect: () => (() => void) | void) => hooks.effects.push(effect),
}));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

interface Node {
  type: unknown;
  props: {
    children?: unknown;
    checked?: boolean;
    message?: string;
    'aria-label'?: string;
    onChange?: (event: { currentTarget: { checked: boolean } }) => void;
  };
}
function descendants(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...descendants(node.props.children)];
}
type Props = Parameters<typeof OAuthScopePicker>[0];
function draw(props: Props): unknown {
  hooks.cursor = 0;
  hooks.effects = [];
  return OAuthScopePicker(props);
}
const response = (scopes: string[]) =>
  new Response(
    JSON.stringify({
      scopes,
      source: 'resource',
      oauth: true,
      issuer: 'https://issuer.example',
    }),
  );
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => response(['read', 'write'])),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('discovered scope picker', () => {
  it('offers advertised scopes without selecting them or dropping custom values', async () => {
    const onChange = vi.fn();
    const props: Props = {
      resource: 'https://mcp.example/mcp',
      value: 'custom:existing',
      configured: ['configured:read'],
      disabled: false,
      onChange,
      unspecified: false,
      onUnspecified: vi.fn(),
    };
    draw(props);
    hooks.effects[0]();
    await vi.advanceTimersByTimeAsync(500);
    const node = draw(props);
    const inputs = descendants(node).filter((item) => item.type === 'input');
    expect(inputs.find((item) => item.props['aria-label'] === 'Request scope read')?.props.checked).toBe(false);
    expect(inputs.find((item) => item.props['aria-label'] === 'Request scope custom:existing')?.props.checked).toBe(
      true,
    );
    expect(inputs.find((item) => item.props['aria-label'] === 'Request scope configured:read')).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
    inputs.find((item) => item.props['aria-label'] === 'Request scope write')!.props.onChange!({
      currentTarget: { checked: true },
    });
    expect(onChange).toHaveBeenCalledWith('custom:existing\nwrite');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      resource_url: 'https://mcp.example/mcp',
    });
  });
  it('surfaces discovery errors while preserving manual scope entry', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Provider unavailable' }), { status: 503 }),
    );
    const props: Props = { appId: 'private', value: 'existing', disabled: false, onChange: vi.fn() };
    draw(props);
    hooks.effects[0]();
    await vi.advanceTimersByTimeAsync(500);
    const node = draw(props);
    expect(descendants(node).find((item) => item.type === ErrorNotice)?.props.message).toContain(
      'Provider unavailable',
    );
    expect(descendants(node).some((item) => item.type === 'textarea')).toBe(true);
  });
  it('ignores a stale discovery response after the resource changes', async () => {
    let resolveOld!: (value: Response) => void;
    vi.mocked(fetch)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce(response(['new']));
    const first: Props = { resource: 'https://old.example/mcp', value: '', disabled: false, onChange: vi.fn() };
    draw(first);
    const cleanup = hooks.effects[0]()!;
    await vi.advanceTimersByTimeAsync(500);
    cleanup();
    const next = { ...first, resource: 'https://new.example/mcp' };
    draw(next);
    hooks.effects[0]();
    await vi.advanceTimersByTimeAsync(500);
    resolveOld(response(['old']));
    await vi.advanceTimersByTimeAsync(0);
    const labels = descendants(draw(next)).map((item) => item.props['aria-label']);
    expect(labels).toContain('Request scope new');
    expect(labels).not.toContain('Request scope old');
  });
});
