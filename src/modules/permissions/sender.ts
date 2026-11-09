export function parseSender(raw: string): { handle: string | null; name: string | null } | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (!content || typeof content !== 'object') return null;
  const author =
    content.author && typeof content.author === 'object' ? (content.author as Record<string, unknown>) : {};
  const handle = [content.senderId, content.sender, author.userId].find((value) => typeof value === 'string') ?? null;
  const name =
    [content.senderName, author.fullName, author.userName, content.sender].find((value) => typeof value === 'string') ??
    null;
  return { handle, name };
}
