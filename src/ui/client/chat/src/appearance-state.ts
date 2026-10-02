import { signal } from '@preact/signals';
import { DEFAULT_APPEARANCE, getAppearanceController } from './appearance';
import type { AppearanceSnapshot, AppearancePreferences } from './appearance';

export const appearance = signal<AppearanceSnapshot>({
  preferences: { ...DEFAULT_APPEARANCE },
  resolvedMode: 'light',
  error: null,
});

export function initAppearance(onError: (message: string) => void): () => void {
  const controller = getAppearanceController();
  const update = (snapshot: AppearanceSnapshot): void => {
    const previousError = appearance.value.error;
    appearance.value = snapshot;
    if (snapshot.error && snapshot.error !== previousError) onError(snapshot.error);
  };
  update(controller.getSnapshot());
  return controller.subscribe(update);
}

export function setAppearance(preferences: AppearancePreferences): void {
  getAppearanceController().setPreferences(preferences);
}
