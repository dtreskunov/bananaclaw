export interface MessagePreviewLayout {
  truncated: boolean;
  height: number;
}

export function messagePreviewLayout(
  contentHeight: number,
  availableHeight: number,
  chromeHeight: number,
  controlHeight: number,
): MessagePreviewLayout {
  const truncated = availableHeight > 0 && contentHeight + chromeHeight > availableHeight + 0.5;
  return {
    truncated,
    height: truncated ? Math.max(0, availableHeight - chromeHeight - controlHeight) : contentHeight,
  };
}

export function observeMessagePreview(
  preview: Pick<HTMLElement, 'closest' | 'querySelector'>,
  update: (layout: MessagePreviewLayout) => void,
): () => void {
  const viewport = preview.closest<HTMLElement>('.log');
  const bubble = preview.closest<HTMLElement>('.msg');
  const content = preview.querySelector<HTMLElement>('.message-preview-content');
  const clip = preview.querySelector<HTMLElement>('.message-preview-clip');
  const control = preview.querySelector<HTMLElement>('.message-preview-control');
  if (!viewport || !bubble || !content || !clip || !control) {
    throw new Error('Message preview is missing its transcript, bubble, or content.');
  }
  const measure = (): void => {
    const style = getComputedStyle(viewport);
    const edgeSpace = parseFloat(getComputedStyle(viewport, '::before').height) + parseFloat(style.rowGap);
    const available =
      viewport.getBoundingClientRect().height -
      2 * edgeSpace -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    const controlHeight = control.getBoundingClientRect().height;
    const chrome = bubble.getBoundingClientRect().height - clip.getBoundingClientRect().height - controlHeight;
    update(messagePreviewLayout(content.getBoundingClientRect().height, available, chrome, controlHeight));
  };
  const observer = new ResizeObserver(measure);
  for (const element of [viewport, bubble, content, control]) observer.observe(element);
  measure();
  return () => observer.disconnect();
}
