/**
 * UI branding (white-label) configuration.
 *
 * Reads operator-defined brand strings from .env / process.env and exposes
 * them to the server-rendered HTML / manifest / service worker as well as
 * to the bundled chat client (via a `window.__BRAND__` global injected
 * into index.html).
 *
 * Env vars (all optional — defaults reproduce the stock "NanoClaw" brand):
 *   UI_BRAND_NAME              Display name, e.g. "BananaClaw"
 *   UI_BRAND_SHORT_NAME        Short name for installed PWA (defaults to name)
 *   UI_BRAND_DESCRIPTION       Manifest description
 *   UI_BRAND_THEME_COLOR       CSS color for theme-color meta + manifest
 *   UI_BRAND_BACKGROUND_COLOR  Manifest background_color
 *   UI_BRAND_ICON_DIR          Absolute path to a directory containing
 *                              replacement icon.svg / icon-192.png /
 *                              icon-512.png / icon-maskable-512.png. Files
 *                              not present in that dir fall back to the
 *                              bundled defaults.
 *
 * Changes require a host restart (values are cached for the process
 * lifetime). The chat client's bundled JS does not need to be rebuilt —
 * components read the brand from `window.__BRAND__` at runtime.
 */
import { readEnvFile } from '../../env.js';

const ENV_KEYS = [
  'UI_BRAND_NAME',
  'UI_BRAND_SHORT_NAME',
  'UI_BRAND_DESCRIPTION',
  'UI_BRAND_THEME_COLOR',
  'UI_BRAND_BACKGROUND_COLOR',
  'UI_BRAND_ICON_DIR',
];

export interface Branding {
  name: string;
  shortName: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
  /** Absolute directory holding icon overrides, or null. */
  iconDir: string | null;
}

const DEFAULTS: Branding = {
  name: 'NanoClaw',
  shortName: 'NanoClaw',
  description: 'Personal Claude assistant — chat with your agent from any browser or installed device.',
  themeColor: '#151515',
  backgroundColor: '#0d1117',
  iconDir: null,
};

let cached: Branding | null = null;

export function getBranding(): Branding {
  if (cached) return cached;
  const env = readEnvFile(ENV_KEYS);
  const pick = (k: string): string | undefined => process.env[k] || env[k] || undefined;
  const name = pick('UI_BRAND_NAME') || DEFAULTS.name;
  cached = {
    name,
    shortName: pick('UI_BRAND_SHORT_NAME') || name,
    description: pick('UI_BRAND_DESCRIPTION') || DEFAULTS.description,
    themeColor: pick('UI_BRAND_THEME_COLOR') || DEFAULTS.themeColor,
    backgroundColor: pick('UI_BRAND_BACKGROUND_COLOR') || DEFAULTS.backgroundColor,
    iconDir: pick('UI_BRAND_ICON_DIR') || null,
  };
  return cached;
}

/** Test-only seam. */
export function _resetBrandingCache(): void {
  cached = null;
}

/** Replace `{{BRAND_*}}` tokens in a string with current brand values. */
export function applyBrandTokens(input: string): string {
  const b = getBranding();
  return input
    .replace(/\{\{BRAND_NAME\}\}/g, b.name)
    .replace(/\{\{BRAND_SHORT_NAME\}\}/g, b.shortName)
    .replace(/\{\{BRAND_DESCRIPTION\}\}/g, b.description)
    .replace(/\{\{BRAND_THEME_COLOR\}\}/g, b.themeColor)
    .replace(/\{\{BRAND_BACKGROUND_COLOR\}\}/g, b.backgroundColor);
}

/** Escape a string for safe embedding inside a JSON string literal in HTML. */
function jsonEscape(s: string): string {
  return JSON.stringify(s);
}

/** A `<script>` snippet that publishes the brand to the chat client. */
export function brandBootstrapScript(): string {
  const b = getBranding();
  const payload =
    `{"name":${jsonEscape(b.name)},` +
    `"shortName":${jsonEscape(b.shortName)},` +
    `"description":${jsonEscape(b.description)},` +
    `"themeColor":${jsonEscape(b.themeColor)},` +
    `"backgroundColor":${jsonEscape(b.backgroundColor)}}`;
  return `<script>window.__BRAND__=${payload};</script>`;
}
