"use strict";
(() => {
  // src/appearance.ts
  var THEMES = [
    { id: "default", name: "Default", description: "The original look" },
    { id: "autumn", name: "Autumn", description: "Parchment, walnut and warm copper" }
  ];
  var APPEARANCE_MODES = [
    { id: "system", name: "System" },
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" }
  ];
  var APPEARANCE_KEY = "nanoclaw:appearance";
  var DEFAULT_APPEARANCE = { version: 1, theme: "default", mode: "system" };
  var InvalidAppearanceError = class extends Error {
  };
  function parseAppearance(raw) {
    if (raw === null) return { ...DEFAULT_APPEARANCE };
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new InvalidAppearanceError("Invalid appearance preferences");
    if (!("version" in value) || value.version !== 1 || !("theme" in value) || !isThemeId(value.theme) || !("mode" in value) || !isAppearanceMode(value.mode)) {
      throw new InvalidAppearanceError("Invalid appearance preferences");
    }
    return { version: 1, theme: value.theme, mode: value.mode };
  }
  function isThemeId(value) {
    return THEMES.some((theme) => theme.id === value);
  }
  function isAppearanceMode(value) {
    return APPEARANCE_MODES.some((mode) => mode.id === value);
  }
  function isStorageError(cause) {
    return cause instanceof DOMException && ["SecurityError", "QuotaExceededError", "InvalidStateError"].includes(cause.name);
  }
  function resolveMode(mode, systemDark) {
    return mode === "system" ? systemDark ? "dark" : "light" : mode;
  }
  function createAppearanceController(win, doc) {
    const media = win.matchMedia("(prefers-color-scheme: dark)");
    const listeners = /* @__PURE__ */ new Set();
    let preferences = { ...DEFAULT_APPEARANCE };
    let error = null;
    const brandedBrowserColor = doc.querySelector('meta[name="theme-color"]')?.getAttribute("content");
    function report(message, cause) {
      console.warn(message, cause);
      error = message;
    }
    function read(raw) {
      try {
        preferences = parseAppearance(raw);
      } catch (cause) {
        if (!(cause instanceof SyntaxError || cause instanceof InvalidAppearanceError)) throw cause;
        preferences = { ...DEFAULT_APPEARANCE };
        report("Saved appearance was invalid and has been reset to Default / System.", cause);
        try {
          win.localStorage.removeItem(APPEARANCE_KEY);
        } catch (storageError) {
          if (!isStorageError(storageError)) throw storageError;
          report("Saved appearance was invalid, but could not be cleared. Using Default / System for now.", storageError);
        }
      }
    }
    try {
      read(win.localStorage.getItem(APPEARANCE_KEY));
    } catch (cause) {
      if (!isStorageError(cause)) throw cause;
      report("Appearance storage is unavailable. Changes will apply only until this page is closed.", cause);
    }
    function getSnapshot() {
      return { preferences: { ...preferences }, resolvedMode: resolveMode(preferences.mode, media.matches), error };
    }
    function updateBrowserColor() {
      const color = win.getComputedStyle(doc.documentElement).getPropertyValue("--browser-theme-color").trim();
      const next = color || brandedBrowserColor;
      if (next) doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", next);
    }
    function apply() {
      const snapshot = getSnapshot();
      doc.documentElement.dataset.theme = preferences.theme;
      doc.documentElement.dataset.mode = snapshot.resolvedMode;
      updateBrowserColor();
      for (const listener of listeners) listener(snapshot);
    }
    function onStorage(event) {
      if (event.key !== APPEARANCE_KEY && event.key !== null) return;
      try {
        if (event.storageArea !== win.localStorage) return;
      } catch (cause) {
        if (!isStorageError(cause)) throw cause;
        report("Appearance could not be synchronized with another tab.", cause);
        apply();
        return;
      }
      error = null;
      read(event.key === null ? null : event.newValue);
      apply();
    }
    function onSystemChange() {
      if (preferences.mode === "system") apply();
    }
    apply();
    media.addEventListener("change", onSystemChange);
    win.addEventListener("storage", onStorage);
    doc.addEventListener("DOMContentLoaded", updateBrowserColor, { once: true });
    return {
      getSnapshot,
      setPreferences(next) {
        preferences = parseAppearance(JSON.stringify(next));
        error = null;
        try {
          win.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(preferences));
        } catch (cause) {
          if (!isStorageError(cause)) throw cause;
          report("Appearance changed, but could not be saved. It may reset when you reload.", cause);
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
        media.removeEventListener("change", onSystemChange);
        win.removeEventListener("storage", onStorage);
        doc.removeEventListener("DOMContentLoaded", updateBrowserColor);
      }
    };
  }
  function getAppearanceController() {
    return window.nanoclawAppearance ??= createAppearanceController(window, document);
  }

  // src/appearance-bootstrap.ts
  getAppearanceController();
})();
