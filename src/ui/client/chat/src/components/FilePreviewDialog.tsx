import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useBackButtonCloses } from '../modalBackButton';
import { MobileDialog } from './MobileDialog';
import './FilePreviewDialog.css';

interface Props {
  expanded: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}

export function FilePreviewDialog({ expanded, title, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useBackButtonCloses(expanded, onClose);
  // Changing modality, rather than remounting, preserves media, iframe and editor state.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (expanded) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.close();
      dialog.showModal();
    } else if (dialog.matches(':modal')) {
      dialog.close();
      dialog.show();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [expanded]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      dialog?.close();
    };
  }, []);
  const stopModalEvent = (event: Event): void => {
    if (expanded) event.stopPropagation();
  };
  return (
    <dialog
      ref={ref}
      open
      class={`file-preview-host${expanded ? ' is-expanded' : ''}`}
      role={expanded ? 'dialog' : 'presentation'}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `Full screen preview: ${title}` : undefined}
      onClick={stopModalEvent}
      onWheel={stopModalEvent}
      onTouchMove={stopModalEvent}
      onPointerDown={stopModalEvent}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (expanded) onClose();
      }}
    >
      <MobileDialog
        title={title}
        onClose={onClose}
        role="presentation"
        className="file-preview-panel"
        backdropClassName="file-preview-backdrop"
        maxWidth="1280px"
      >
        {children}
      </MobileDialog>
    </dialog>
  );
}
