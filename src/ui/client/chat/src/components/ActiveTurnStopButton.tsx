import { activeTurn, canSend, stopRequest, turnConnected } from '../state';
import { stopActiveTurn } from '../stop-turn';
import { TurnStopButton } from './TurnStopButton';

/** Bind Stop to the live turn, never to the latest inbound or pending send. */
export function ActiveTurnStopButton() {
  const turn = activeTurn.value;
  if (!turn || !canSend.value) return null;
  const stop = stopRequest.value?.turnId === turn.id ? stopRequest.value : null;
  return (
    <TurnStopButton
      turn={turn}
      connected={turnConnected.value}
      busy={stop?.busy ?? false}
      error={stop?.error ?? ''}
      onStop={(id) => {
        void stopActiveTurn(id);
      }}
    />
  );
}
