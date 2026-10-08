import type { ActiveTurn } from '../types';
import { StopIcon } from './ActionIcons';

interface TurnStopButtonProps {
  turn: ActiveTurn | null;
  connected: boolean;
  busy: boolean;
  error: string;
  onStop: (turnId: string) => void;
}

export function TurnStopButton({ turn, connected, busy, error, onStop }: TurnStopButtonProps) {
  const stopping = !error && (busy || turn?.status === 'stopping');
  const label = stopping ? 'Stopping response' : error ? 'Retry stopping response' : 'Stop response';
  let title = 'Reconnect to stop this response.';
  if (!turn) title = 'Available once the response starts.';
  else if (connected) title = `${label}. Queued follow-ups will still run, including steering not yet applied; completed actions are not undone.`;
  return (
    <button
      type="button"
      class="msg-action-btn turn-stop"
      aria-label={label}
      aria-busy={stopping}
      title={title}
      disabled={!turn || !connected || stopping}
      onClick={turn ? () => onStop(turn.id) : undefined}
    >
      <StopIcon />
    </button>
  );
}
