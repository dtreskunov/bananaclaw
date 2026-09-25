import type { ActiveTurn } from '../types';

interface TurnStopButtonProps {
  turn: ActiveTurn;
  connected: boolean;
  busy: boolean;
  error: string;
  onStop: (turnId: string) => void;
}

export function TurnStopButton({ turn, connected, busy, error, onStop }: TurnStopButtonProps) {
  const stopping = !error && (busy || turn.status === 'stopping');
  const label = stopping ? 'Stopping response' : error ? 'Retry stopping response' : 'Stop response';
  return (
    <button
      type="button"
      class="msg-action-btn turn-stop"
      aria-label={label}
      aria-busy={stopping}
      title={
        connected
          ? `${label}. Queued follow-ups will still run; completed actions are not undone.`
          : 'Reconnect to stop this response.'
      }
      disabled={!connected || stopping}
      onClick={() => onStop(turn.id)}
    >
      <span aria-hidden="true">{'\u25A0'}</span>
    </button>
  );
}
