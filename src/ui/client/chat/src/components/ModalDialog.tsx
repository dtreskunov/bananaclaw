import type { ComponentProps } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { MobileDialog } from './MobileDialog';
import './ModalDialog.css';

type Props = ComponentProps<typeof MobileDialog> & {
  initialFocus?: string;
  returnFocus?: HTMLElement | null;
  onAfterClose?: () => void;
};

export function ModalDialog({ initialFocus, returnFocus, onAfterClose, ...props }: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = returnFocus ?? document.activeElement;
    dialog.showModal();
    if (initialFocus) dialog.querySelector<HTMLElement>(initialFocus)?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
        if (document.activeElement !== previousFocus) {
          previousFocus.parentElement?.closest<HTMLElement>('[tabindex]')?.focus({ preventScroll: true });
        }
      }
      onAfterClose?.();
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
