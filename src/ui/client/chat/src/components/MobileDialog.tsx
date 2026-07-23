import './MobileDialog.css';
import type { ComponentChildren, JSX } from 'preact';

interface MobileDialogProps {
  title: string;
  ariaLabel?: string;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  actions?: ComponentChildren;
  children: ComponentChildren;
  className?: string;
  backdropClassName?: string;
  maxWidth?: string;
  closeDisabled?: boolean;
  role?: 'dialog' | 'alertdialog';
  onKeyDown?: (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
}

export function MobileDialog(props: MobileDialogProps): JSX.Element {
  const {
    title, ariaLabel, onClose, onBack, backLabel = 'Back', actions, children,
    className, backdropClassName, maxWidth, closeDisabled, role = 'dialog', onKeyDown,
  } = props;
  const onBackdrop = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget && !closeDisabled) onClose();
  };

  return (
    <div
      class={`mobile-dialog-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`}
      onClick={onBackdrop}
      onKeyDown={onKeyDown}
      tabIndex={onKeyDown ? -1 : undefined}
    >
      <div
        class={`mobile-dialog${className ? ` ${className}` : ''}`}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        style={maxWidth ? `max-width:${maxWidth}` : undefined}
      >
        <header class="mobile-dialog-head">
          {onBack ? (
            <button type="button" class="mobile-dialog-icon" aria-label={backLabel} onClick={onBack}>
              {'\u2039'}
            </button>
          ) : null}
          <span class="mobile-dialog-title">{title}</span>
          {actions ? <div class="mobile-dialog-actions">{actions}</div> : null}
          <button type="button" class="mobile-dialog-icon" aria-label="Close" disabled={closeDisabled} onClick={onClose}>{'\u2715'}</button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function MobileDialogList({ children, className }: { children: ComponentChildren; className?: string }): JSX.Element {
  return <div class={`mobile-dialog-list${className ? ` ${className}` : ''}`}>{children}</div>;
}

interface MobileDialogItemProps {
  label: string;
  sublabel?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  active?: boolean;
  chevron?: boolean;
  title?: string;
  className?: string;
}

export function MobileDialogItem(props: MobileDialogItemProps): JSX.Element {
  const { label, sublabel, onClick, type = 'button', active, chevron, title, className } = props;
  return (
    <button
      type={type}
      class={`mobile-dialog-item${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      aria-current={active ? 'true' : undefined}
      title={title}
      onClick={onClick}
    >
      <span class="mobile-dialog-item-label">{label}</span>
      {sublabel ? <span class="mobile-dialog-item-sublabel">{sublabel}</span> : null}
      {chevron ? <span class="mobile-dialog-item-chevron" aria-hidden="true">{'\u203A'}</span> : null}
    </button>
  );
}

export function MobileDialogDivider(): JSX.Element {
  return <div class="mobile-dialog-divider" aria-hidden="true" />;
}

export function MobileDialogFooter({ children, className }: { children: ComponentChildren; className?: string }): JSX.Element {
  return <footer class={`mobile-dialog-footer${className ? ` ${className}` : ''}`}>{children}</footer>;
}