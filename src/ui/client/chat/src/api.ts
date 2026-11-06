import { UI_PROTOCOL_HEADER, UI_TIMESTAMP_PROTOCOL_VERSION } from '../../../shared/time';

// HTTP helpers. Treats 401 as a global "not logged in" — redirects to
// the shared login page so the user can pick a sign-in provider.

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export function redirectToLogin(): void {
  const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  window.location.replace(`/ui/login?next=${next}`);
}

export class UiProtocolError extends Error {
  constructor() {
    super('The app and server versions do not match. Reload this page to update the app.');
    this.name = 'UiProtocolError';
  }
}

export const UI_RELOAD_EVENT = 'nanoclaw:ui-reload-required';

function isOwnedApi(url: string): boolean {
  if (/^https?:\/\//.test(url)) {
    const parsed = new URL(url);
    return (
      typeof window !== 'undefined' &&
      parsed.origin === window.location?.origin &&
      /^\/ui\/(?:chat|settings)\/api(?:\/|$)/.test(parsed.pathname)
    );
  }
  return /^(?:\/ui\/(?:chat|settings)\/)?api(?:\/|$)/.test(url);
}

export async function protocolFetch(url: string, opts?: RequestInit): Promise<Response> {
  const owned = isOwnedApi(url);
  const headers = new Headers(opts?.headers);
  if (owned) headers.set(UI_PROTOCOL_HEADER, String(UI_TIMESTAMP_PROTOCOL_VERSION));
  const response = await fetch(url, { credentials: 'same-origin', ...opts, headers });
  if (
    owned &&
    response.status !== 401 &&
    (response.ok || response.headers.get(UI_PROTOCOL_HEADER) !== null) &&
    response.headers.get(UI_PROTOCOL_HEADER) !== String(UI_TIMESTAMP_PROTOCOL_VERSION)
  ) {
    const error = new UiProtocolError();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(UI_RELOAD_EVENT));
    throw error;
  }
  return response;
}

export async function api<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  const r = await protocolFetch(url, opts);
  if (r.status === 401) {
    redirectToLogin();
    throw new UnauthorizedError();
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json() as Promise<T>;
}

export interface PostJsonResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
}

async function sendJson<T = Record<string, unknown>>(
  method: 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<PostJsonResult<T>> {
  const r = await protocolFetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = r.status === 204 ? ({} as T) : ((await r.json()) as T);
  return { ok: r.ok, status: r.status, data };
}

export async function postJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<PostJsonResult<T>> {
  return sendJson<T>('POST', path, body);
}

export async function patchJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<PostJsonResult<T>> {
  return sendJson<T>('PATCH', path, body);
}
