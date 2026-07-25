/**
 * Normalize a launcher fragment for forwarding into a private web app.
 *
 * The `/ui/view/...` launcher is the only stable, bookmarkable entry point for a
 * private application, but the `secure-*` redeem redirect only carries the
 * target path — a query string on the launcher URL never reaches the app. A
 * fragment does survive the redirect, so the launcher forwards its own fragment
 * to give applications a deep-link input channel.
 */
export function forwardedFragment(hash: string | null | undefined): string {
  if (!hash) return '';
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return cleaned ? `#${cleaned}` : '';
}
