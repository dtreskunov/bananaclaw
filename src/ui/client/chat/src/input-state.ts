import type { InputState } from './types';

export function inputStatePresentation(state?: InputState): { className: string; caption: string } | null {
  if (!state) return null;
  if (state.status === 'applied') return { className: 'input-applied', caption: 'Applied to current turn' };
  if (state.reason) {
    const reason = {
      turn_finished: 'the target turn finished',
      different_conversation: 'the active turn belongs to another conversation',
      unsupported: 'steering is unavailable',
    }[state.reason];
    return {
      className: state.status === 'queued' ? 'input-queued' : 'input-follow-up',
      caption: `${state.status === 'queued' ? 'Queued for follow-up' : 'Handled as follow-up'} — ${reason}`,
    };
  }
  if (state.status === 'queued') return { className: 'input-queued', caption: 'Queued' };
  if (state.status === 'steering') return { className: 'input-steering', caption: 'Waiting to steer' };
  return null;
}
