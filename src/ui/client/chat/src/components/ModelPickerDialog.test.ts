import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPickerDialog, type ModelPickerDialogProps } from './ModelPickerDialog';
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
    cleanups: new Map<number, () => void>(),
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
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.dependencies.get(index);
    if (!previous || deps.some((value, i) => value !== previous[i]))
      hooks.effects.push(() => {
        hooks.cleanups.get(index)?.();
        const cleanup = effect();
        if (cleanup) hooks.cleanups.set(index, cleanup);
        else hooks.cleanups.delete(index);
      });
    hooks.dependencies.set(index, deps);
  },
}));
vi.mock('../api', () => ({ protocolFetch: vi.fn() }));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

interface Node {
  type: unknown;
  props: {
    children?: unknown;
    initialRequest?: unknown;
    onClick?: () => void;
    onClose?: () => void;
    onChange?: (event: { currentTarget: { value: string } }) => void;
    oninput?: (event: { target: { value: string } }) => void;
    'aria-label'?: string;
    placeholder?: string;
    class?: string;
    id?: string;
    value?: string;
    role?: string;
  };
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
const fixtureModels = [
  {
    id: 'alpha/qwen',
    label: 'Qwen Alpha',
    upstream: 'alpha',
    upstreamLabel: 'Alpha',
    modalitiesIn: ['text', 'image'],
    modalitiesOut: ['text'],
    contextWindow: 262144,
    outputCostPerMTok: 2,
  },
  {
    id: 'groq/qwen',
    label: 'Qwen Groq',
    upstream: 'groq',
    upstreamLabel: 'Groq',
    modalitiesIn: ['text'],
    modalitiesOut: ['text'],
    contextWindow: 131072,
    outputCostPerMTok: 4,
  },
  {
    id: 'groq/other',
    label: 'Other Groq',
    upstream: 'groq',
    upstreamLabel: 'Groq',
    modalitiesIn: ['text', 'image'],
    modalitiesOut: ['text'],
    contextWindow: 32768,
    outputCostPerMTok: 10,
  },
  {
    id: 'nvidia/vision',
    label: 'Vision Nvidia',
    upstream: 'nvidia',
    upstreamLabel: 'NVIDIA',
    modalitiesIn: ['text', 'image'],
    modalitiesOut: ['text'],
    contextWindow: 1000000,
    outputCostPerMTok: 0.8,
  },
];
let catalogModels: typeof fixtureModels = [];
let configuredProviders: string[] = [];
let instance = 0;
const onChange = vi.fn();
function draw(
  value: string | null = 'nvidia/minimaxai/minimax-m3.1-flash',
  overrides: Partial<ModelPickerDialogProps> = {},
) {
  hooks.cursor = 0;
  const node = ModelPickerDialog({
    value,
    fallbackValue: 'nvidia/default',
    provider: 'native',
    apiBasePath: `/api/group-${instance}/admin`,
    onChange,
    ...overrides,
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
  instance++;
  catalogModels = [];
  configuredProviders = [];
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.dependencies.clear();
  vi.clearAllMocks();
  vi.mocked(protocolFetch).mockImplementation(async (url) => {
    if (String(url).includes('/model-connection?')) return Response.json({ connection: request });
    if (String(url).includes('/configured-model-providers?')) return Response.json({ configuredProviders });
    const upstream = new URL(String(url), 'http://localhost').searchParams.get('upstream');
    return Response.json({
      models: catalogModels.filter((model) => !upstream || model.upstream === upstream),
      source: 'models.dev',
      upstream,
    });
  });
});

afterEach(() => {
  for (const cleanup of hooks.cleanups.values()) cleanup();
  hooks.cleanups.clear();
});

function providerSelect(node: unknown): Node {
  return descendants(node).find((child) => child.type === 'select' && child.props['aria-label'] === 'Provider')!;
}
function modelNames(node: unknown): string[] {
  return descendants(node)
    .filter((child) => child.props.class === 'mpd-item-name')
    .map(text);
}
function optionLabels(node: unknown): string[] {
  return descendants(node)
    .filter((child) => child.type === 'option')
    .map(text);
}
function catalogRequests() {
  return vi.mocked(protocolFetch).mock.calls.filter(([url]) => String(url).includes('/models?'));
}
async function openPicker(overrides: Partial<ModelPickerDialogProps> = {}): Promise<ReturnType<typeof draw>> {
  draw(undefined, overrides);
  await new Promise((resolve) => setTimeout(resolve, 0));
  descendants(draw(undefined, overrides))
    .find((child) => child.props.class === 'mpd-trigger')!
    .props.onClick?.();
  draw(undefined, overrides);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return draw(undefined, overrides);
}

describe('model catalog recovery', () => {
  beforeEach(() => {
    catalogModels = fixtureModels;
  });

  it.each([
    {
      name: 'HTTP 200 unavailable',
      failure: () => Promise.resolve(Response.json({ source: 'unavailable', models: [], upstream: null })),
    },
    { name: 'HTTP error', failure: () => Promise.resolve(new Response('unavailable', { status: 503 })) },
    { name: 'network failure', failure: () => Promise.reject(new TypeError('Network unavailable')) },
    { name: 'malformed JSON', failure: () => Promise.resolve(new Response('not json')) },
    { name: 'invalid response', failure: () => Promise.resolve(Response.json({ models: [] })) },
  ])('does not cache $name when reopening the picker', async ({ failure }) => {
    const original = vi.mocked(protocolFetch).getMockImplementation()!;
    let failed = false;
    vi.mocked(protocolFetch).mockImplementation((url, options) => {
      if (String(url).includes('/models?') && !failed) {
        failed = true;
        return failure();
      }
      return original(url, options);
    });
    const node = await openPicker();
    expect(modelNames(node)).toHaveLength(4);
    expect(catalogRequests()).toHaveLength(2);
  });

  it('retries an unavailable catalog without reloading and retains successful caching', async () => {
    const original = vi.mocked(protocolFetch).getMockImplementation()!;
    let unavailable = true;
    vi.mocked(protocolFetch).mockImplementation((url, options) =>
      String(url).includes('/models?') && unavailable
        ? Promise.resolve(Response.json({ source: 'unavailable', models: [], upstream: null }))
        : original(url, options),
    );
    let node = await openPicker();
    expect(text(node)).toContain('Model catalog unavailable. Please try again.');
    const requestsBeforeRetry = catalogRequests().length;
    unavailable = false;
    descendants(node)
      .find((child) => child.type === 'button' && text(child) === 'Retry')!
      .props.onClick?.();
    draw();
    expect(text(draw())).toContain('Loading…');
    await new Promise((resolve) => setTimeout(resolve, 0));
    node = draw();
    expect(modelNames(node)).toHaveLength(4);
    expect(text(node)).not.toContain('Model catalog unavailable');
    expect(catalogRequests()).toHaveLength(requestsBeforeRetry + 1);
    descendants(node)
      .find((child) => child.props.onClose && child.type !== CredentialsContent)!
      .props.onClose?.();
    draw();
    await openPicker();
    expect(catalogRequests()).toHaveLength(requestsBeforeRetry + 1);
  });

  it('deduplicates in-flight eager and dialog requests', async () => {
    const original = vi.mocked(protocolFetch).getMockImplementation()!;
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    vi.mocked(protocolFetch).mockImplementation((url, options) =>
      String(url).includes('/models?') ? pending : original(url, options),
    );
    const node = draw();
    descendants(node)
      .find((child) => child.props.class === 'mpd-trigger')!
      .props.onClick?.();
    draw();
    expect(catalogRequests()).toHaveLength(1);
    complete(Response.json({ models: fixtureModels, source: 'models.dev', upstream: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modelNames(draw())).toHaveLength(4);
  });
});

describe('model provider filter', () => {
  beforeEach(() => {
    catalogModels = fixtureModels;
  });

  it('defaults to all providers and puts configured providers first without changing the saved model', async () => {
    configuredProviders = ['groq'];
    const node = await openPicker();
    const select = providerSelect(node);
    expect(select.props.value).toBe('');
    expect(optionLabels(select)).toEqual(['All providers', 'Groq — Credential configured', 'Alpha', 'NVIDIA']);
    expect(modelNames(node)).toHaveLength(4);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('filters by one provider and combines with search and existing facets', async () => {
    const node = await openPicker();
    providerSelect(node).props.onChange?.({ currentTarget: { value: 'groq' } });
    expect(modelNames(draw())).toEqual(['Qwen Groq', 'Other Groq']);
    const search = descendants(draw()).find((child) => child.props.placeholder === 'Search models…')!;
    expect(search.props.oninput).toBeTypeOf('function');
    search.props.oninput!({ target: { value: 'Qwen' } });
    expect(descendants(draw()).find((child) => child.props.placeholder === 'Search models…')!.props.value).toBe('Qwen');
    expect(modelNames(draw())).toEqual(['Qwen Groq']);
    descendants(draw())
      .find((child) => child.props.id === 'mpd-in-image')!
      .props.onChange?.({ currentTarget: { value: 'image' } });
    expect(modelNames(draw())).toEqual([]);
    providerSelect(draw()).props.onChange?.({ currentTarget: { value: '' } });
    expect(modelNames(draw())).toEqual(['Qwen Alpha']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not expand a picker’s fixed upstream restriction', async () => {
    const node = await openPicker({ upstream: 'groq' });
    expect(optionLabels(providerSelect(node))).toEqual(['All providers', 'Groq']);
    expect(modelNames(node)).toEqual(['Qwen Groq', 'Other Groq']);
    expect(
      vi
        .mocked(protocolFetch)
        .mock.calls.some(([url]) => String(url).includes('/configured-model-providers?provider=native&upstream=groq')),
    ).toBe(true);
  });

  it('combines provider filtering with cost and context thresholds', async () => {
    let node = await openPicker();
    providerSelect(node).props.onChange?.({ currentTarget: { value: 'groq' } });
    descendants(draw())
      .find((child) => child.props.id === 'mpd-cost-mid')!
      .props.onChange?.({ currentTarget: { value: 'mid' } });
    descendants(draw())
      .find((child) => child.props.id === 'mpd-ctx-128k')!
      .props.onChange?.({ currentTarget: { value: '128k' } });
    node = draw();
    expect(modelNames(node)).toEqual(['Qwen Groq']);
    providerSelect(node).props.onChange?.({ currentTarget: { value: '' } });
    expect(modelNames(draw())).toEqual(['Qwen Alpha', 'Qwen Groq']);
  });

  it('does not add credential lookups to the transcription picker', async () => {
    const node = await openPicker({ provider: 'openrouter' });
    expect(providerSelect(node)).toBeUndefined();
    expect(
      vi.mocked(protocolFetch).mock.calls.some(([url]) => String(url).includes('/configured-model-providers?')),
    ).toBe(false);
  });

  it('ignores a stale credential response after switching groups', async () => {
    const original = vi.mocked(protocolFetch).getMockImplementation()!;
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    vi.mocked(protocolFetch).mockImplementation((url, options) =>
      String(url).includes(`/api/group-${instance}/admin/configured-model-providers?`)
        ? pending
        : original(url, options),
    );
    await openPicker();
    configuredProviders = ['alpha'];
    const next = { apiBasePath: `/api/other-${instance}/admin` };
    draw(undefined, next);
    await new Promise((resolve) => setTimeout(resolve, 0));
    draw(undefined, next);
    complete(Response.json({ configuredProviders: ['groq'] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const options = optionLabels(providerSelect(draw(undefined, next)));
    expect(options).toEqual(['All providers', 'Alpha — Credential configured', 'Groq', 'NVIDIA']);
  });

  it('resets to all providers and refreshes credential metadata on reopening', async () => {
    let node = await openPicker();
    providerSelect(node).props.onChange?.({ currentTarget: { value: 'groq' } });
    expect(modelNames(draw())).toHaveLength(2);
    const dialog = descendants(draw()).find((child) => child.props.onClose && child.type !== CredentialsContent)!;
    dialog.props.onClose?.();
    draw();
    configuredProviders = ['nvidia'];
    node = await openPicker();
    expect(providerSelect(node).props.value).toBe('');
    expect(optionLabels(providerSelect(node))[1]).toBe('NVIDIA — Credential configured');
    expect(
      vi.mocked(protocolFetch).mock.calls.filter(([url]) => String(url).includes('/configured-model-providers?')),
    ).toHaveLength(2);
  });

  it('shows credential lookup failures but keeps provider filtering available', async () => {
    const original = vi.mocked(protocolFetch).getMockImplementation()!;
    vi.mocked(protocolFetch).mockImplementation((url, options) =>
      String(url).includes('/configured-model-providers?')
        ? Promise.resolve(Response.json({ error: 'Credential gateway unavailable' }, { status: 503 }))
        : original(url, options),
    );
    const node = await openPicker();
    expect(text(node)).toContain('Could not load configured providers: Credential gateway unavailable');
    expect(optionLabels(providerSelect(node))).toEqual(['All providers', 'Alpha', 'Groq', 'NVIDIA']);
    providerSelect(node).props.onChange?.({ currentTarget: { value: 'groq' } });
    expect(modelNames(draw())).toHaveLength(2);
  });

  it('refreshes configured markers after returning from the existing Credentials flow', async () => {
    let node = await openPicker();
    descendants(node)
      .find((child) => child.type === 'button' && text(child) === 'Credentials')!
      .props.onClick?.();
    const editor = descendants(draw()).find((child) => child.type === CredentialsContent)!;
    configuredProviders = ['groq'];
    editor.props.onClose?.();
    draw();
    await new Promise((resolve) => setTimeout(resolve, 0));
    node = draw();
    expect(optionLabels(providerSelect(node))[1]).toBe('Groq — Credential configured');
  });
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
