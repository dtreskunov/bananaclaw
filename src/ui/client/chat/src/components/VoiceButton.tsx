import type { VoiceController } from '../voice';

interface VoiceButtonProps {
  target: string;
  controller: VoiceController;
  onStart(): void;
  configured: boolean;
  unavailable: string;
  disabled: boolean;
  id?: string;
  className?: string;
}

export function VoiceButton({ target, controller, onStart, configured, unavailable, disabled, id, className = '' }: VoiceButtonProps) {
  const state = controller.state.value;
  const active = state.target === target;
  const connecting = active && state.phase === 'connecting';
  const listening = active && state.phase === 'listening';
  const finalizing = active && state.phase === 'finalizing';
  const label = connecting ? 'Cancel dictation' : listening ? 'Stop dictation' : finalizing ? 'Finalizing dictation' : 'Start dictation';
  const blocked = state.sending || finalizing || (!(connecting || listening)
    && (disabled || !configured || !!unavailable || !['idle', 'error'].includes(state.phase)));
  const seconds = Math.floor(state.elapsedMs / 1000);
  return (
    <button
      type="button"
      id={id}
      class={`mic-overlay ${className}${listening ? ' voice-stopwatch' : ''}`}
      title={connecting || listening || finalizing ? label : !configured ? 'Live voice input is not configured' : unavailable || label}
      aria-label={label}
      aria-busy={connecting || finalizing}
      disabled={blocked}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { if (connecting || listening) controller.stop(); else onStart(); }}
    >
      {listening ? <>
        <span class="voice-recording-dot" aria-hidden="true" />
        <time aria-hidden="true">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time>
      </> : connecting || finalizing ? <span class="voice-spinner" aria-hidden="true" /> : '\uD83C\uDF99\uFE0F'}
    </button>
  );
}
