export function apiPath(gid: string, sub: string): string {
  return `/ui/chat/api/groups/${encodeURIComponent(gid)}/admin${sub}`;
}

export function settingsPatch(draft: object, pending: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(draft).filter(([key]) => pending.has(key)));
}

export async function call<T>(
  url: string,
  method: string = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await protocolFetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: T = {} as T;
  try {
    data = (await r.json()) as T;
  } catch {
    /* non-JSON */
  }
  return { ok: r.ok, status: r.status, data };
}

export function errMsg(d: unknown, fallback: string): string {
  const e = (d as { error?: unknown })?.error;
  return typeof e === 'string' && e ? e : fallback;
}
import { protocolFetch } from '../api';
