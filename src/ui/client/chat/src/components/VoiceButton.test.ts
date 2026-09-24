import { describe, expect, it, vi } from 'vitest';
import { VoiceController, type VoicePhase } from '../voice';
import { VoiceButton } from './VoiceButton';

function button(phase: VoicePhase, options: { target?: string; configured?: boolean; disabled?: boolean } = {}) {
  const controller = new VoiceController({
    socket: () => {
      throw new Error('Unexpected connection');
    },
    capture: () => {
      throw new Error('Unexpected capture');
    },
    origin: () => 'https://chat.example',
  });
  controller.state.value = {
    phase,
    target: phase === 'idle' ? null : 'composer',
    elapsedMs: 65_000,
    error: '',
    sending: false,
  };
  const stop = vi.spyOn(controller, 'stop').mockImplementation(() => {});
  const start = vi.fn();
  const view = VoiceButton({
    target: options.target ?? 'composer',
    controller,
    onStart: start,
    configured: options.configured ?? true,
    unavailable: options.configured === false ? 'Missing host key' : '',
    disabled: options.disabled ?? false,
  });
  return { view, stop, start };
}

describe('single dictation control', () => {
  it('starts dictation from the idle microphone', () => {
    const { view, start, stop } = button('idle');
    expect(view.props['aria-label']).toBe('Start dictation');
    expect(view.props.disabled).toBe(false);
    view.props.onClick();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it('replaces the microphone with a stop-labelled stopwatch while listening', () => {
    const { view, start, stop } = button('listening');
    expect(view.props['aria-label']).toBe('Stop dictation');
    expect(view.props.class).toContain('voice-stopwatch');
    const time = view.props.children.props.children[1];
    expect(time.type).toBe('time');
    expect(time.props.children.join('')).toBe('1:05');
    view.props.onClick();
    expect(stop).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps stop available even if sending becomes disabled', () => {
    expect(button('listening', { disabled: true, configured: false }).view.props.disabled).toBe(false);
  });

  it('allows cancelling a pending connection', () => {
    const { view, stop } = button('connecting');
    expect(view.props['aria-label']).toBe('Cancel dictation');
    expect(view.props['aria-busy']).toBe(true);
    view.props.onClick();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('shows a disabled busy indicator during finalization', () => {
    const { view } = button('finalizing');
    expect(view.props['aria-label']).toBe('Finalizing dictation');
    expect(view.props.disabled).toBe(true);
    expect(view.props['aria-busy']).toBe(true);
  });

  it('allows a new recording after an error and retains the unavailable tooltip', () => {
    expect(button('error').view.props.disabled).toBe(false);
    const { view } = button('idle', { configured: false });
    expect(view.props.disabled).toBe(true);
    expect(view.props.title).toBe('Live voice input is not configured');
  });

  it('disables another target microphone during active dictation', () => {
    const { view } = button('listening', { target: 'question' });
    expect(view.props.disabled).toBe(true);
    expect(view.props['aria-label']).toBe('Start dictation');
    expect(view.props.class).not.toContain('voice-stopwatch');
  });
});
