import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { captureReadingPosition } from '../density-reflow';
import { observeMessagePreview, type MessagePreviewLayout } from '../message-preview';
import { CopyTranscriptButton } from './CopyTranscriptButton';
import { ModalDialog } from './ModalDialog';
import './MessagePreview.css';

interface Props {
  children: ComponentChildren;
  reveal?: boolean;
}

function MessageReader({
  children,
  bubbleClass,
  opener,
  onClose,
  onNavigate,
  onAfterClose,
}: {
  children: ComponentChildren;
  bubbleClass: string;
  opener: HTMLElement | null;
  onClose: () => void;
  onNavigate: () => void;
  onAfterClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState('');
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const match = body?.querySelector<HTMLElement>('.search-hl');
    if (body && match) {
      body.scrollTop += match.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 2;
    }
  }, []);
  const onClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) return;
    if ((event.defaultPrevented && event.target.closest('a')) || event.target.closest('button.file-chip')) onNavigate();
  };
  return (
    <ModalDialog
      title="Message"
      ariaLabel="Full message"
      className="message-reader-dialog"
      backdropClassName="message-reader-backdrop"
      maxWidth="min(960px, 100%)"
      initialFocus=".message-reader-body"
      returnFocus={opener}
      onClose={onClose}
      onAfterClose={onAfterClose}
      actions={
        <>
          <span class="message-reader-feedback" role="status">
            {feedback}
          </span>
          <CopyTranscriptButton
            label="Copy message"
            onFeedback={setFeedback}
            getContent={() =>
              bodyRef.current?.querySelector<HTMLElement>('.transcript-copy-content') ?? bodyRef.current
            }
          />
        </>
      }
    >
      <div class="message-reader-body" ref={bodyRef} tabIndex={0} onClick={onClick}>
        <div class={`${bubbleClass} message-reader-message`}>{children}</div>
      </div>
    </ModalDialog>
  );
}

export function MessagePreview({ children, reveal = false }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<() => void>(() => {});
  const autoOpenedRef = useRef(false);
  const [layout, setLayout] = useState<MessagePreviewLayout>({ truncated: false, height: 0 });
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!ref.current) return;
    return observeMessagePreview(ref.current, (next) => {
      setLayout((previous) =>
        previous.truncated === next.truncated && Math.abs(previous.height - next.height) < 0.5 ? previous : next,
      );
    });
  }, []);
  const openReader = (): void => {
    const viewport = ref.current?.closest<HTMLElement>('.log');
    if (viewport) restoreRef.current = captureReadingPosition(viewport, false);
    setOpen(true);
  };
  useEffect(() => {
    if (!reveal) autoOpenedRef.current = false;
    else if (layout.truncated && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      openReader();
    }
  }, [reveal, layout.truncated]);
  return (
    <div class="message-preview" ref={ref} data-truncated={layout.truncated}>
      <div class="message-preview-clip" style={layout.truncated ? { maxHeight: `${layout.height}px` } : undefined}>
        <div class="message-preview-content" inert={layout.truncated}>
          {children}
        </div>
      </div>
      <div class="message-preview-control" hidden={!layout.truncated}>
        <button type="button" ref={buttonRef} class="message-preview-open" aria-haspopup="dialog" onClick={openReader}>
          Read full message
        </button>
      </div>
      {open ? (
        <MessageReader
          bubbleClass={ref.current?.closest('.msg')?.className ?? 'msg'}
          opener={buttonRef.current}
          onClose={() => setOpen(false)}
          onNavigate={() => {
            restoreRef.current = () => {};
            setOpen(false);
          }}
          onAfterClose={() => restoreRef.current()}
        >
          {children}
        </MessageReader>
      ) : null}
    </div>
  );
}
