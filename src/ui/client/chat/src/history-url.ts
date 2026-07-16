export function buildHistoryUrl(
  groupId: string,
  threadId: string,
  channelType: string,
  messagingGroupId: string | null,
): string {
  let url = `api/groups/${encodeURIComponent(groupId)}/chat/${encodeURIComponent(threadId)}/history`;
  if (!messagingGroupId) return url;

  const params = new URLSearchParams({ channel: channelType, mg: messagingGroupId });
  url += '?' + params.toString();
  return url;
}
