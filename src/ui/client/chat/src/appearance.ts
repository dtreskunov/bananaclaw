export const THEMES = [
  { id: 'default', name: 'Default', description: 'The original look' },
  { id: 'autumn', name: 'Autumn', description: 'Parchment, walnut and warm copper' },
] as const;

export const APPEARANCE_MODES = [
  { id: 'system', name: 'System' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]['id'];
export type ResolvedMode = Exclude<AppearanceMode, 'system'>;
export interface AppearancePreferences {
  version: 1;
  theme: ThemeId;
  mode: AppearanceMode;
}
export interface AppearanceSnapshot {
  preferences: AppearancePreferences;
  resolvedMode: ResolvedMode;
  error: string | null;
}

export const APPEARANCE_KEY = 'nanoclaw:appearance';
export const DEFAULT_APPEARANCE: AppearancePreferences = { version: 1, theme: 'default', mode: 'system' };

class InvalidAppearanceError extends Error {}

export function parseAppearance(raw: string | null): AppearancePreferences {
  if (raw === null) return { ...DEFAULT_APPEARANCE };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new InvalidAppearanceError('Invalid appearance preferences');
  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('theme' in value) ||
    !isThemeId(value.theme) ||
    !('mode' in value) ||
    !isAppearanceMode(value.mode)
  ) {
    throw new InvalidAppearanceError('Invalid appearance preferences');
  }
  return { version: 1, theme: value.theme, mode: value.mode };
}

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return APPEARANCE_MODES.some((mode) => mode.id === value);
}

function isStorageError(cause: unknown): cause is DOMException {
  return (
    cause instanceof DOMException && ['SecurityError', 'QuotaExceededError', 'InvalidStateError'].includes(cause.name)
  );
}

export function resolveMode(mode: AppearanceMode, systemDark: boolean): ResolvedMode {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

export interface AppearanceController {
  getSnapshot(): AppearanceSnapshot;
  setPreferences(preferences: AppearancePreferences): void;
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void;
  dispose(): void;
}

// The blocking head bundle owns the controller; the app subscribes to the same
// instance rather than reading storage again or installing duplicate listeners.
declare global {
  interface Window {
    nanoclawAppearance?: AppearanceController;
  }
}

export function createAppearanceController(win: Window, doc: Document): AppearanceController {
  const media = win.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set<(snapshot: AppearanceSnapshot) => void>();
  let preferences = { ...DEFAULT_APPEARANCE };
  let error: string | null = null;
  const brandedBrowserColor = doc.querySelector('meta[name="theme-color"]')?.getAttribute('content');

  function report(message: string, cause: unknown): void {
    console.warn(message, cause);
    error = message;
  }

  function read(raw: string | null): void {
    try {
      preferences = parseAppearance(raw);
    } catch (cause) {
      if (!(cause instanceof SyntaxError || cause instanceof InvalidAppearanceError)) throw cause;
      preferences = { ...DEFAULT_APPEARANCE };
      report('Saved appearance was invalid and has been reset to Default / System.', cause);
      try {
        win.localStorage.removeItem(APPEARANCE_KEY);
      } catch (storageError) {
        if (!isStorageError(storageError)) throw storageError;
        report('Saved appearance was invalid, but could not be cleared. Using Default / System for now.', storageError);
      }
    }
  }

  try {
    read(win.localStorage.getItem(APPEARANCE_KEY));
  } catch (cause) {
    if (!isStorageError(cause)) throw cause;
    report('Appearance storage is unavailable. Changes will apply only until this page is closed.', cause);
  }

  function getSnapshot(): AppearanceSnapshot {
    return { preferences: { ...preferences }, resolvedMode: resolveMode(preferences.mode, media.matches), error };
  }

  function updateBrowserColor(): void {
    const color = win.getComputedStyle(doc.documentElement).getPropertyValue('--browser-theme-color').trim();
    const next = color || brandedBrowserColor;
    if (next) doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', next);
  }

  function apply(): void {
    const snapshot = getSnapshot();
    doc.documentElement.dataset.theme = preferences.theme;
    doc.documentElement.dataset.mode = snapshot.resolvedMode;
    updateBrowserColor();
    for (const listener of listeners) listener(snapshot);
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== APPEARANCE_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== win.localStorage) return;
    } catch (cause) {
      if (!isStorageError(cause)) throw cause;
      report('Appearance could not be synchronized with another tab.', cause);
      apply();
      return;
    }
    error = null;
    read(event.key === null ? null : event.newValue);
    apply();
  }

  function onSystemChange(): void {
    if (preferences.mode === 'system') apply();
  }

  apply();
  media.addEventListener('change', onSystemChange);
  win.addEventListener('storage', onStorage);
  doc.addEventListener('DOMContentLoaded', updateBrowserColor, { once: true });

  return {
    getSnapshot,
    setPreferences(next) {
      preferences = parseAppearance(JSON.stringify(next));
      error = null;
      try {
        win.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(preferences));
      } catch (cause) {
        if (!isStorageError(cause)) throw cause;
        report('Appearance changed, but could not be saved. It may reset when you reload.', cause);
      }
      apply();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      media.removeEventListener('change', onSystemChange);
      win.removeEventListener('storage', onStorage);
      doc.removeEventListener('DOMContentLoaded', updateBrowserColor);
    },
  };
}

export function getAppearanceController(): AppearanceController {
  return (window.nanoclawAppearance ??= createAppearanceController(window, document));
}
