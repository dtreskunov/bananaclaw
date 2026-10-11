import { channelType, messagingGroupId } from './state';

const TOOL_STOP_ERRORS: Record<string, string> = {
  not_running: 'This tool is no longer running. Waiting for its latest state.',
  not_active: 'This response is no longer active.',
  unsupported: 'This provider cannot stop individual tools.',
  disconnected: 'Runner disconnected. Reconnect to check this tool.',
  timeout: 'The runner did not confirm the tool stop request. Try again.',
};

export async function sendStopRequest(
  groupId: string,
  threadId: string,
  target: { turnId: string; toolCallId?: string },
  signal: AbortSignal,
): Promise<void> {
  const tool = target.toolCallId !== undefined;
  let url = `api/groups/${encodeURIComponent(groupId)}/chat/${encodeURIComponent(threadId)}/${tool ? 'stop-tool' : 'stop'}`;
  if (channelType.value !== 'web' && messagingGroupId.value) {
    url += `?channel=${encodeURIComponent(channelType.value)}&mg=${encodeURIComponent(messagingGroupId.value)}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
    signal,
  });
  if (response.ok) return;
  let message = `${tool ? 'Tool stop' : 'Stop'} request failed (HTTP ${response.status}).`;
  const detail = await response.text();
  try {
    const body: unknown = JSON.parse(detail);
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      message = (tool && TOOL_STOP_ERRORS[body.error]) || body.error;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Non-JSON error pages are not safe or useful UI messages.
  }
  throw new Error(message);
}
