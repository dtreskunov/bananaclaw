export function fitVisualViewport(
  viewport: (EventTarget & { readonly height: number }) | null,
  style: Pick<CSSStyleDeclaration, 'setProperty'>,
): () => void {
  if (!viewport) return () => {};
  const apply = (): void => style.setProperty('--app-height', `${viewport.height}px`);
  apply();
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
  };
}
