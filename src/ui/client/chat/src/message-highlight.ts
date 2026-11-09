interface HighlightTarget {
  classList: Pick<DOMTokenList, 'add' | 'remove' | 'contains'>;
  getBoundingClientRect(): unknown;
}

const timers = new WeakMap<HighlightTarget, ReturnType<typeof setTimeout>>();

export function highlightMessage(target: HighlightTarget): void {
  clearTimeout(timers.get(target));
  if (target.classList.contains('highlight-pulse')) {
    target.classList.remove('highlight-pulse');
    // Flush the old animation so repeated jumps restart the pulse.
    target.getBoundingClientRect();
  }
  target.classList.add('highlight-pulse');
  timers.set(
    target,
    setTimeout(() => {
      target.classList.remove('highlight-pulse');
      timers.delete(target);
    }, 2000),
  );
}
