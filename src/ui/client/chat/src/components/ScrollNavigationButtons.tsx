import './ChatMain.css';
import type { ScrollDirection } from '../scroll-navigation';

interface Props {
  direction: ScrollDirection | null;
  newMessageBelow: boolean;
  onTop: () => void;
  onBottom: () => void;
}

export function ScrollNavigationButtons({ direction, newMessageBelow, onTop, onBottom }: Props) {
  return (
    <>
      <button
        type="button"
        class="scroll-jump scroll-to-top"
        data-instant-hide={direction === 'down'}
        data-visible={direction === 'up'}
        aria-hidden={direction !== 'up'}
        disabled={direction !== 'up'}
        title="Scroll to top"
        aria-label="Scroll to top"
        onClick={onTop}
      >
        <svg class="scroll-jump-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 4h14" />
          <path d="M12 20V8m-5 5 5-5 5 5" />
        </svg>
      </button>
      <button
        type="button"
        class={'scroll-jump scroll-to-bottom' + (newMessageBelow ? ' new-message' : '')}
        data-instant-hide={direction === 'up'}
        data-visible={direction === 'down'}
        aria-hidden={direction !== 'down'}
        disabled={direction !== 'down'}
        title={newMessageBelow ? 'New message below' : 'Scroll to bottom'}
        aria-label={newMessageBelow ? 'New message below; scroll to bottom' : 'Scroll to bottom'}
        onClick={onBottom}
      >
        <svg class="scroll-jump-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 20h14" />
          <path d="M12 4v12m-5-5 5 5 5-5" />
        </svg>
      </button>
    </>
  );
}
