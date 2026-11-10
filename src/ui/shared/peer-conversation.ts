export function peerConversationId(sessionId: string, threadId: string): string {
  if (!sessionId || !threadId) throw new Error('Peer conversations require a session and exchange identity');
  return `__agent:${sessionId}/${encodeURIComponent(threadId)}`;
}

export function parsePeerConversationId(id: string): { sessionId: string; threadId: string } | null {
  if (!id.startsWith('__agent:')) return null;
  const [sessionId, encoded, ...extra] = id.slice('__agent:'.length).split('/');
  if (!sessionId || extra.length || !encoded) return null;
  try {
    return { sessionId, threadId: decodeURIComponent(encoded) };
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}
