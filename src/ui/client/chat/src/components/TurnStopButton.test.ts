import { describe, expect, it, vi } from 'vitest';
import { TurnStopButton } from './TurnStopButton';

function button(
  options: { status?: 'running' | 'stopping'; busy?: boolean; connected?: boolean; error?: string } = {},
) {
  const onStop = vi.fn();
  const view = TurnStopButton({
    turn: { id: 'immutable-turn', status: options.status ?? 'running' },
    connected: options.connected ?? true,
    busy: options.busy ?? false,
    error: options.error ?? '',
    onStop,
  });
  return { view, onStop };
}

describe('activity bubble Stop control', () => {
  it('uses the shared bubble-action style and shows only a square in every state', () => {
    for (const options of [
      {},
      { busy: true },
      { status: 'stopping' as const },
      { error: 'Retry' },
      { connected: false },
    ]) {
      const { view } = button(options);
      expect(view.props.class).toBe('msg-action-btn turn-stop');
      expect(view.props.children.type).toBe('span');
      expect(view.props.children.props).toEqual({ 'aria-hidden': 'true', children: '\u25A0' });
    }
  });

  it('labels the control accessibly and stops the rendered turn only', () => {
    const { view, onStop } = button();
    expect(view.props['aria-label']).toBe('Stop response');
    expect(view.props.type).toBe('button');
    expect(view.props.disabled).toBe(false);
    expect(view.props.title).toContain('Queued follow-ups will still run');
    view.props.onClick();
    expect(onStop).toHaveBeenCalledWith('immutable-turn');
  });

  it('disables the control while awaiting acceptance or cancellation', () => {
    for (const options of [{ busy: true }, { status: 'stopping' as const }]) {
      const { view } = button(options);
      expect(view.props.disabled).toBe(true);
      expect(view.props['aria-busy']).toBe(true);
      expect(view.props['aria-label']).toBe('Stopping response');
      expect(view.props.title).toContain('Stopping response');
    }
  });

  it('allows retry after failed/unconfirmed cancellation even if host is still stopping', () => {
    const { view } = button({ status: 'stopping', error: 'Not confirmed' });
    expect(view.props.disabled).toBe(false);
    expect(view.props['aria-label']).toBe('Retry stopping response');
    expect(view.props.title).toContain('Retry stopping response');
  });

  it('keeps Stop visible but disabled while disconnected', () => {
    const { view } = button({ connected: false });
    expect(view.props.disabled).toBe(true);
    expect(view.props.title).toContain('Reconnect');
  });
});
