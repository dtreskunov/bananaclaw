export function apiPath(gid: string, sub: string): string {
  return `/ui/chat/api/groups/${encodeURIComponent(gid)}/admin${sub}`;
}

export async function call<T>(
  url: string,
  method: string = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, {
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
