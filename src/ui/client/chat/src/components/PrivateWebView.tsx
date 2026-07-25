import './PrivateWebView.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { forwardedFragment } from '../private-web-fragment';

interface Props {
  groupId: string;
  path: string;
  title?: string;
  /** Launcher fragment forwarded to the app, e.g. `#url=...` from a bookmarklet. */
  fragment?: string;
}

interface IssuedSession {
  url: string;
  expiresAt: string;
}

export function PrivateWebView({ groupId, path, title, fragment }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setUrl(null);
    setError(null);
    fetch(`/ui/chat/api/groups/${encodeURIComponent(groupId)}/private-web-session`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          const next = window.location.pathname + window.location.search + window.location.hash;
          window.location.assign(`/ui/login?next=${encodeURIComponent(next)}`);
          return null;
        }
        if (!response.ok) throw new Error(response.status === 404 ? 'This page is no longer available.' : `Unable to open page (HTTP ${response.status}).`);
        return response.json() as Promise<IssuedSession>;
      })
      .then((issued) => {
        if (issued && !controller.signal.aborted) {
          refreshingRef.current = false;
          setUrl(issued.url + forwardedFragment(fragment));
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        refreshingRef.current = false;
        setError(reason instanceof Error ? reason.message : 'Unable to open page.');
      });
    return () => controller.abort();
  }, [groupId, path, fragment, revision]);

  useEffect(() => {
    if (!url) return undefined;
    const expectedOrigin = new URL(url).origin;
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== expectedOrigin || event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type !== 'nanoclaw-private-web-expired' || refreshingRef.current) return;
      refreshingRef.current = true;
      setRevision((value) => value + 1);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [url]);

  if (error) {
    return (
      <div class="private-web-view private-web-state" role="alert">
        <p>{error}</p>
        <button type="button" onClick={() => { refreshingRef.current = true; setRevision((value) => value + 1); }}>Try again</button>
      </div>
    );
  }
  if (!url) return <div class="private-web-view private-web-state" aria-busy="true">Loading page</div>;
  return (
    <div class="private-web-view">
      <iframe
        ref={frameRef}
        src={url}
        title={title || path}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'"
      />
    </div>
  );
}