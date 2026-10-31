import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthScopePicker, ScopeList } from './OAuthScopePicker';
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
    value?: string;
    disabled?: boolean;
    scopes?: string[];
    onRemove?: (scope: string) => void;
    onInput?: (event: { currentTarget: { value: string } }) => void;
    onClick?: () => void;
    onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
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
  it('preserves saved scope selections and custom values', async () => {
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
    expect(descendants(node).find((item) => item.type === ScopeList)?.props.scopes).toEqual(['custom:existing']);
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
    expect(descendants(node).some((item) => item.type === 'textarea')).toBe(false);
    expect(descendants(node).some((item) => item.type === 'input' && item.props['aria-label'] === 'Add scope')).toBe(
      true,
    );
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
  it('selects all discovered scopes for a new setup without dropping suggested or custom scopes', async () => {
    const changed = vi.fn();
    const props: Props = {
      resource: 'https://mcp.example/mcp',
      value: 'custom:existing',
      selectDiscovered: true,
      disabled: false,
      onChange: (value) => {
        props.value = value;
        changed(value);
      },
    };
    draw(props);
    hooks.effects[0]();
    await vi.advanceTimersByTimeAsync(500);
    draw(props);
    hooks.effects[1]();
    expect(changed).toHaveBeenCalledWith('custom:existing\nread\nwrite');
    let node = draw(props);
    const inputs = descendants(node).filter((item) => item.type === 'input');
    expect(inputs.find((item) => item.props['aria-label'] === 'Request scope read')?.props.checked).toBe(true);
    expect(inputs.find((item) => item.props['aria-label'] === 'Request scope write')?.props.checked).toBe(true);
    inputs.find((item) => item.props['aria-label'] === 'Request scope write')!.props.onChange!({
      currentTarget: { checked: false },
    });
    node = draw(props);
    hooks.effects[1]();
    expect(props.value).toBe('custom:existing\nread');
    expect(descendants(node).find((item) => item.props['aria-label'] === 'Request scope write')?.props.checked).toBe(
      false,
    );
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('does not override a manual choice made before discovery completes', async () => {
    const changed = vi.fn();
    const props: Props = {
      resource: 'https://mcp.example/mcp',
      value: 'configured:read',
      configured: ['configured:read'],
      selectDiscovered: true,
      disabled: false,
      onChange: (value) => {
        props.value = value;
        changed(value);
      },
    };
    const node = draw(props);
    hooks.effects[0]();
    descendants(node).find((item) => item.props['aria-label'] === 'Request scope configured:read')!.props.onChange!({
      currentTarget: { checked: false },
    });
    await vi.advanceTimersByTimeAsync(500);
    draw(props);
    hooks.effects[1]();
    expect(props.value).toBe('');
    expect(changed).toHaveBeenCalledOnce();
  });
  it('preserves an explicit provider-default choice rather than selecting advertised scopes', async () => {
    const changed = vi.fn();
    const props: Props = {
      resource: 'https://mcp.example/mcp',
      value: '',
      selectDiscovered: true,
      disabled: false,
      unspecified: true,
      onChange: changed,
      onUnspecified: (value) => {
        props.unspecified = value;
      },
    };
    draw(props);
    hooks.effects[0]();
    await vi.advanceTimersByTimeAsync(500);
    let node = draw(props);
    hooks.effects[1]();
    expect(changed).not.toHaveBeenCalled();
    descendants(node).find((item) => item.props['aria-label'] === 'Make no scope request')!.props.onChange!({
      currentTarget: { checked: false },
    });
    node = draw(props);
    hooks.effects[1]();
    expect(changed).not.toHaveBeenCalled();
    expect(descendants(node).find((item) => item.props['aria-label'] === 'Request scope read')?.props.checked).toBe(
      false,
    );
  });
  it('adds and removes exact scope values as package-style entries, preserving commas', () => {
    const props: Props = {
      value: '',
      disabled: false,
      onChange: (value) => {
        props.value = value;
      },
    };
    let node = draw(props);
    descendants(node).find((item) => item.type === 'input' && item.props['aria-label'] === 'Add scope')!.props.onInput!(
      {
        currentTarget: { value: 'repo,notifications' },
      },
    );
    node = draw(props);
    const add = descendants(node).find((item) => item.type === 'button' && item.props['aria-label'] === 'Add scope')!;
    expect(add.props.disabled).toBe(false);
    const preventDefault = vi.fn();
    descendants(node).find((item) => item.type === 'input' && item.props['aria-label'] === 'Add scope')!.props
      .onKeyDown!({
      key: 'Enter',
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(props.value).toBe('repo,notifications');
    node = draw(props);
    const chips = descendants(node).find((item) => item.type === ScopeList)!;
    expect(chips.props.scopes).toEqual(['repo,notifications']);
    chips.props.onRemove!('repo,notifications');
    expect(props.value).toBe('');
  });
  it('blocks duplicate and invalid individual scopes', () => {
    const props: Props = { value: 'read', disabled: false, onChange: vi.fn() };
    for (const value of ['read', 'read write', '"quoted"', 'bad\\scope']) {
      let node = draw(props);
      descendants(node).find((item) => item.type === 'input' && item.props['aria-label'] === 'Add scope')!.props
        .onInput!({
        currentTarget: { value },
      });
      node = draw(props);
      expect(
        descendants(node).find((item) => item.type === 'button' && item.props['aria-label'] === 'Add scope')?.props
          .disabled,
      ).toBe(true);
    }
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
