import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  THEMES,
  TEXT_DENSITIES,
  createAppearanceController,
  getAppearanceController,
  parseAppearance,
  resolveMode,
} from './appearance';
import type { AppearanceController, AppearancePreferences } from './appearance';
import { appearance, initAppearance, setAppearance } from './appearance-state';
import { AppearanceSettings } from './components/AppearanceSettings';

const autumnDark: AppearancePreferences = {
  version: 3,
  theme: 'autumn',
  mode: 'dark',
  density: 'comfortable',
  showTechnicalStatus: false,
};
const controllers: AppearanceController[] = [];

function browser(raw: string | null = null, dark = false) {
  const stored = new Map<string, string>(raw === null ? [] : [[APPEARANCE_KEY, raw]]);
  const storage = {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      stored.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      stored.delete(key);
    }),
  };
  const mediaListeners = new Set<() => void>();
  const storageListeners = new Set<(event: Partial<StorageEvent>) => void>();
  const domListeners = new Set<() => void>();
  const dataset: Record<string, string> = {};
  const meta = { setAttribute: vi.fn(), getAttribute: () => '#151515' };
  let cssColor = '';
  const media = {
    matches: dark,
    addEventListener: vi.fn((_name: string, listener: () => void) => {
      mediaListeners.add(listener);
    }),
    removeEventListener: vi.fn((_name: string, listener: () => void) => {
      mediaListeners.delete(listener);
    }),
  };
  vi.stubGlobal('window', {
    localStorage: storage,
    matchMedia: vi.fn(() => media),
    getComputedStyle: () => ({ getPropertyValue: () => cssColor }),
    addEventListener: vi.fn((_name: string, listener: (event: Partial<StorageEvent>) => void) => {
      storageListeners.add(listener);
    }),
    removeEventListener: vi.fn((_name: string, listener: (event: Partial<StorageEvent>) => void) => {
      storageListeners.delete(listener);
    }),
  });
  vi.stubGlobal('document', {
    documentElement: { dataset },
    querySelector: () => meta,
    addEventListener: vi.fn((_name: string, listener: () => void) => {
      domListeners.add(listener);
    }),
    removeEventListener: vi.fn((_name: string, listener: () => void) => {
      domListeners.delete(listener);
    }),
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    stored,
    storage,
    media,
    dataset,
    meta,
    mediaListeners,
    storageListeners,
    domListeners,
    start() {
      const controller = createAppearanceController(window, document);
      controllers.push(controller);
      return controller;
    },
    systemChange(next: boolean) {
      media.matches = next;
      for (const listener of mediaListeners) listener();
    },
    storageChange(key: string | null, newValue: string | null, storageArea: unknown = storage) {
      for (const listener of storageListeners) listener({ key, newValue, storageArea: storageArea as Storage });
    },
    cssLoaded(color: string) {
      cssColor = color;
      for (const listener of domListeners) listener();
    },
  };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  appearance.value = { preferences: { ...DEFAULT_APPEARANCE }, resolvedMode: 'light', error: null };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('appearance preferences', () => {
  it('defaults to Default / System / Compact with technical status hidden', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(THEMES.map((theme) => theme.id)).toEqual(['default', 'autumn']);
    expect(TEXT_DENSITIES.map((density) => density.id)).toEqual(['comfortable', 'compact']);
    expect(DEFAULT_APPEARANCE.density).toBe('compact');
    expect(DEFAULT_APPEARANCE.showTechnicalStatus).toBe(false);
  });

  it.each([
    '{',
    '{}',
    'null',
    '[]',
    '{"version":2,"theme":"autumn","mode":"dark"}',
    '{"version":4,"theme":"autumn","mode":"dark","density":"comfortable","showTechnicalStatus":false}',
    '{"version":2,"theme":"autumn","mode":"dark","density":"dense"}',
    '{"version":2,"theme":"default","mode":"light","density":null}',
    '{"version":3,"theme":"default","mode":"light","density":"compact"}',
    '{"version":3,"theme":"default","mode":"light","density":"compact","showTechnicalStatus":"yes"}',
    '{"version":1,"theme":"missing","mode":"light"}',
    '{"version":1,"theme":"default","mode":"auto"}',
  ])('rejects corrupt or unsupported preferences: %s', (raw) => {
    expect(() => parseAppearance(raw)).toThrow();
  });

  it.each(['default', 'autumn'] as const)('roundtrips every mode of %s', (theme) => {
    for (const mode of ['system', 'light', 'dark'] as const) {
      for (const density of ['comfortable', 'compact'] as const) {
        for (const showTechnicalStatus of [false, true]) {
          const prefs: AppearancePreferences = { version: 3, theme, mode, density, showTechnicalStatus };
          expect(parseAppearance(JSON.stringify(prefs))).toEqual(prefs);
        }
      }
    }
  });

  it('migrates version 1 without changing the selected theme or mode', () => {
    for (const theme of ['default', 'autumn']) {
      for (const mode of ['system', 'light', 'dark']) {
        expect(parseAppearance(JSON.stringify({ version: 1, theme, mode }))).toEqual({
          version: 3,
          theme,
          mode,
          density: 'compact',
          showTechnicalStatus: false,
        });
      }
    }
  });

  it('migrates version 2 with technical status hidden', () => {
    expect(parseAppearance('{"version":2,"theme":"autumn","mode":"dark","density":"comfortable"}')).toEqual({
      ...autumnDark,
      showTechnicalStatus: false,
    });
  });

  it('resolves explicit modes independently of the OS', () => {
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
  });
});

describe('appearance controller', () => {
  it('applies saved preferences synchronously before styles load', () => {
    const page = browser(JSON.stringify(autumnDark));
    const controller = page.start();
    expect(page.dataset).toEqual({ theme: 'autumn', mode: 'dark', density: 'comfortable' });
    expect(controller.getSnapshot().preferences).toEqual(autumnDark);
    expect(page.meta.setAttribute).toHaveBeenCalledWith('content', '#151515');
    page.cssLoaded('#28201a');
    expect(page.meta.setAttribute).toHaveBeenCalledWith('content', '#28201a');
  });

  it('updates System mode live while leaving explicit modes alone', () => {
    const page = browser();
    const controller = page.start();
    controller.setPreferences({ ...autumnDark, mode: 'system' });
    page.systemChange(true);
    expect(page.dataset).toEqual({ theme: 'autumn', mode: 'dark', density: 'comfortable' });
    controller.setPreferences({ ...autumnDark, mode: 'light' });
    page.systemChange(false);
    page.systemChange(true);
    expect(page.dataset).toEqual({ theme: 'autumn', mode: 'light', density: 'comfortable' });
  });

  it('saves changes, preserves mode when switching theme, and restores on reload', () => {
    const page = browser();
    const controller = page.start();
    controller.setPreferences(autumnDark);
    controller.setPreferences({ ...controller.getSnapshot().preferences, theme: 'default' });
    const saved = page.stored.get(APPEARANCE_KEY)!;
    expect(parseAppearance(saved)).toEqual({ ...autumnDark, theme: 'default' });
    const reloaded = browser(saved, false);
    reloaded.start();
    expect(reloaded.dataset).toEqual({ theme: 'default', mode: 'dark', density: 'comfortable' });
  });

  it('synchronizes changes and removal across tabs without writing them back', () => {
    const page = browser(null, true);
    const controller = page.start();
    const listener = vi.fn();
    controller.subscribe(listener);
    page.storageChange(APPEARANCE_KEY, JSON.stringify(autumnDark));
    expect(page.dataset.theme).toBe('autumn');
    expect(page.dataset.density).toBe('comfortable');
    page.storageChange('unrelated', null);
    page.storageChange(APPEARANCE_KEY, JSON.stringify(DEFAULT_APPEARANCE), {});
    expect(listener).toHaveBeenCalledTimes(1);
    page.storageChange(APPEARANCE_KEY, null);
    expect(page.dataset).toEqual({ theme: 'default', mode: 'dark', density: 'compact' });
    page.storageChange(null, null);
    expect(page.storage.setItem).not.toHaveBeenCalled();
  });

  it('diagnoses and clears invalid startup preferences', () => {
    const page = browser('{"version":1,"theme":"missing","mode":"light"}');
    const controller = page.start();
    expect(page.dataset).toEqual({ theme: 'default', mode: 'light', density: 'compact' });
    expect(controller.getSnapshot().error).toContain('invalid');
    expect(page.storage.removeItem).toHaveBeenCalledWith(APPEARANCE_KEY);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('reports inaccessible storage and still applies in-memory changes', () => {
    const page = browser();
    page.storage.getItem.mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    page.storage.setItem.mockImplementation(() => {
      throw new DOMException('Quota', 'QuotaExceededError');
    });
    const controller = page.start();
    expect(controller.getSnapshot().error).toContain('unavailable');
    controller.setPreferences(autumnDark);
    expect(page.dataset).toEqual({ theme: 'autumn', mode: 'dark', density: 'comfortable' });
    expect(controller.getSnapshot().error).toContain('could not be saved');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('persists migrated preferences at startup and reports migration storage failures', () => {
    const old = '{"version":1,"theme":"autumn","mode":"dark"}';
    const page = browser(old);
    const controller = page.start();
    expect(page.stored.get(APPEARANCE_KEY)).toBe(
      JSON.stringify({
        ...autumnDark,
        density: 'compact',
      }),
    );
    expect(controller.getSnapshot().error).toBeNull();
    const denied = browser(old);
    denied.storage.setItem.mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    const inMemory = denied.start();
    expect(inMemory.getSnapshot().preferences).toEqual({ ...autumnDark, density: 'compact' });
    expect(inMemory.getSnapshot().error).toContain('could not be saved');
  });

  it('captures layout before density changes and restores before notifying subscribers', () => {
    const page = browser();
    const controller = page.start();
    const order: string[] = [];
    const unsubscribe = controller.beforeDensityChange(() => {
      order.push(`before:${page.dataset.density}`);
      return () => order.push(`after:${page.dataset.density}`);
    });
    controller.subscribe(() => order.push(`subscriber:${page.dataset.density}`));
    controller.setPreferences(autumnDark);
    expect(order).toEqual(['before:compact', 'after:comfortable', 'subscriber:comfortable']);
    order.length = 0;
    controller.setPreferences({ ...autumnDark, mode: 'light' });
    expect(order).toEqual(['subscriber:comfortable']);
    order.length = 0;
    page.storageChange(APPEARANCE_KEY, JSON.stringify({ ...autumnDark, density: 'compact' }));
    expect(order).toEqual(['before:comfortable', 'after:compact', 'subscriber:compact']);
    unsubscribe();
    order.length = 0;
    controller.setPreferences(autumnDark);
    expect(order).toEqual(['subscriber:comfortable']);
  });

  it('reports reset failures and invalid cross-tab values', () => {
    const page = browser();
    const controller = page.start();
    page.storage.removeItem.mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    page.storageChange(APPEARANCE_KEY, '{');
    expect(controller.getSnapshot().error).toContain('could not be cleared');
    expect(page.dataset.theme).toBe('default');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('does not swallow unexpected storage implementation errors', () => {
    const page = browser();
    page.storage.getItem.mockImplementation(() => {
      throw new Error('Unexpected bug');
    });
    expect(() => page.start()).toThrow('Unexpected bug');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('notifies subscribers, unsubscribes and cleans up all event listeners', () => {
    const page = browser();
    const controller = page.start();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.setPreferences(autumnDark);
    expect(listener).toHaveBeenCalledWith(controller.getSnapshot());
    unsubscribe();
    controller.setPreferences(DEFAULT_APPEARANCE);
    expect(listener).toHaveBeenCalledOnce();
    controller.dispose();
    expect(page.mediaListeners.size + page.storageListeners.size + page.domListeners.size).toBe(0);
  });

  it('shares the bootstrap controller with reactive settings and reports errors', () => {
    const page = browser('{');
    const controller = page.start();
    window.nanoclawAppearance = controller;
    expect(getAppearanceController()).toBe(controller);
    const onError = vi.fn();
    const unsubscribe = initAppearance(onError);
    expect(onError).toHaveBeenCalledOnce();
    setAppearance(autumnDark);
    expect(appearance.value).toEqual(controller.getSnapshot());
    expect(page.storage.getItem).toHaveBeenCalledOnce();
    expect(page.media.addEventListener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('renders native labeled radio groups, a browser-local hint and visible errors', () => {
    appearance.value = { preferences: autumnDark, resolvedMode: 'dark', error: 'Could not save' };
    const node = AppearanceSettings();
    const children = node.props.children;
    expect(node.props['aria-labelledby']).toBe('appearance-heading');
    expect(children[1].type).toBe('fieldset');
    expect(children[2].type).toBe('fieldset');
    expect(children[3].type).toBe('fieldset');
    expect(children[3].props.children[0].props.children).toBe('Text density');
    expect(children[4].type).toBe('fieldset');
    expect(children[4].props.children[0].props.children).toBe('Transcript details');
    expect(children[5].props.children[0]).toContain('saved in this browser');
    expect(children[6].props.role).toBe('alert');
    const cards = children[1].props.children[1].props.children;
    const autumnRadio = cards[1].props.children[0];
    expect(autumnRadio.props).toMatchObject({ type: 'radio', name: 'appearance-theme', checked: true });
    expect(children[1].props.children[2].props.children).toContain('warm copper');
    const densityOptions = children[3].props.children[1].props.children;
    expect(densityOptions[0].props.children[0].props).toMatchObject({
      type: 'radio',
      name: 'appearance-density',
      value: 'comfortable',
      checked: true,
    });
    expect(densityOptions[1].props.children[0].props.checked).toBe(false);
    expect(children[3].props.children[2].props.children).toContain('Larger text');
    expect(children[3].props.children).toHaveLength(3);
    const statusToggle = children[4].props.children[1];
    expect(statusToggle.props.children[1].props.children[0].props.children).toBe('Show technical information');
    const completedStatus = statusToggle.props.children[0];
    expect(completedStatus.props).toMatchObject({ type: 'checkbox', checked: false });
  });

  it('density selection preserves the theme and mode', () => {
    const page = browser(JSON.stringify(autumnDark));
    const controller = page.start();
    window.nanoclawAppearance = controller;
    appearance.value = controller.getSnapshot();
    const node = AppearanceSettings();
    const compact = node.props.children[3].props.children[1].props.children[1].props.children[0];
    compact.props.onChange();
    expect(controller.getSnapshot().preferences).toEqual({ ...autumnDark, density: 'compact' });
  });

  it('technical status selection preserves all other appearance preferences', () => {
    const page = browser(JSON.stringify(autumnDark));
    const controller = page.start();
    window.nanoclawAppearance = controller;
    appearance.value = controller.getSnapshot();
    const node = AppearanceSettings();
    const toggle = node.props.children[4].props.children[1].props.children[0];
    toggle.props.onChange();
    expect(controller.getSnapshot().preferences).toEqual({ ...autumnDark, showTechnicalStatus: true });
  });
});
