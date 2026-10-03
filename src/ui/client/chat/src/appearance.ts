export const THEMES = [
  { id: 'default', name: 'Default', description: 'The original look' },
  { id: 'autumn', name: 'Autumn', description: 'Parchment, walnut and warm copper' },
] as const;

export const APPEARANCE_MODES = [
  { id: 'system', name: 'System' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
] as const;

export const TEXT_DENSITIES = [
  { id: 'comfortable', name: 'Comfortable', description: 'Larger text and more breathing room.' },
  { id: 'compact', name: 'Compact', description: 'Smaller text and tighter spacing.' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]['id'];
export type TextDensity = (typeof TEXT_DENSITIES)[number]['id'];
export type ResolvedMode = Exclude<AppearanceMode, 'system'>;
export interface AppearancePreferences {
  version: 3;
  theme: ThemeId;
  mode: AppearanceMode;
  density: TextDensity;
  showTechnicalStatus: boolean;
}
export interface AppearanceSnapshot {
  preferences: AppearancePreferences;
  resolvedMode: ResolvedMode;
  error: string | null;
}

export const APPEARANCE_KEY = 'nanoclaw:appearance';
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 3,
  theme: 'default',
  mode: 'system',
  density: 'compact',
  showTechnicalStatus: false,
};

class InvalidAppearanceError extends Error {}

export function parseAppearance(raw: string | null): AppearancePreferences {
  if (raw === null) return { ...DEFAULT_APPEARANCE };
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new InvalidAppearanceError('Invalid appearance preferences');
  if (
    !('version' in value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    !('theme' in value) ||
    !isThemeId(value.theme) ||
    !('mode' in value) ||
    !isAppearanceMode(value.mode) ||
    (value.version >= 2 && (!('density' in value) || !isTextDensity(value.density))) ||
    (value.version === 3 && (!('showTechnicalStatus' in value) || typeof value.showTechnicalStatus !== 'boolean'))
  ) {
    throw new InvalidAppearanceError('Invalid appearance preferences');
  }
  return {
    version: 3,
    theme: value.theme,
    mode: value.mode,
    density: value.version >= 2 && 'density' in value && isTextDensity(value.density) ? value.density : 'compact',
    showTechnicalStatus:
      value.version === 3 && 'showTechnicalStatus' in value ? (value.showTechnicalStatus as boolean) : false,
  };
}

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

function isAppearanceMode(value: unknown): value is AppearanceMode {
  return APPEARANCE_MODES.some((mode) => mode.id === value);
}

function isTextDensity(value: unknown): value is TextDensity {
  return TEXT_DENSITIES.some((density) => density.id === value);
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
  // Capture layout before the CSS changes; the returned callback restores it.
  beforeDensityChange(listener: () => () => void): () => void;
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
  const densityListeners = new Set<() => () => void>();
  let preferences = { ...DEFAULT_APPEARANCE };
  let error: string | null = null;
  const brandedBrowserColor = doc.querySelector('meta[name="theme-color"]')?.getAttribute('content');

  function report(message: string, cause: unknown): void {
    console.warn(message, cause);
    error = message;
  }

  function read(raw: string | null, persistMigration = false): void {
    try {
      preferences = parseAppearance(raw);
    } catch (cause) {
      if (!(cause instanceof SyntaxError || cause instanceof InvalidAppearanceError)) throw cause;
      preferences = { ...DEFAULT_APPEARANCE };
      report('Saved appearance was invalid and has been reset to the defaults.', cause);
      try {
        win.localStorage.removeItem(APPEARANCE_KEY);
      } catch (storageError) {
        if (!isStorageError(storageError)) throw storageError;
        report('Saved appearance was invalid, but could not be cleared. Using the defaults for now.', storageError);
      }
      return;
    }
    if (persistMigration && raw !== null && JSON.stringify(preferences) !== raw) {
      try {
        win.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(preferences));
      } catch (cause) {
        if (!isStorageError(cause)) throw cause;
        report(
          'Appearance was upgraded, but could not be saved. Changes will apply only until this page is closed.',
          cause,
        );
      }
    }
  }

  try {
    read(win.localStorage.getItem(APPEARANCE_KEY), true);
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
    const restoreDensity =
      doc.documentElement.dataset.density !== preferences.density
        ? Array.from(densityListeners, (listener) => listener())
        : [];
    doc.documentElement.dataset.theme = preferences.theme;
    doc.documentElement.dataset.mode = snapshot.resolvedMode;
    doc.documentElement.dataset.density = preferences.density;
    updateBrowserColor();
    for (const restore of restoreDensity) restore();
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
    beforeDensityChange(listener) {
      densityListeners.add(listener);
      return () => {
        densityListeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      densityListeners.clear();
      media.removeEventListener('change', onSystemChange);
      win.removeEventListener('storage', onStorage);
      doc.removeEventListener('DOMContentLoaded', updateBrowserColor);
    },
  };
}

export function getAppearanceController(): AppearanceController {
  return (window.nanoclawAppearance ??= createAppearanceController(window, document));
}
