// Hook: tie a modal's open/close state to the browser back button.
//
// When `open` becomes true, we push a history entry so a back button press
// fires popstate. We listen for popstate and call onClose. When the user
// closes the modal some other way (X button, Escape, backdrop click), we
// consume the entry we pushed via history.back() so the back stack stays
// clean.
//
// Without this, mobile users have no obvious way to dismiss a modal that
// fills the screen — and "back" feels like the natural gesture.
import { useEffect, useRef } from 'preact/hooks';

const MARKER = '__modal_back__';

export function useBackButtonCloses(open: boolean, onClose: () => void): void {
  // Tracks whether *we* pushed a history entry that hasn't been consumed
  // yet. We use a ref (not state) so the popstate listener captures the
  // current value without re-binding on every render.
  const pushedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      // Modal closed by the parent (e.g. via X / Escape / backdrop). If
      // we pushed an entry, pop it back so the history stack stays clean.
      if (pushedRef.current) {
        pushedRef.current = false;
        // Skip our own popstate handler — there's nothing more to do.
        // history.back() fires popstate asynchronously, and our listener
        // is already torn down by then.
        history.back();
      }
      return undefined;
    }

    // Push an entry so the next back press triggers popstate. Reuse the
    // current URL so we don't disturb the chat app's hash routing.
    history.pushState({ ...history.state, [MARKER]: true }, '', location.href);
    pushedRef.current = true;

    const onPop = (): void => {
      // The user pressed back (or forward into our slot). Either way the
      // entry we pushed is no longer in the stack — drop the bookkeeping
      // flag so we don't try to consume it again on the next render.
      pushedRef.current = false;
      onClose();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);
}
