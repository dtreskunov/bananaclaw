// HTTP helpers. Treats 401 as a global "not logged in" — redirects to
// the shared login page so the user can pick a sign-in provider.

export async function api<T = unknown>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  if (r.status === 401) {
    const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    window.location.replace(`/ui/login?next=${next}`);
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json() as Promise<T>;
}

export interface PostJsonResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
}

export async function postJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<PostJsonResult<T>> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data: T = {} as T;
  try {
    data = (await r.json()) as T;
  } catch {
    /* ignore non-JSON */
  }
  return { ok: r.ok, status: r.status, data };
}

export async function patchJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<PostJsonResult<T>> {
  const r = await fetch(path, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data: T = {} as T;
  try {
    data = (await r.json()) as T;
  } catch {
    /* ignore non-JSON */
  }
  return { ok: r.ok, status: r.status, data };
}
