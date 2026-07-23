// Quick Capture — in-page camera using getUserMedia.
// Sidesteps the Android Camera Intent (which OOMs on some devices when
// transferring full-sensor JPEGs back to the browser). Live preview at a
// constrained resolution, one-tap shutter, then retake / use. JPEG-encoded
// to keep size small.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { MobileDialog } from './MobileDialog';

interface Props {
  onCapture: (file: File) => void;
  onClose: () => void;
}

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 960;
const JPEG_QUALITY = 0.85;

export function QuickCapture({ onCapture, onClose }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');

  // Acquire camera stream. Re-runs when the user flips between front/back.
  useEffect(() => {
    let cancelled = false;
    const start = async (): Promise<void> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: CAPTURE_WIDTH },
            height: { ideal: CAPTURE_HEIGHT },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.play().catch(() => undefined);
        }
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setError('Camera permission denied');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setError('No camera available');
        } else {
          setError('Could not start camera');
        }
      }
    };
    start();
    return () => {
      cancelled = true;
      const s = streamRef.current;
      if (s) {
        s.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [facing]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shoot = async (): Promise<void> => {
    const v = videoRef.current;
    if (!v || busy) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return;
    setBusy(true);
    try {
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = (canvas as OffscreenCanvas | HTMLCanvasElement).getContext('2d') as
        | OffscreenCanvasRenderingContext2D
        | CanvasRenderingContext2D
        | null;
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(v, 0, 0, w, h);
      let blob: Blob | null = null;
      if (canvas instanceof OffscreenCanvas) {
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
      } else {
        blob = await new Promise<Blob | null>((resolve) =>
          (canvas as HTMLCanvasElement).toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
        );
      }
      if (!blob) throw new Error('encode failed');
      if (preview) URL.revokeObjectURL(preview.url);
      setPreview({ url: URL.createObjectURL(blob), blob });
    } catch (err) {
      setError((err as Error).message || 'Capture failed');
    } finally {
      setBusy(false);
    }
  };

  const retake = (): void => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const use = (): void => {
    if (!preview) return;
    const file = new File([preview.blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
    setPreview(null);
    URL.revokeObjectURL(preview.url);
    onCapture(file);
  };

  // Label names what the button will switch *to*, matching native camera-app
  // convention (e.g. "Front camera" while the back is active).
  const flip = (): void => setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
  const flipTarget = facing === 'environment' ? 'Front camera' : 'Back camera';

  return (
    <MobileDialog
      title="Quick capture"
      onClose={onClose}
      maxWidth="720px"
      backdropClassName="qcap-backdrop"
      className="qcap-modal"
    >
        <div class="qcap-stage">
          {error ? (
            <div class="qcap-error">{error}</div>
          ) : preview ? (
            <img class="qcap-preview" src={preview.url} alt="" />
          ) : (
            <video
              class={'qcap-video' + (facing === 'user' ? ' mirror' : '')}
              ref={videoRef}
              playsInline
              muted
              autoplay
            />
          )}
        </div>
        <div class="qcap-controls">
          {error ? (
            <button type="button" class="qcap-btn" onClick={onClose}>Close</button>
          ) : preview ? (
            <>
              <button type="button" class="qcap-btn" onClick={retake}>Retake</button>
              <button type="button" class="qcap-btn primary" onClick={use}>Use photo</button>
            </>
          ) : (
            <>
              <button
                type="button"
                class="qcap-flip"
                onClick={flip}
                aria-label={`Switch to ${flipTarget.toLowerCase()}`}
                title={`Switch to ${flipTarget.toLowerCase()}`}
              >
                <span class="qcap-flip-ico" aria-hidden="true">{'\u21BB'}</span>
                <span class="qcap-flip-lbl">{flipTarget}</span>
              </button>
              <button type="button" class="qcap-shutter" onClick={shoot} disabled={busy} aria-label="Capture" />
              <span class="qcap-spacer" />
            </>
          )}
        </div>
    </MobileDialog>
  );
}
