import './ChatMain.css';
import type { ScrollDirection } from '../scroll-navigation';

interface Props {
  direction: ScrollDirection | null;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function ScrollNavigationButtons({ direction, canPrevious, canNext, onPrevious, onNext }: Props) {
  return (
    <>
      <button
        type="button"
        class="scroll-jump scroll-to-top"
        data-instant-hide={direction === 'down'}
        data-visible={direction === 'up'}
        aria-hidden={direction !== 'up'}
        disabled={direction !== 'up' || !canPrevious}
        title="Previous user message"
        aria-label="Previous user message"
        onClick={onPrevious}
      >
        <svg class="scroll-jump-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 4h14" />
          <path d="M12 20V8m-5 5 5-5 5 5" />
        </svg>
      </button>
      <button
        type="button"
        class="scroll-jump scroll-to-bottom"
        data-instant-hide={direction === 'up'}
        data-visible={direction === 'down'}
        aria-hidden={direction !== 'down'}
        disabled={direction !== 'down' || !canNext}
        title="Next user message"
        aria-label="Next user message"
        onClick={onNext}
      >
        <svg class="scroll-jump-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 20h14" />
          <path d="M12 4v12m-5-5 5 5 5-5" />
        </svg>
      </button>
    </>
  );
}
