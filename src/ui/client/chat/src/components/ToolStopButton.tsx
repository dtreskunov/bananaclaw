import { activeTurn, canSend, turnConnected } from '../state';
import { stopActiveTool, toolStopRequest } from '../stop-tool';
import { StopIcon } from './ActionIcons';

export function ToolStopButton({ turnId, toolCallId }: { turnId: string; toolCallId: string }) {
  if (!canSend.value) return null;
  const turn = activeTurn.value;
  const request = toolStopRequest(turnId, toolCallId);
  const supported = turn?.id === turnId && turn.supportsToolCancellation === true;
  let label = 'Stop tool';
  if (request?.busy) label = 'Stopping tool';
  else if (request?.error) label = 'Retry stopping tool';
  let title =
    'Stop only this tool call. The response and other tools will continue; completed side effects are not undone.';
  if (!supported) title = 'This provider cannot stop individual tools.';
  else if (!turnConnected.value) title = 'Reconnect to stop this tool.';
  else if (request?.error) title = request.error;
  else if (request?.busy) title = 'Stopping this tool call. The response and other tools will continue.';
  return (
    <button
      type="button"
      class="msg-action-btn tool-stop"
      aria-label={label}
      aria-busy={request?.busy ?? false}
      title={title}
      disabled={!supported || !turnConnected.value || turn?.status !== 'running' || !!request?.busy}
      onClick={() => {
        void stopActiveTool(turnId, toolCallId);
      }}
    >
      <StopIcon />
    </button>
  );
}
