import { activeTurn, canSend, stopRequest, turnConnected } from '../state';
import { stopActiveTurn } from '../stop-turn';
import { TurnStopButton } from './TurnStopButton';

/** Bind Stop only to the live turn displayed by this response row. */
export function ActiveTurnStopButton({ turnId }: { turnId: string | null }) {
  const active = activeTurn.value;
  const turn = active?.id === turnId ? active : null;
  if (!canSend.value) return null;
  const stop = stopRequest.value?.turnId === turn?.id ? stopRequest.value : null;
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
