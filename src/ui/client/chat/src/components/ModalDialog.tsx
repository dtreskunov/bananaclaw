import type { ComponentProps } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { MobileDialog } from './MobileDialog';
import './ModalDialog.css';

export function ModalDialog(props: ComponentProps<typeof MobileDialog>) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
        if (document.activeElement !== previousFocus) {
          previousFocus.parentElement?.closest<HTMLElement>('[tabindex]')?.focus({ preventScroll: true });
        }
      }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class="modal-dialog-host chat-main"
      aria-label={props.ariaLabel ?? props.title}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!props.closeDisabled) props.onClose();
      }}
    >
      <MobileDialog {...props} role="presentation" />
    </dialog>
  );
}
