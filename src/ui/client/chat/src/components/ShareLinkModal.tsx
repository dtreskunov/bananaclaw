// Modal for "Share with link".
import './Settings.css';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { shareModalRequest } from '../state';
import { postJson } from '../api';
import { showToast } from './Toast';
import { MobileDialog } from './MobileDialog';

const DURATIONS: { label: string; minutes: number }[] = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 60 * 24 },
  { label: '7 days', minutes: 60 * 24 * 7 },
];

interface ShareTokenResponse {
  url: string;
  expiresAt: string;
  ttlMinutes: number;
  uses: number;
  error?: string;
}

export function ShareLinkModal() {
  const req = shareModalRequest.value;
  const [ttl, setTtl] = useState(60);
  const [uses, setUses] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShareTokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!req) return;
    setTtl(60);
    setUses(1);
    setBusy(false);
    setResult(null);
    setError(null);
  }, [req?.entry?.path, req?.groupId]);

  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  if (!req) return null;
  const { groupId, entry } = req;
  const title = entry?.name || (entry?.path || '').slice((entry?.path || '').lastIndexOf('/') + 1);

  function close(): void { shareModalRequest.value = null; }

  async function mint(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<ShareTokenResponse>(`api/groups/${encodeURIComponent(groupId)}/share-token`, {
        path: entry.path,
        ttlMinutes: ttl,
        uses,
      });
      if (!r.ok) {
        setError(r.data.error || `HTTP ${r.status}`);
        return;
      }
      setResult(r.data);
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!result?.url) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(result.url);
      ok = true;
    } catch {
      if (urlRef.current) {
        urlRef.current.select();
        try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      }
    }
    showToast(ok ? 'Link copied' : 'Copy failed', ok ? 'ok' : 'err');
  }

  async function shareSystem(): Promise<void> {
    const navAny = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (!result?.url || !navAny.share) return;
    try { await navAny.share({ title, url: result.url }); } catch (err) {
      if (err && (err as { name?: string }).name !== 'AbortError') setError(String(err));
    }
  }

  const expiresLabel = result?.expiresAt ? new Date(result.expiresAt).toLocaleString() : null;
  const navAny = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };

  return (
    <MobileDialog title="Share with link" onClose={close} maxWidth="520px">
        <div class="settings-body">
          <p class="muted" style="margin-top:0">
            Anyone with this link can download <code>{title}</code> until it expires
            or the use count is exhausted. No sign-in required.
          </p>

          {result ? (
            <section>
              <h3>Link ready</h3>
              <div class="settings-row">
                <input
                  ref={urlRef}
                  type="text"
                  readonly
                  value={result.url}
                  onClick={(e: JSX.TargetedMouseEvent<HTMLInputElement>) => e.currentTarget.select()}
                />
              </div>
              <p class="muted">
                Valid for {result.ttlMinutes} min{expiresLabel ? ` (until ${expiresLabel})` : ''},
                {' '}{result.uses} download{result.uses === 1 ? '' : 's'}.
              </p>
              <div class="settings-row">
                <button type="button" onClick={copy}>Copy link</button>
                {(navAny as unknown as { share?: unknown }).share ? <button type="button" class="ghost" onClick={shareSystem}>Share{'\u2026'}</button> : null}
                <button type="button" class="ghost" onClick={() => setResult(null)}>Mint another</button>
              </div>
            </section>
          ) : (
            <section>
              <h3>Valid for</h3>
              <div class="settings-row">
                <select value={ttl} onChange={(e: JSX.TargetedEvent<HTMLSelectElement>) => setTtl(Number(e.currentTarget.value))}>
                  {DURATIONS.map((d) => <option value={d.minutes} key={d.minutes}>{d.label}</option>)}
                </select>
                <span class="muted">or custom (minutes):</span>
                <input
                  type="number"
                  min={1}
                  max={10080}
                  value={ttl}
                  onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setTtl(Math.max(1, Math.min(10080, Number(e.currentTarget.value) || 1)))}
                />
              </div>
              <p class="muted">Maximum 7 days (10080 minutes).</p>

              <h3>Number of downloads</h3>
              <div class="settings-row">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={uses}
                  onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setUses(Math.max(1, Math.min(100, Number(e.currentTarget.value) || 1)))}
                />
                <button type="button" class="ghost" onClick={() => setUses(1)} disabled={uses === 1}>Single use</button>
              </div>
              <p class="muted">Maximum 100. The link stops working once exhausted.</p>
            </section>
          )}

          {error ? <div class="settings-status err">{error}</div> : null}
        </div>
        <div class="settings-row" style="padding:10px 16px;border-top:1px solid var(--border);justify-content:flex-end">
          {result
            ? <button type="button" onClick={close}>Done</button>
            : (
              <>
                <button type="button" class="ghost" onClick={close} disabled={busy}>Cancel</button>
                <button type="button" onClick={mint} disabled={busy}>{busy ? 'Creating\u2026' : 'Create link'}</button>
              </>
            )}
        </div>
    </MobileDialog>
  );
}
