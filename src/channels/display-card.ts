export type DisplayCardActionStyle = 'primary' | 'danger' | 'default';

export interface DisplayCardAction {
  label: string;
  url: string;
  style?: DisplayCardActionStyle;
}

export interface DisplayCard {
  title: string;
  description: string;
  children: string[];
  actions: DisplayCardAction[];
}

export interface DisplayCardPayload {
  card: DisplayCard | null;
  fallbackText: string;
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function safeActionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

export function normalizeDisplayCardPayload(content: unknown): DisplayCardPayload | null {
  if (!content || typeof content !== 'object') return null;
  const payload = content as Record<string, unknown>;
  if (payload.type !== 'card' || !payload.card || typeof payload.card !== 'object') return null;

  const input = payload.card as Record<string, unknown>;
  const title = nonEmptyString(input.title);
  const description = nonEmptyString(input.description);
  const children = Array.isArray(input.children)
    ? input.children
        .map((child) => {
          if (typeof child === 'string') return nonEmptyString(child);
          if (child && typeof child === 'object') {
            return nonEmptyString((child as Record<string, unknown>).text);
          }
          return '';
        })
        .filter(Boolean)
    : [];
  const actions: DisplayCardAction[] = Array.isArray(input.actions)
    ? input.actions.flatMap((action) => {
        if (!action || typeof action !== 'object') return [];
        const spec = action as Record<string, unknown>;
        const label = nonEmptyString(spec.label);
        const url = safeActionUrl(spec.url);
        if (!label || !url) return [];
        const style = spec.style;
        return [
          {
            label,
            url,
            ...(style === 'primary' || style === 'danger' || style === 'default' ? { style } : {}),
          },
        ];
      })
    : [];

  const fallbackText = nonEmptyString(payload.fallbackText) || description || title;
  const card =
    title || description || children.length > 0 || actions.length > 0
      ? { title, description, children, actions }
      : null;
  return { card, fallbackText };
}
