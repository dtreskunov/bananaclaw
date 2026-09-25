/** Explicit web submission intent; acceptance does not mean steering was applied. */
export interface InputHandling {
  mode: 'queue' | 'steer';
  turnId?: string;
}

export interface InputState {
  messageId: string;
  status: 'queued' | 'steering' | 'applied' | 'processing';
  turnId?: string;
  reason?: 'turn_finished' | 'different_conversation' | 'unsupported';
}

export function parseInputState(value: unknown): InputState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.messageId !== 'string' ||
    !v.messageId ||
    !['queued', 'steering', 'applied', 'processing'].includes(String(v.status))
  )
    return undefined;
  if (v.turnId !== undefined && typeof v.turnId !== 'string') return undefined;
  if (v.reason !== undefined && !['turn_finished', 'different_conversation', 'unsupported'].includes(String(v.reason)))
    return undefined;
  return {
    messageId: v.messageId,
    status: v.status as InputState['status'],
    ...(typeof v.turnId === 'string' ? { turnId: v.turnId } : {}),
    ...(v.reason ? { reason: v.reason as InputState['reason'] } : {}),
  };
}
